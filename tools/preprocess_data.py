#!/usr/bin/env python3
"""Build the packaged Jezero dataset from the original HiRISE archive files.

Build-time only: the running application never needs Python or GDAL.

What it does
  1. Parses the DTM's attached PDS3 label and checks the properties ARES relies on.
  2. Hashes the complete source files (a source that is incomplete is recorded
     as NOT verified — the app then refuses to call the data real).
  3. Cuts the region of interest out of the DTM *without resampling*: the output
     cells are the product's own pixels, bit for bit.
  4. Reads the same region two independent ways (GDAL via rasterio, and raw
     bytes located from the label) and requires them to be identical.
  5. Cuts the same pixel window from the 1 m orthoimage, after checking that
     its label describes exactly the same grid as the DTM.
  6. Measures image-to-terrain registration empirically.
  7. Writes elevation.bin, ortho.png, manifest.json and validation_samples.json.

Run (from the repository root):
  tools/.venv/bin/python -I tools/preprocess_data.py \
      --dtm datasets/_source/dtm/DTEEC_023524_1985_023379_1985_U01.IMG \
      --ortho datasets/_source/ortho/ESP_023524_1985_RED_C_01_ORTHO.JP2 \
      --ortho-label datasets/_source/ortho/ESP_023524_1985_RED_C_01_ORTHO.LBL \
      --retrieved-utc "$(cat datasets/_source/retrieved_utc.txt)" \
      --out datasets/jezero-small
"""

from __future__ import annotations

import argparse
import datetime as dt
import hashlib
import json
import math
import re
import sys
from pathlib import Path

import numpy as np
import rasterio
from PIL import Image
from rasterio.windows import Window

ARCHIVE_DIR = (
    "https://www.uahirise.org/PDS/DTM/ESP/ORB_023500_023599/"
    "ESP_023524_1985_ESP_023379_1985/"
)
DTM_PRODUCT_PAGE = "https://www.uahirise.org/dtm/ESP_023524_1985"
CREDIT = (
    "Credit: NASA/JPL-Caltech/UArizona. The HiRISE site states that its images are in the "
    "public domain and asks for this credit line where possible "
    "(https://www.uahirise.org/ESP_023524_1985, retrieved 2026-11-14). "
    "PDS data set MRO-M-HIRISE-5-DTM-V1.0."
)
# Acquisition dates as shown on the HiRISE observation pages (retrieved 2026-11-14):
# https://www.uahirise.org/ESP_023524_1985 and https://www.uahirise.org/ESP_023379_1985
ACQUIRED = {"ESP_023524_1985": "2011-08-03", "ESP_023379_1985": "2011-07-23"}
SIS = "HiRISE RDR Software Interface Specification, JPL D-32006 v1.3, section 3.5.1"

# Region of interest in 0-based source pixels: light-toned mounds on the crater floor.
DEFAULT_COL0, DEFAULT_ROW0, DEFAULT_SIZE = 1500, 2000, 2048


def fail(message: str) -> "None":
    print(f"ERROR: {message}", file=sys.stderr)
    sys.exit(1)


def parse_pds3_label(text: str) -> dict[str, str]:
    """Flat KEY -> value map of a PDS3 label. Units in <...> are stripped."""
    values: dict[str, str] = {}
    key = None
    for raw in text.splitlines():
        line = raw.strip()
        if line == "END":
            break
        if line.startswith("/*") or not line:
            continue
        m = re.match(r"^(\^?[A-Z][A-Z0-9_]*)\s*=\s*(.*)$", line)
        if m:
            key, value = m.group(1), m.group(2).strip()
            # OBJECT/END_OBJECT only delimit groups; keys are unique where it matters.
            if key in ("OBJECT", "END_OBJECT"):
                key = None
                continue
            values[key] = value
        elif key is not None:
            values[key] += " " + line  # continuation of a multi-line value
    cleaned = {}
    for k, v in values.items():
        v = re.sub(r"\s*<[^>]*>\s*$", "", v).strip()
        if len(v) >= 2 and v[0] == '"' and v[-1] == '"':
            v = re.sub(r"\s+", " ", v[1:-1]).strip()
        cleaned[k] = v
    return cleaned


def read_attached_label(path: Path) -> dict[str, str]:
    with path.open("rb") as f:
        head = f.read(65536).decode("latin-1")
    return parse_pds3_label(head)


def sha256_file(path: Path) -> str:
    h = hashlib.sha256()
    with path.open("rb") as f:
        for chunk in iter(lambda: f.read(1 << 22), b""):
            h.update(chunk)
    return h.hexdigest()


def projection_of(label: dict[str, str]) -> dict:
    """The grid description shared by the DTM and its orthoimages."""
    return {
        "type": label["MAP_PROJECTION_TYPE"],
        "radius_m": float(label["A_AXIS_RADIUS"]) * 1000.0,
        "b_radius_m": float(label["B_AXIS_RADIUS"]) * 1000.0,
        "c_radius_m": float(label["C_AXIS_RADIUS"]) * 1000.0,
        "center_lat": float(label["CENTER_LATITUDE"]),
        "center_lon": float(label["CENTER_LONGITUDE"]),
        "map_scale": float(label["MAP_SCALE"]),
        "line_offset": float(label["LINE_PROJECTION_OFFSET"]),
        "sample_offset": float(label["SAMPLE_PROJECTION_OFFSET"]),
        "lines": int(label["LINE_LAST_PIXEL"]),
        "samples": int(label["SAMPLE_LAST_PIXEL"]),
        "rotation": float(label["MAP_PROJECTION_ROTATION"]),
        "lat_type": label["PROJECTION_LATITUDE_TYPE"],
        "lon_dir": label["POSITIVE_LONGITUDE_DIRECTION"],
        "north_azimuth": float(label["NORTH_AZIMUTH"]),
    }


class Grid:
    """HiRISE equirectangular grid.

    Pixel centres follow the HiRISE RDR SIS (JPL D-32006 v1.3, section 3.5.1), where the
    offsets are "the respective image coordinate displacements from pixel (1,1) to the
    origin of the projection":
        x = (Sample − S0 − 1)·Scale        y = (1 + L0 − Line)·Scale
    with 1-based Sample and Line. The SIS writes y with a negative L0; this DTM label
    stores L0 as a positive number for a northern image, which the label's own
    MAXIMUM_LATITUDE confirms (the other sign would put the image at 18.5° S).
    """

    def __init__(self, p: dict):
        self.p = p

    def edge_x(self, col0: float) -> float:
        """Projected easting of the west edge of 0-based column `col0`."""
        return (col0 - 0.5 - self.p["sample_offset"]) * self.p["map_scale"]

    def edge_y(self, row0: float) -> float:
        """Projected northing of the north edge of 0-based row `row0`."""
        return (self.p["line_offset"] + 0.5 - row0) * self.p["map_scale"]

    def lat(self, y: float) -> float:
        return math.degrees(y / self.p["radius_m"])

    def lon(self, x: float) -> float:
        scale = self.p["radius_m"] * math.cos(math.radians(self.p["center_lat"]))
        return (self.p["center_lon"] + math.degrees(x / scale)) % 360.0

    def center_latlon(self, col: float, row: float) -> tuple[float, float]:
        return (
            self.lat(self.edge_y(row) - 0.5 * self.p["map_scale"]),
            self.lon(self.edge_x(col) + 0.5 * self.p["map_scale"]),
        )


def registration_check(elev: np.ndarray, ortho: np.ndarray, valid: np.ndarray) -> dict:
    """How well image brightness is explained by terrain gradient at small shifts.

    Shaded brightness is, to first order, linear in the surface gradient. Fitting
    DN ≈ a + b·∂z/∂x + c·∂z/∂y at each trial offset gives an R²; the offset with
    the highest R² is the empirical image-to-terrain misregistration.
    """

    def smooth(a: np.ndarray, k: int = 4) -> np.ndarray:
        h, w = (a.shape[0] // k) * k, (a.shape[1] // k) * k
        return a[:h, :w].reshape(h // k, k, w // k, k).mean(axis=(1, 3))

    z = np.where(valid, elev, np.nan).astype(np.float64)
    gy, gx = np.gradient(z)
    img = ortho.astype(np.float64)
    reach = 6
    best = (-1.0, 0, 0)
    table = {}
    for dy in range(-reach, reach + 1):
        for dx in range(-reach, reach + 1):
            core = (slice(reach, -reach), slice(reach, -reach))
            shifted = img[reach + dy : img.shape[0] - reach + dy, reach + dx : img.shape[1] - reach + dx]
            a, b, c = smooth(gx[core]), smooth(gy[core]), smooth(shifted)
            ok = np.isfinite(a) & np.isfinite(b) & (c > 0)
            design = np.column_stack([np.ones(ok.sum()), a[ok], b[ok]])
            coef, *_ = np.linalg.lstsq(design, c[ok], rcond=None)
            resid = c[ok] - design @ coef
            r2 = 1.0 - resid.var() / c[ok].var()
            table[(dx, dy)] = r2
            if r2 > best[0]:
                best = (r2, dx, dy)
    return {
        "best_shift_px": [best[1], best[2]],
        "best_r2": round(best[0], 4),
        "r2_at_zero_shift": round(table[(0, 0)], 4),
        "r2_at_search_edge": round(max(v for (dx, dy), v in table.items() if max(abs(dx), abs(dy)) == reach), 4),
        "search_radius_px": reach,
    }


def main() -> None:
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("--dtm", type=Path, required=True)
    ap.add_argument("--ortho", type=Path, required=True)
    ap.add_argument("--ortho-label", type=Path, required=True)
    ap.add_argument("--retrieved-utc", required=True, help="UTC time the source files were downloaded")
    ap.add_argument("--out", type=Path, required=True)
    ap.add_argument("--col0", type=int, default=DEFAULT_COL0)
    ap.add_argument("--row0", type=int, default=DEFAULT_ROW0)
    ap.add_argument("--size", type=int, default=DEFAULT_SIZE)
    args = ap.parse_args()
    col0, row0, size = args.col0, args.row0, args.size

    # ---- 1. DTM label ------------------------------------------------------
    label = read_attached_label(args.dtm)
    proj = projection_of(label)
    record_bytes, file_records = int(label["RECORD_BYTES"]), int(label["FILE_RECORDS"])
    image_record = int(label["^IMAGE"])
    lines, samples = int(label["LINES"]), int(label["LINE_SAMPLES"])
    checks = {
        "projection is EQUIRECTANGULAR": proj["type"] == "EQUIRECTANGULAR",
        "sphere (all three radii equal)": proj["radius_m"] == proj["b_radius_m"] == proj["c_radius_m"],
        "planetocentric latitude": proj["lat_type"] == "PLANETOCENTRIC",
        "positive-east longitude": proj["lon_dir"] == "EAST",
        "north up, no rotation": proj["north_azimuth"] == 270.0 and proj["rotation"] == 0.0,
        "32-bit little-endian real samples": label["SAMPLE_TYPE"] == "PC_REAL" and label["SAMPLE_BITS"] == "32",
        "record = one image line": record_bytes == samples * 4,
        "values are metres (scale 1, offset 0)": float(label["SCALING_FACTOR"]) == 1.0 and float(label["OFFSET"]) == 0.0,
        "label grid matches image size": (proj["lines"], proj["samples"]) == (lines, samples),
        "region inside the image": 0 <= col0 and col0 + size <= samples and 0 <= row0 and row0 + size <= lines,
    }
    for name, ok in checks.items():
        print(f"  [{'ok' if ok else 'FAIL'}] {name}")
    if not all(checks.values()):
        fail("the DTM label does not have the properties this pipeline supports (UnsupportedProjection / DataAlignmentFailure)")

    missing_hex = re.match(r"16#([0-9A-Fa-f]{8})#", label["MISSING_CONSTANT"])
    if not missing_hex:
        fail("MissingNoDataMetadata: DTM label has no usable MISSING_CONSTANT")
    nodata = np.frombuffer(bytes.fromhex(missing_hex.group(1)), dtype=">u4").astype("<u4").view("<f4")[0]
    image_offset = (image_record - 1) * record_bytes
    grid = Grid(proj)

    # ---- 2. Source completeness and hashes ---------------------------------
    expected_bytes = record_bytes * file_records
    actual_bytes = args.dtm.stat().st_size
    dtm_complete = actual_bytes == expected_bytes
    quality_dtm: list[str] = []
    if dtm_complete:
        dtm_sha = sha256_file(args.dtm)
        print(f"  source DTM complete: {actual_bytes} bytes, sha256 {dtm_sha}")
    else:
        dtm_sha = None
        note = f"SOURCE NOT VERIFIED: source file has {actual_bytes} of {expected_bytes} bytes declared by its label."
        quality_dtm.append(note)
        print("  WARNING " + note)
    if actual_bytes < image_offset + (row0 + size) * record_bytes:
        fail("the source DTM does not yet contain the requested rows")
    ortho_sha = sha256_file(args.ortho)
    ortho_label_sha = sha256_file(args.ortho_label)

    # ---- 3 + 4. Region of interest, read two independent ways ---------------
    raw = np.memmap(args.dtm, dtype="<f4", mode="r", offset=image_offset + row0 * record_bytes, shape=(size, samples))
    elev = np.array(raw[:, col0 : col0 + size], dtype="<f4")
    with rasterio.open(args.dtm) as ds:
        if (ds.width, ds.height) != (samples, lines):
            fail("GDAL and the label disagree about the DTM dimensions (DataAlignmentFailure)")
        gdal_elev = ds.read(1, window=Window(col0, row0, size, size))
        gdal_transform = ds.transform
        gdal_nodata = ds.nodata
    if not np.array_equal(elev.view("<u4"), gdal_elev.astype("<f4").view("<u4")):
        fail("raw read and GDAL read of the region differ (DataAlignmentFailure)")
    print("  raw-byte read and GDAL read of the region are bit-identical")

    valid = elev != nodata
    valid_min, valid_max = float(label["VALID_MINIMUM"]), float(label["VALID_MAXIMUM"])
    roi_min, roi_max = float(elev[valid].min()), float(elev[valid].max())
    if roi_min < valid_min - 0.01 or roi_max > valid_max + 0.01:
        fail(f"region elevations {roi_min}..{roi_max} fall outside the label's valid range {valid_min}..{valid_max}")

    # Georeferencing of the region. Ground cell width follows from the projection:
    # it is true-scale only at CENTER_LATITUDE.
    scale = proj["map_scale"]
    roi_x_min, roi_y_max = grid.edge_x(col0), grid.edge_y(row0)
    lat_n, lat_s = grid.lat(roi_y_max), grid.lat(roi_y_max - size * scale)
    lon_w, lon_e = grid.lon(roi_x_min), grid.lon(roi_x_min + size * scale)
    lat_c = math.radians(0.5 * (lat_n + lat_s))
    cell_x = scale * math.cos(lat_c) / math.cos(math.radians(proj["center_lat"]))
    cell_y = scale

    # Compare our reading of the label with the label's own stated extent and with GDAL.
    lat_first, lon_first = grid.center_latlon(0, 0)
    lat_last, lon_last = grid.center_latlon(samples - 1, lines - 1)
    px_per_deg_lat = 1.0 / math.degrees(scale / proj["radius_m"])
    px_per_deg_lon = px_per_deg_lat * math.cos(math.radians(proj["center_lat"]))
    extent_offsets_px = {
        "north": (lat_first - float(label["MAXIMUM_LATITUDE"])) * px_per_deg_lat,
        "south": (lat_last - float(label["MINIMUM_LATITUDE"])) * px_per_deg_lat,
        "west": (lon_first - float(label["WESTERNMOST_LONGITUDE"])) * px_per_deg_lon,
        "east": (lon_last - float(label["EASTERNMOST_LONGITUDE"])) * px_per_deg_lon,
    }
    # Registration tolerance: the label's rounded extent keywords, the SIS formula and the
    # GeoJP2 header of the orthoimage are three encodings of this grid that agree only to
    # about 2 px. 2.5 px (≈ 2.5 m) is well inside one 4 m planning cell.
    worst_extent = max(abs(v) for v in extent_offsets_px.values())
    if worst_extent > 2.5:
        fail(f"label extent and computed extent differ by {worst_extent:.2f} px (> 2.5 px): DataAlignmentFailure")
    gdal_dx_px = (gdal_transform.c - grid.edge_x(0)) / scale
    gdal_dy_px = (gdal_transform.f - grid.edge_y(0)) / scale
    quality_dtm += [
        "Region lies entirely inside DTM coverage: %d of %d cells are no-data." % (int((~valid).sum()), size * size),
        f"Pixel-to-map convention: {SIS}. Independent reader check: GDAL %s (PDS driver) places the grid origin "
        "%+.3f px east and %+.3f px north of the origin computed here from the label." % (rasterio.__gdal_version__, gdal_dx_px, gdal_dy_px),
        "Georeferencing check against the label's own extent keywords: first/last pixel-centre coordinates computed "
        "from the projection keywords differ from MAXIMUM/MINIMUM_LATITUDE and EASTERNMOST/WESTERNMOST_LONGITUDE by "
        + ", ".join(f"{k} {v:+.2f} px" for k, v in extent_offsets_px.items())
        + " (1 px ≈ 1 m). Recorded as the empirical positional offset: up to %.1f m, inside one 4 m planning cell." % worst_extent,
        "Elevation values of the region were read by GDAL and by raw byte offsets from the label; both are bit-identical.",
        "Producer's stated quality (https://www.uahirise.org/dtm/about.php, retrieved 2026-11-14): DTM post spacing is "
        "about 4 times the pixel scale of the input images, 'so the post spacing is 1-2 m' with 'vertical precision in "
        "the tens of centimeters'; the result 'is tied to the global elevation map produced by the MOLA instrument "
        "team'. The page does not state horizontal accuracy. Hazards smaller than the post spacing are not represented.",
        "Projection radius is the Mars ellipsoid radius at 15° N (per the label); the true planetary radius at this "
        "site differs by roughly 0.1 %, which mis-states horizontal distances by the same fraction.",
    ]
    if abs(gdal_dx_px) > 0.01 or abs(gdal_dy_px) > 0.01:
        fail("GDAL georeferencing differs from the SIS convention used here (DataAlignmentFailure)")
    if gdal_nodata is not None and np.float32(gdal_nodata) != nodata:
        fail("GDAL and the label disagree about the no-data value")

    # ---- 5. Orthoimage on the identical grid --------------------------------
    ortho_label = parse_pds3_label(args.ortho_label.read_text(encoding="latin-1"))
    ortho_proj = projection_of(ortho_label)
    if ortho_proj != proj:
        diffs = {k: (proj[k], ortho_proj[k]) for k in proj if proj[k] != ortho_proj[k]}
        fail(f"orthoimage grid differs from the DTM grid: {diffs} (DataAlignmentFailure)")
    with rasterio.open(args.ortho) as ds:
        if (ds.width, ds.height) != (samples, lines) or ds.dtypes[0] != "uint8":
            fail("orthoimage raster does not match its label (DataAlignmentFailure)")
        ortho = ds.read(1, window=Window(col0, row0, size, size))
    ortho_null = int(ortho_label["CORE_NULL"])

    # ---- 6. Registration -----------------------------------------------------
    reg = registration_check(elev, ortho, valid & (ortho != ortho_null))
    print(f"  registration: {reg}")
    quality_ortho = [
        "The orthoimage label declares exactly the same projection, scale, offsets and dimensions as the DTM "
        "(it was orthorectified onto this DTM by the producer), so the same pixel window is cut from both.",
        "Empirical registration: brightness regressed on DTM gradient peaks at a shift of (%d, %d) px "
        "(R² %.3f; %.3f at zero shift; best at the ±%d px search edge %.3f)."
        % (*reg["best_shift_px"], reg["best_r2"], reg["r2_at_zero_shift"], reg["search_radius_px"], reg["r2_at_search_edge"]),
        "Pixel values are the product's 8-bit DN, unchanged. I/F = DN × %s + %s per the label. DN %d = null."
        % (ortho_label["SCALING_FACTOR"], ortho_label["OFFSET"], ortho_null),
        "Imagery shows brightness only. It is not a source of heights, slopes or composition.",
    ]

    # ---- 7. Write -------------------------------------------------------------
    args.out.mkdir(parents=True, exist_ok=True)
    elev_path, ortho_path = args.out / "elevation.bin", args.out / "ortho.png"
    elev.tofile(elev_path)
    Image.fromarray(ortho, mode="L").save(ortho_path, optimize=True)

    proj4 = (
        f"+proj=eqc +lat_ts={proj['center_lat']} +lat_0=0 +lon_0={proj['center_lon']} "
        f"+x_0=0 +y_0=0 +R={proj['radius_m']} +units=m +no_defs"
    )
    out_crs = (
        "Source pixels unchanged (no resampling). Local frame: origin at the region's south-west corner, "
        f"x east, y north, metres; one cell = {cell_x:.6f} m (east-west) × {cell_y:.6f} m (north-south) on the ground."
    )
    bbox_original = {
        "lat_min": float(label["MINIMUM_LATITUDE"]),
        "lat_max": float(label["MAXIMUM_LATITUDE"]),
        "lon_east_min": float(label["WESTERNMOST_LONGITUDE"]),
        "lon_east_max": float(label["EASTERNMOST_LONGITUDE"]),
    }
    bbox_projected = [roi_x_min, roi_y_max - size * scale, roi_x_min + size * scale, roi_y_max]
    window = f"columns {col0}–{col0 + size - 1}, lines {row0}–{row0 + size - 1} (0-based)"
    verified = dtm_complete

    def layer(**kw):
        base = {
            "provider": "NASA/JPL-Caltech/University of Arizona",
            "instrument": "MRO HiRISE (High Resolution Imaging Science Experiment)",
            "license_and_credit": CREDIT,
            "retrieved_utc": args.retrieved_utc,
            "source_crs": proj4,
            "output_crs": out_crs,
            "pixel_size_m": [cell_x, cell_y],
            "bbox_original": bbox_original,
            "bbox_projected_m": bbox_projected,
            "is_real_source_verified": verified,
        }
        base.update(kw)
        return base

    manifest = {
        "schema_version": 1,
        "dataset_id": "jezero-small",
        "display_name": "Jezero floor mounds (HiRISE)",
        "body": "Mars",
        "region_name": "Jezero Crater floor, east of the western delta",
        "generated_utc": dt.datetime.now(dt.timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ"),
        "georeference": {
            "projection": proj["type"],
            "radius_m": proj["radius_m"],
            "center_latitude_deg": proj["center_lat"],
            "center_longitude_deg": proj["center_lon"],
            "map_scale_m_per_px": scale,
            "roi_x_min_m": roi_x_min,
            "roi_y_max_m": roi_y_max,
            "width": size,
            "height": size,
            "cell_size_x_m": cell_x,
            "cell_size_y_m": cell_y,
        },
        "roi_bbox": {"lat_min": lat_s, "lat_max": lat_n, "lon_east_min": lon_w, "lon_east_max": lon_e},
        "layers": [
            layer(
                id="hirise-jezero-dtm",
                display_name="HiRISE stereo DTM",
                kind="ELEVATION",
                file=elev_path.name,
                origin_type="DERIVED",
                observation_date="Stereo pair acquired %s (ESP_023524_1985) and %s (ESP_023379_1985)"
                % (ACQUIRED["ESP_023524_1985"], ACQUIRED["ESP_023379_1985"]),
                product_id=label["PRODUCT_ID"],
                source_url=ARCHIVE_DIR + args.dtm.name,
                vertical_datum="Metres above the Mars equipotential surface (Mars 2000 datum, MOLA areoid; "
                "Smith et al. 2001), per the product label.",
                nodata_value=float(nodata),
                sha256_source=dtm_sha,
                sha256_derived=sha256_file(elev_path),
                processing_steps=[
                    f"Downloaded {args.dtm.name} from the HiRISE PDS archive ({DTM_PRODUCT_PAGE}).",
                    "Parsed the attached PDS3 label; verified projection, sample type, scale/offset and no-data constant.",
                    f"Located pixels in the projection with the equations of the {SIS}.",
                    f"Extracted {window} with no resampling, scaling or filtering.",
                    "Wrote little-endian 32-bit floats, row-major, north to south; no-data cells keep the label's MISSING_CONSTANT.",
                ],
                quality_notes=[
                    "DERIVED product: elevations were computed by the producer from the HiRISE stereo pair "
                    + label["SOURCE_PRODUCT_ID"].strip("()")
                    + " by photogrammetry ("
                    + label["SOFTWARE_NAME"]
                    + "); they are not direct in-situ measurements."
                ]
                + quality_dtm,
            ),
            layer(
                id="hirise-jezero-ortho",
                display_name="HiRISE orthoimage (red, 1 m)",
                kind="IMAGERY",
                file=ortho_path.name,
                origin_type="OBSERVED",
                observation_date=ACQUIRED["ESP_023524_1985"],
                product_id=ortho_label["PRODUCT_ID"],
                source_url=ARCHIVE_DIR + args.ortho.name,
                vertical_datum=None,
                nodata_value=float(ortho_null),
                sha256_source=ortho_sha,
                sha256_derived=sha256_file(ortho_path),
                processing_steps=[
                    f"Downloaded {args.ortho.name} and its detached label {args.ortho_label.name} "
                    f"(label sha256 {ortho_label_sha}) from the HiRISE PDS archive.",
                    "Verified that the label's map projection equals the DTM's.",
                    f"Decoded JPEG 2000 and extracted {window} with no resampling or contrast change.",
                    "Wrote 8-bit greyscale PNG (lossless).",
                ],
                quality_notes=quality_ortho,
            ),
        ],
    }
    (args.out / "manifest.json").write_text(json.dumps(manifest, indent=2, ensure_ascii=False) + "\n", encoding="utf-8")

    # Values for the application's own tests, taken from the raw-byte read.
    rng = np.random.default_rng(20261114)
    picks = [(int(c), int(r)) for c, r in zip(rng.integers(0, size, 64), rng.integers(0, size, 64))]
    picks += [(0, 0), (size - 1, 0), (0, size - 1), (size - 1, size - 1)]
    samples_out = {
        "description": "Elevations read from the original .IMG by byte offset (not by the application), "
        "used to test that the application returns the product's own values.",
        "source_product_id": label["PRODUCT_ID"],
        "source_verified": verified,
        "region_min_m": roi_min,
        "region_max_m": roi_max,
        "region_nodata_cells": int((~valid).sum()),
        "samples": [
            {
                "col": c,
                "row": r,
                "source_sample": col0 + c + 1,
                "source_line": row0 + r + 1,
                "elevation_m": None if elev[r, c] == nodata else float(elev[r, c]),
            }
            for c, r in picks
        ],
        "corner_latlon": {
            "north_west": [lat_n, lon_w],
            "south_east": [lat_s, lon_e],
        },
    }
    (args.out / "validation_samples.json").write_text(json.dumps(samples_out, indent=2) + "\n", encoding="utf-8")

    print(f"\nWrote {args.out}/ : elevation.bin ({elev_path.stat().st_size} bytes), ortho.png ({ortho_path.stat().st_size} bytes)")
    print(f"  region {lat_s:.6f}..{lat_n:.6f} N, {lon_w:.6f}..{lon_e:.6f} E; cell {cell_x:.4f} × {cell_y:.4f} m")
    print(f"  elevation {roi_min:.2f}..{roi_max:.2f} m; real source verified: {verified}")


if __name__ == "__main__":
    main()
