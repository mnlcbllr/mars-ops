#!/usr/bin/env python3
"""Package USGS SIM 3464 geologic units in the local Jezero grid (pyproj + shapely)."""
import hashlib
import json
import math
from datetime import datetime, timezone
from pathlib import Path
from urllib.parse import urlencode
from urllib.request import urlopen

from pyproj import Proj
from shapely import box
from shapely.geometry import Polygon
from shapely.ops import transform

DATA = Path(__file__).resolve().parents[1] / "datasets" / "jezero-small"
SERVICE = "https://services.arcgis.com/v01gqwM5QqNysAAi/arcgis/rest/services/Jezero_FeatureServiceFromPro/FeatureServer/8"
QUERY = {
    "f": "json", "geometry": "-1400,1093650,1100,1096200",
    "geometryType": "esriGeometryEnvelope", "spatialRel": "esriSpatialRelIntersects",
    "outFields": "OBJECTID,unit,name,symbol_noSub,subscript", "returnGeometry": "true",
}
SOURCE = f"{SERVICE}/query?{urlencode(QUERY)}"
PRODUCT = "USGS-SIM-3464"
COLORS = {"2": "#61c7ad", "0": "#f2b76b"}


def sha(data):
    return hashlib.sha256(data).hexdigest()


def polygons(shape):
    if shape.geom_type == "Polygon" and not shape.is_empty:
        yield shape
    elif hasattr(shape, "geoms"):
        for part in shape.geoms:
            yield from polygons(part)


def write_from(raw):
    manifest_path = DATA / "manifest.json"
    manifest = json.loads(manifest_path.read_text())
    geo = manifest["georeference"]
    bbox = manifest["roi_bbox"]
    response = json.loads(raw)
    if response.get("error") or response.get("exceededTransferLimit") or not response.get("features"):
        raise ValueError("The source did not return a complete set of geologic features.")
    proj = Proj(response["spatialReference"]["wkt"])
    xmin, ymin, xmax, ymax = map(float, QUERY["geometry"].split(","))
    for lon in (bbox["lon_east_min"], bbox["lon_east_max"]):
        for lat in (bbox["lat_min"], bbox["lat_max"]):
            x, y = proj(lon, lat)
            if not (xmin < x < xmax and ymin < y < ymax):
                raise ValueError("USGS query extent does not contain the HiRISE crop.")
    radius = geo["radius_m"]
    sx = geo["cell_size_x_m"] / geo["map_scale_m_per_px"]
    sy = geo["cell_size_y_m"] / geo["map_scale_m_per_px"]
    ymax_eqc = geo["roi_y_max_m"]
    width = geo["width"] * geo["cell_size_x_m"]
    height = geo["height"] * geo["cell_size_y_m"]
    clip = box(0, 0, width, height)

    def to_local(x, y):
        lon, lat = proj(x, y, inverse=True)
        eqx = radius * math.cos(math.radians(geo["center_latitude_deg"])) * math.radians(lon - geo["center_longitude_deg"])
        eqy = radius * math.radians(lat)
        return (eqx - geo["roi_x_min_m"]) * sx, height + (eqy - ymax_eqc) * sy

    def ring(coords):
        return [[round(x, 2), round(y, 2)] for x, y in coords]

    units = {}
    for feature in sorted(response["features"], key=lambda f: f["attributes"]["OBJECTID"]):
        a = feature["attributes"]
        # ArcGIS uses rings with alternating fill, including holes and islands.
        shape = Polygon()
        for source_ring in feature["geometry"]["rings"]:
            part = transform(to_local, Polygon(source_ring)).intersection(clip)
            shape = shape.symmetric_difference(part)
        if shape.is_empty or shape.area == 0:
            continue
        unit = units.setdefault(a["unit"], {
            "symbol": (a["symbol_noSub"] or "") + (a["subscript"] or ""),
            "name": a["name"],
            "color": COLORS.get(a["unit"], "#a5a9ec"),
            "polygons": [],
        })
        for part in polygons(shape):
            unit["polygons"].append([ring(part.exterior.coords), *[ring(h.coords) for h in part.interiors]])
    if not units:
        raise ValueError("No mapped geologic units overlap the HiRISE crop.")
    encoded = (json.dumps({"units": list(units.values())}, separators=(",", ":")) + "\n").encode()
    (DATA / "geology.json").write_bytes(encoded)
    manifest["layers"] = [layer for layer in manifest["layers"] if layer["id"] != "usgs-jezero-geology"]
    manifest["layers"].append({
        "id": "usgs-jezero-geology", "display_name": "USGS geologic units (regional)", "kind": "GEOLOGY",
        "file": "geology.json", "origin_type": "DERIVED", "provider": "U.S. Geological Survey",
        "instrument": "USGS geologic mapping (Sun and Stack, 2020)", "product_id": PRODUCT,
        "source_url": SOURCE, "license_and_credit": "Public domain. Sun, V.Z., and Stack, K.M., 2020, USGS Scientific Investigations Map 3464, doi:10.3133/sim3464.",
        "retrieved_utc": datetime.now(timezone.utc).isoformat(timespec="seconds"),
        "observation_date": None, "source_crs": response["spatialReference"]["wkt"],
        "output_crs": "Jezero crop local coordinates: x east, y north, metres, origin at south-west.",
        "vertical_datum": None, "pixel_size_m": None, "bbox_original": None, "bbox_projected_m": None,
        "nodata_value": None, "sha256_source": sha(raw), "sha256_derived": sha(encoded),
        "processing_steps": [
            "Queried the USGS ArcGIS geologic units layer (layer 8) for features intersecting the crop.",
            "Inverted the source Mars transverse Mercator projection to latitude/longitude and mapped angular coordinates to the HiRISE local frame.",
            "Clipped polygons to the crop, preserving holes. Stored local coordinates rounded to 0.01 m for compactness; this is not source accuracy.",
        ],
        "quality_notes": [
            "Source map scale 1:75,000. Regional geologic context only; boundaries and site associations are approximate.",
            "Units are published interpretations, not mineral identifications at the stops or walking hazards. This layer is not used to route.",
        ],
        "is_real_source_verified": True,
    })
    manifest_path.write_text(json.dumps(manifest, ensure_ascii=False, indent=2) + "\n")
    print("Packaged", ", ".join(unit["name"] for unit in units.values()))


if __name__ == "__main__":
    import sys
    if len(sys.argv) == 2:
        write_from(Path(sys.argv[1]).read_bytes())
    else:
        with urlopen(SOURCE, timeout=45) as reply:
            write_from(reply.read())
