#!/usr/bin/env python3
"""Build HYDE's offline globe texture from the NASA/JPL Mars Trek MOC atlas."""
import argparse
from concurrent.futures import ThreadPoolExecutor
from io import BytesIO
from pathlib import Path
from urllib.request import urlopen

from PIL import Image

BASE = "https://trek.nasa.gov/tiles/Mars/EQ/msss_atlas_simp_clon/1.0.0/default/default028mm"
OUTPUT = Path(__file__).resolve().parents[1] / "src" / "assets" / "mars-trek-moc-atlas.jpg"
# The service tiles are grayscale. Apply an illustrative palette, not calibrated true color.
PALETTE = [
    (0, (16, 12, 16)),
    (32, (64, 34, 31)),
    (92, (150, 79, 56)),
    (155, (211, 130, 90)),
    (208, (245, 183, 135)),
    (255, (254, 245, 231)),
]


def apply_palette(gray):
    lut = [[], [], []]
    for value in range(256):
        for (low, a), (high, b) in zip(PALETTE, PALETTE[1:]):
            if value <= high:
                t = (value - low) / (high - low)
                for i in range(3):
                    lut[i].append(round(a[i] + (b[i] - a[i]) * t))
                break
    return Image.merge("RGB", [gray.point(channel) for channel in lut])


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--tile-cache", type=Path, help="Optional directory of previously downloaded row-column PNGs.")
    args = parser.parse_args()
    if args.tile_cache:
        args.tile_cache.mkdir(parents=True, exist_ok=True)

    def get(rc):
        row, col = rc
        cached = args.tile_cache / f"{row}-{col}.png" if args.tile_cache else None
        if cached and cached.is_file():
            data = cached.read_bytes()
        else:
            with urlopen(f"{BASE}/2/{row}/{col}.png", timeout=25) as reply:
                data = reply.read()
            if cached:
                cached.write_bytes(data)
        with Image.open(BytesIO(data)) as tile:
            if tile.size != (256, 256):
                raise ValueError(f"Invalid tile size at row {row}, column {col}: {tile.size}")
            return row, col, tile.convert("L")

    mosaic = Image.new("L", (2048, 1024))
    with ThreadPoolExecutor(max_workers=8) as pool:
        for row, col, tile in pool.map(get, [(r, c) for r in range(4) for c in range(8)]):
            mosaic.paste(tile, (col * 256, row * 256))
    OUTPUT.parent.mkdir(parents=True, exist_ok=True)
    apply_palette(mosaic).save(OUTPUT, quality=92, optimize=True)
    print(f"{OUTPUT}: 2048 × 1024")


if __name__ == "__main__":
    main()
