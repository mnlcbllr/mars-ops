"""Offline, deterministic THEMIS brightness registration. No app GIS dependency.

Run: tools/.venv/bin/python tools/prepare_themis.py
Requires rasterio, numpy, Pillow. Never edits archive bytes or SHA256SUMS.txt.
"""
import hashlib
import json
import math
from pathlib import Path

import numpy as np
import rasterio
from PIL import Image
from rasterio.transform import Affine
from rasterio.warp import reproject, Resampling

ROOT = Path(__file__).resolve().parents[1] / "datasets/jezero-small"
SOURCE = "02-thermal/jezero-THEMIS-dir.tif"
URL = "https://astrogeo-ard.s3.us-west-2.amazonaws.com/mars/mo/themis/controlled_mosaics/mc13_syrtis_major_dir/mc13_syrtis_major_dir.tif"


def sha(path):
    return hashlib.sha256(path.read_bytes()).hexdigest()


def main():
    expected = dict(line.split(maxsplit=1)[::-1] for line in (ROOT / "SHA256SUMS.txt").read_text().splitlines())
    assert sha(ROOT / SOURCE) == expected[SOURCE], "archived crop checksum changed"
    manifest = json.loads((ROOT / "manifest.json").read_text())
    g = manifest["georeference"]
    transform = Affine(g["map_scale_m_per_px"] * 4, 0, g["roi_x_min_m"],
                       0, -g["map_scale_m_per_px"] * 4, g["roi_y_max_m"])
    crs = manifest["layers"][0]["source_crs"]
    output = np.zeros((g["height"] // 4, g["width"] // 4), dtype="uint8")
    checks = []
    with rasterio.open(ROOT / SOURCE) as source:
        assert source.count == 1 and source.dtypes == ("uint8",)
        assert source.nodata == 0
        reproject(source=rasterio.band(source, 1), destination=output,
                  src_transform=source.transform, src_crs=source.crs, src_nodata=0,
                  dst_transform=transform, dst_crs=crs, dst_nodata=0,
                  resampling=Resampling.nearest, num_threads=1)
        values = source.read(1)
        # Independently project five output pixel centres through lat/lon using
        # each source's stated sphere and standard parallel, not image dimensions.
        for row, col in [(0, 0), (0, 511), (511, 0), (511, 511), (256, 256)]:
            x, y = transform * (col + 0.5, row + 0.5)
            lat = y / g["radius_m"]
            lon = math.radians(g["center_longitude_deg"]) + x / (g["radius_m"] * math.cos(math.radians(15)))
            sx, sy = 3396190 * lon, 3396190 * lat
            sc, sr = (~source.transform) * (sx, sy)
            want = int(values[int(sr), int(sc)])
            assert int(output[row, col]) == want != 0, "projection/sample alignment check failed"
            checks.append(dict(row=row, col=col, lat_deg=math.degrees(lat), lon_east_deg=math.degrees(lon),
                               source_row=int(sr), source_col=int(sc), brightness_dn=want))
        source_crs = source.crs.to_wkt()
        source_bounds = list(source.bounds)
    rgba = np.stack([output, output, output, np.where(output == 0, 0, 255).astype("uint8")], axis=-1)
    Image.fromarray(rgba).save(ROOT / "themis-dir.png", optimize=False)
    record = dict(
        id="odyssey-themis-day-brightness", display_name="THEMIS daytime infrared brightness (qualitative)",
        kind="INFRARED_CONTEXT", file="themis-dir.png", origin_type="DERIVED",
        provider="NASA/USGS/THEMIS team", instrument="Mars Odyssey THEMIS", product_id="mc13_syrtis_major_dir",
        source_url=URL, license_and_credit="Credit NASA/USGS and the THEMIS team. Qualitative brightness mosaic, not temperature.",
        retrieved_utc=None, observation_date=None, source_crs=source_crs,
        output_crs=f"{crs}; same ROI extent as HiRISE, 512x512; row 0 north",
        vertical_datum=None, pixel_size_m=[g["cell_size_x_m"] * 4, g["cell_size_y_m"] * 4],
        bbox_original=None, bbox_projected_m=manifest["layers"][0]["bbox_projected_m"], nodata_value=0,
        sha256_source=sha(ROOT / SOURCE), sha256_derived=sha(ROOT / "themis-dir.png"),
        is_real_source_verified=True,
        processing_steps=["tools/prepare_themis.py: verify local archived crop against unchanged SHA256SUMS.txt.",
                          "Reproject Mars 2015 sphere (R=3396190 m, eqc lat_ts=0 lon_0=0) to HiRISE product sphere/projection, nearest neighbour; preserve DN, zero transparent.",
                          "Five independent analytic lat/lon-to-source-pixel checks match the GDAL-reprojected DN exactly; see themis-registration.json."],
        quality_notes=["Effective source resolution 100 m; output ~4 m pixels do not add information. Qualitative 8-bit daytime infrared brightness, NOT calibrated temperature, thermal inertia, live weather or hazard probability.",
                       "sha256_source is the local 415x415 archive crop, NOT the full upstream mosaic (not downloaded/rehashed here). Product identity comes from SOURCE-LINKS.csv and embedded CRS; upstream content authenticity inherits that archive's provenance.",
                       "Georeference alignment verified, not independent surface feature/control-point accuracy. Different sphere radii handled through planetary lat/lon. Original observation dates, physical registration uncertainty and radiometric calibration are unknown."])
    manifest["layers"] = [l for l in manifest["layers"] if l["id"] != record["id"]] + [record]
    (ROOT / "manifest.json").write_text(json.dumps(manifest, indent=2, ensure_ascii=False) + "\n")
    registration = dict(source_file=SOURCE, source_crop_sha256=sha(ROOT / SOURCE), source_bounds=source_bounds,
                        output_sha256=sha(ROOT / "themis-dir.png"), coverage_fraction=float(np.mean(output != 0)),
                        output_transform=list(transform)[:6], checks=checks,
                        limitations=record["quality_notes"])
    (ROOT / "themis-registration.json").write_text(json.dumps(registration, indent=2) + "\n")
    print(json.dumps(registration, indent=2))


if __name__ == "__main__":
    main()
