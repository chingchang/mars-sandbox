#!/usr/bin/env python3
"""
Export a local-metre-grid heightmap around the Jezero landing site from the
MOLA MEGDR 128 pixel/degree tile (PDS MGS-M-MOLA-5-MEGDR-L3-V1.0, task T1).

    python -I terrain/mola_jezero.py \
        --img data/raw/mola/megt44n000hb.img --lbl data/raw/mola/megt44n000hb.lbl \
        --out web/terrain/jezero_mola_40km.png --size-km 40 --res-m 460

Inputs are treated as untrusted data: the .img is memory-mapped as raw int16
and the .lbl is parsed with a key=value regex; nothing is executed from them.

Outputs
  <out>.png   16-bit greyscale PNG, north up, x east; elevation_m = offset + scale * value
  <out>.json  sidecar: datum, projection, scale, encoding, source, version, hashes

Projection: a local tangent-plane equirectangular grid centred on the landing
site. x = R cos(lat0) (lon - lon0), y = R (lat - lat0), R from the tile label.
Over +/-20 km the scale distortion is below 2e-5, far under MOLA's own
precision, so no conformal projection is needed. Samples are bilinear in the
MEGDR grid (pixel centres at lat = MAX_LAT - (row + 0.5)/ppd).

No number about Mars is written in this file: the centre comes from
facts/index.json (jezero.location.landing_site) and the datum, radius and
resolution come from the PDS label.
"""
import argparse, datetime, hashlib, json, re, sys
from pathlib import Path
import numpy as np
from PIL import Image

HERE = Path(__file__).resolve().parent
ROOT = HERE.parent


def parse_label(text: str) -> dict:
    """Flat PDS3 key = value parser; later keys (inside objects) do not override earlier ones."""
    out = {}
    for m in re.finditer(r"^\s*([A-Z_^][A-Z0-9_]*)\s*=\s*(.+?)\s*$", text, re.M):
        k, v = m.group(1), m.group(2)
        if k in out:
            continue
        unit = re.search(r"<([A-Z/]+)>", v)
        v = re.sub(r"<[A-Z/]+>", "", v).strip().strip('"')
        try:
            v = float(v) if re.fullmatch(r"-?\d+(\.\d+)?", v) else v
        except ValueError:
            pass
        out[k] = (v, unit.group(1)) if unit else v
    return out


def sha256(path: Path) -> str:
    h = hashlib.sha256()
    with open(path, "rb") as f:
        for chunk in iter(lambda: f.read(1 << 20), b""):
            h.update(chunk)
    return h.hexdigest()


def bilinear(grid: np.ndarray, rows: np.ndarray, cols: np.ndarray) -> np.ndarray:
    r0 = np.floor(rows).astype(int); c0 = np.floor(cols).astype(int)
    fr = rows - r0; fc = cols - c0
    r1 = np.clip(r0 + 1, 0, grid.shape[0] - 1); c1 = np.clip(c0 + 1, 0, grid.shape[1] - 1)
    r0 = np.clip(r0, 0, grid.shape[0] - 1); c0 = np.clip(c0, 0, grid.shape[1] - 1)
    g = grid.astype(np.float64)
    return ((g[r0, c0] * (1 - fr) * (1 - fc)) + (g[r0, c1] * (1 - fr) * fc)
            + (g[r1, c0] * fr * (1 - fc)) + (g[r1, c1] * fr * fc))


def main(argv=None):
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("--img", required=True, type=Path)
    ap.add_argument("--lbl", required=True, type=Path)
    ap.add_argument("--out", required=True, type=Path, help="output .png path; sidecar is written next to it as .json")
    ap.add_argument("--size-km", type=float, default=40.0)
    ap.add_argument("--res-m", type=float, default=460.0)
    ap.add_argument("--facts", type=Path, default=ROOT / "facts" / "index.json")
    ap.add_argument("--source-url", default="", help="URL the .img was fetched from, recorded in the sidecar")
    a = ap.parse_args(argv)

    lbl = parse_label(a.lbl.read_text(errors="replace"))
    lines, samples = int(lbl["LINES"]), int(lbl["LINE_SAMPLES"])
    if lbl["SAMPLE_TYPE"] != "MSB_INTEGER" or int(lbl["SAMPLE_BITS"]) != 16:
        sys.exit(f"unexpected sample format {lbl['SAMPLE_TYPE']}/{lbl['SAMPLE_BITS']}")
    ppd = float(lbl["MAP_RESOLUTION"][0])
    max_lat = float(lbl["MAXIMUM_LATITUDE"][0]); west_lon = float(lbl["WESTERNMOST_LONGITUDE"][0])
    min_lat = float(lbl["MINIMUM_LATITUDE"][0]); east_lon = float(lbl["EASTERNMOST_LONGITUDE"][0])
    radius_m = float(lbl["A_AXIS_RADIUS"][0]) * 1000.0
    expected = lines * samples * 2
    if a.img.stat().st_size != expected:
        sys.exit(f"{a.img}: size {a.img.stat().st_size} != {expected} from label")
    grid = np.memmap(a.img, dtype=">i2", mode="r", shape=(lines, samples))

    facts = json.loads(a.facts.read_text())
    site = facts["facts"]["jezero.location.landing_site"]
    lat0, lon0 = float(site["value"]["lat"]), float(site["value"]["lon_e"])
    if not (min_lat <= lat0 <= max_lat and west_lon <= lon0 <= east_lon):
        sys.exit(f"centre {lat0},{lon0} outside tile {min_lat}..{max_lat} N, {west_lon}..{east_lon} E")

    n = int(round(a.size_km * 1000.0 / a.res_m)) | 1          # odd, so the centre pixel is the site
    half = (n - 1) / 2.0
    j = np.arange(n); i = np.arange(n)
    x = (j - half) * a.res_m                                   # east, metres
    y = (half - i) * a.res_m                                   # north, metres (row 0 is north)
    X, Y = np.meshgrid(x, y)
    lat = lat0 + np.degrees(Y / radius_m)
    lon = lon0 + np.degrees(X / (radius_m * np.cos(np.radians(lat0))))
    rows = (max_lat - lat) * ppd - 0.5
    cols = (lon - west_lon) * ppd - 0.5
    if rows.min() < 0 or rows.max() > lines - 1 or cols.min() < 0 or cols.max() > samples - 1:
        sys.exit("window crosses the tile edge; a second tile would be needed")
    elev = bilinear(grid, rows, cols)                          # metres above areoid

    scale = 0.1
    offset = float(np.floor(elev.min()))
    enc = np.round((elev - offset) / scale)
    if enc.max() > 65535:
        sys.exit("elevation range exceeds 16-bit at 0.1 m; raise scale")
    img = Image.fromarray(enc.astype(np.uint16))
    a.out.parent.mkdir(parents=True, exist_ok=True)
    img.save(a.out, format="PNG")

    c = n // 2
    centre = float(elev[c, c])
    nb = elev[c - 1:c + 2, c - 1:c + 2]
    sidecar = {
        "product": a.out.name,
        "description": f"MOLA MEGDR heightmap, {a.size_km:g} x {a.size_km:g} km around the Perseverance landing site, {a.res_m:g} m/px, north up, x east",
        "source_id": "mola-megdr",
        "source": {
            "data_set_id": lbl["DATA_SET_ID"], "product_id": lbl["PRODUCT_ID"], "product_version_id": lbl["PRODUCT_VERSION_ID"],
            "producer": lbl.get("PRODUCER_INSTITUTION_NAME"), "product_creation_time": lbl.get("PRODUCT_CREATION_TIME"),
            "url": a.source_url, "img_sha256": sha256(a.img), "label_sha256": sha256(a.lbl),
        },
        "datum": {
            "vertical": "height above the areoid (Goddard Mars potential model GMM3 / mgm1025, degree and order 50), per the PDS label",
            "horizontal": "IAU2000, planetocentric latitude, east-positive longitude",
            "sphere_radius_m": radius_m, "note": "radius is the label's A_AXIS_RADIUS, used for the local metre grid only",
        },
        "projection": {
            "type": "local equirectangular tangent plane",
            "formula": "x = R cos(lat0) (lon - lon0); y = R (lat - lat0); angles in radians",
            "centre": {"lat": lat0, "lon_e": lon0, "fact_id": "jezero.location.landing_site"},
            "x_axis": "east", "y_axis": "north (row 0 is the northern edge)",
            "sampling": "bilinear in the MEGDR grid; pixel centres at lat = MAX_LAT - (row + 0.5)/ppd",
            "source_resolution": {"pixels_per_degree": ppd, "map_scale_km_per_px": float(lbl["MAP_SCALE"][0])},
        },
        "grid": {"width": n, "height": n, "resolution_m": a.res_m, "extent_m": [float(x[0]), float(x[-1]), float(y[-1]), float(y[0])],
                 "centre_pixel": [c, c]},
        "encoding": {"format": "PNG 16-bit greyscale", "dtype": "uint16", "offset_m": offset, "scale_m": scale,
                     "formula": "elevation_m = offset_m + scale_m * value", "nodata": None},
        "elevation_m": {"min": float(elev.min()), "max": float(elev.max()), "centre": centre,
                        "centre_3x3_std": float(nb.std()), "centre_3x3_range": [float(nb.min()), float(nb.max())]},
        "generated_by": f"terrain/{Path(__file__).name}", "generated_on": datetime.date.today().isoformat(),
        "facts_content_hash": facts.get("content_hash"),
    }
    a.out.with_suffix(".json").write_text(json.dumps(sidecar, indent=2) + "\n")
    print(f"wrote {a.out} ({n}x{n} @ {a.res_m:g} m) and sidecar; elevation {elev.min():.1f}..{elev.max():.1f} m, centre {centre:.1f} m")
    return 0


if __name__ == "__main__":
    sys.exit(main())
