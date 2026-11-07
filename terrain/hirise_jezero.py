#!/usr/bin/env python3
"""
Export a 1 m/px local-metre-grid heightmap around the Perseverance landing
site from the USGS Mars 2020 TRN HiRISE DTM mosaic (task T1).

  python -I terrain/hirise_jezero.py fetch  --size-km 5                      # rows around the site -> data/raw/hirise/
  python -I terrain/hirise_jezero.py export --size-km 5 --res-m 1 --out web/terrain/jezero_hirise_5km.png

Source product (Fergason, Galuszka, Hare; USGS Astrogeology, 2020,
doi:10.5066/P9REJ9JN): JEZ_hirise_soc_006_DTM_MOLAtopography_DeltaGeoid_1m_
Eqc_latTs0_lon0_blend40.tif, 21488 x 21400 float32 metres, equirectangular
with standard parallel 0 on a 3396190 m sphere, heights relative to the MOLA
areoid. The GeoTIFF is uncompressed, one row per strip, data from byte
172609 (ISIS label StartByte 172610, 1-based), so `fetch` pulls just the rows that cover the window
with an HTTP Range request and records the byte range and sha256.

Projection to the output: the mosaic's x spacing is 1 m at the equator, so
at the site a column is cos(lat) m on the ground. `export` resamples onto a
true local metre grid centred on the landing site (x east, y north) with
bilinear sampling, exactly as terrain/mola_jezero.py does for MOLA.

Both the .lbl and the fetched bytes are untrusted data: the label is parsed
with a regex and the bytes are read as raw float32. No number about Mars is
written in this file; the centre comes from facts/index.json and the grid
geometry from the ISIS label.
"""
import argparse, datetime, hashlib, json, re, sys, urllib.request
from pathlib import Path
import numpy as np
from PIL import Image

HERE = Path(__file__).resolve().parent
ROOT = HERE.parent
RAW = ROOT / "data" / "raw" / "hirise"
BASE_URL = "https://asc-pds-services.s3.us-west-2.amazonaws.com/mosaic/mars2020_trn/HiRISE/"
PRODUCT = "JEZ_hirise_soc_006_DTM_MOLAtopography_DeltaGeoid_1m_Eqc_latTs0_lon0_blend40"
SOURCE_ID = "usgs-m2020-hirise-dtm"


def parse_isis_label(text: str) -> dict:
    out = {}
    for m in re.finditer(r"^\s*([A-Za-z][A-Za-z0-9_]*)\s*=\s*([^\n<]+?)\s*(?:<[^>]*>)?\s*$", text, re.M):
        k, v = m.group(1), m.group(2).strip()
        if k in out:
            continue
        try:
            out[k] = float(v) if re.fullmatch(r"-?\d+(\.\d+)?([eE][-+]?\d+)?", v) else v
        except ValueError:
            out[k] = v
    return out


def geometry(lbl: dict, facts: dict):
    """Return (R, ppd, ulx, uly, samples, lines, start_byte, lat0, lon0, col0, row0)."""
    R = float(lbl["EquatorialRadius"]); ppd = float(lbl["Scale"])
    ulx, uly = float(lbl["UpperLeftCornerX"]), float(lbl["UpperLeftCornerY"])
    # ISIS StartByte is 1-based; the TIFF strip offset is StartByte - 1 (verified against the TIFF IFD)
    samples, lines, start = int(lbl["Samples"]), int(lbl["Lines"]), int(lbl["StartByte"]) - 1
    if lbl.get("ProjectionName") != "Equirectangular" or float(lbl.get("CenterLatitude", 0)) != 0.0:
        sys.exit("expected Equirectangular with CenterLatitude 0")
    if lbl.get("ByteOrder") != "Lsb" or lbl.get("Type") != "Real":
        sys.exit("expected Lsb Real pixels")
    site = facts["facts"]["jezero.location.landing_site"]
    lat0, lon0 = float(site["value"]["lat"]), float(site["value"]["lon_e"])
    # projected metres: x = lon * ppd (metres per degree at the equator), y = lat * ppd; pixel centres at +0.5
    col0 = lon0 * ppd - ulx - 0.5
    row0 = uly - lat0 * ppd - 0.5
    if not (0 <= col0 < samples and 0 <= row0 < lines):
        sys.exit(f"landing site at col {col0:.1f}, row {row0:.1f} is outside the mosaic")
    return R, ppd, ulx, uly, samples, lines, start, lat0, lon0, col0, row0


def window_rows(row0: float, size_m: float, lines: int):
    half = size_m / 2.0 + 2.0                       # + margin for bilinear neighbours
    r0 = max(0, int(np.floor(row0 - half))); r1 = min(lines - 1, int(np.ceil(row0 + half)))
    return r0, r1


def sha256_file(path: Path) -> str:
    h = hashlib.sha256()
    with open(path, "rb") as f:
        for chunk in iter(lambda: f.read(1 << 20), b""):
            h.update(chunk)
    return h.hexdigest()


def cmd_fetch(a, lbl, facts):
    R, ppd, ulx, uly, samples, lines, start, lat0, lon0, col0, row0 = geometry(lbl, facts)
    r0, r1 = window_rows(row0, a.size_km * 1000.0, lines)
    row_bytes = samples * 4
    b0, b1 = start + r0 * row_bytes, start + (r1 + 1) * row_bytes - 1
    out = RAW / f"{PRODUCT}.rows{r0}-{r1}.f32"
    url = BASE_URL + PRODUCT + ".tif"
    print(f"rows {r0}..{r1} ({r1 - r0 + 1} rows, {(b1 - b0 + 1) / 1e6:.1f} MB) bytes {b0}-{b1} from {url}")
    req = urllib.request.Request(url, headers={"Range": f"bytes={b0}-{b1}", "User-Agent": "mars-sandbox-terrain-ingest/0.1"})
    with urllib.request.urlopen(req, timeout=120) as resp, open(out, "wb") as f:
        if resp.status != 206:
            sys.exit(f"expected 206 Partial Content, got {resp.status}")
        n = 0
        for chunk in iter(lambda: resp.read(1 << 22), b""):
            f.write(chunk); n += len(chunk)
    if n != b1 - b0 + 1:
        sys.exit(f"short read: {n} bytes")
    meta = {"url": url, "byte_range": [b0, b1], "rows": [r0, r1], "row_bytes": row_bytes, "sha256": sha256_file(out),
            "fetched_on": datetime.date.today().isoformat()}
    out.with_suffix(".f32.json").write_text(json.dumps(meta, indent=2) + "\n")
    print(f"wrote {out} ({n / 1e6:.1f} MB), sha256 {meta['sha256'][:16]}...")
    return 0


def bilinear(grid, rows, cols):
    r0 = np.floor(rows).astype(int); c0 = np.floor(cols).astype(int)
    fr = rows - r0; fc = cols - c0
    r1 = np.clip(r0 + 1, 0, grid.shape[0] - 1); c1 = np.clip(c0 + 1, 0, grid.shape[1] - 1)
    r0 = np.clip(r0, 0, grid.shape[0] - 1); c0 = np.clip(c0, 0, grid.shape[1] - 1)
    g = grid.astype(np.float64)
    return g[r0, c0] * (1 - fr) * (1 - fc) + g[r0, c1] * (1 - fr) * fc + g[r1, c0] * fr * (1 - fc) + g[r1, c1] * fr * fc


def cmd_export(a, lbl, facts):
    R, ppd, ulx, uly, samples, lines, start, lat0, lon0, col0, row0 = geometry(lbl, facts)
    r0, r1 = window_rows(row0, a.size_km * 1000.0, lines)
    raw = RAW / f"{PRODUCT}.rows{r0}-{r1}.f32"
    if not raw.exists():
        sys.exit(f"{raw} missing; run `fetch --size-km {a.size_km:g}` first")
    meta = json.loads(raw.with_suffix(".f32.json").read_text())
    grid = np.memmap(raw, dtype="<f4", mode="r", shape=(r1 - r0 + 1, samples))

    n = int(round(a.size_km * 1000.0 / a.res_m)) | 1
    half = (n - 1) / 2.0
    x = (np.arange(n) - half) * a.res_m                     # east, metres on the ground
    y = (half - np.arange(n)) * a.res_m                     # north
    X, Y = np.meshgrid(x, y)
    lat = lat0 + np.degrees(Y / R)
    lon = lon0 + np.degrees(X / (R * np.cos(np.radians(lat0))))
    cols = lon * ppd - ulx - 0.5
    rows = uly - lat * ppd - 0.5 - r0
    if cols.min() < 0 or cols.max() > samples - 1 or rows.min() < 0 or rows.max() > grid.shape[0] - 1:
        sys.exit("window exceeds fetched rows / mosaic columns")
    elev = bilinear(grid, rows, cols)
    nodata = ~np.isfinite(elev) | (elev < -1e4)
    if nodata.any():
        print(f"warning: {int(nodata.sum())} nodata samples in window; filled with nearest finite row mean", file=sys.stderr)
        elev = np.where(nodata, np.nanmean(np.where(nodata, np.nan, elev)), elev)

    scale = a.scale_m
    offset = float(np.floor(elev.min()))
    enc = np.round((elev - offset) / scale)
    if enc.max() > 65535:
        sys.exit(f"elevation range {elev.max() - elev.min():.1f} m exceeds 16-bit at {scale} m; raise --scale-m")
    a.out.parent.mkdir(parents=True, exist_ok=True)
    Image.fromarray(enc.astype(np.uint16)).save(a.out, format="PNG")

    c = n // 2
    nb = elev[c - 1:c + 2, c - 1:c + 2]
    sidecar = {
        "product": a.out.name,
        "description": f"HiRISE DTM heightmap, {a.size_km:g} x {a.size_km:g} km around the Perseverance landing site, {a.res_m:g} m/px, north up, x east",
        "source_id": SOURCE_ID,
        "source": {
            "title": "High-Resolution Imaging Science Experiment Digital Terrain Model Mosaic for Mars 2020 Terrain Relative Navigation",
            "product": PRODUCT + ".tif", "doi": "10.5066/P9REJ9JN", "url": meta["url"],
            "fetched_byte_range": meta["byte_range"], "fetched_rows": meta["rows"], "fetched_sha256": meta["sha256"], "fetched_on": meta["fetched_on"],
            "label_sha256": sha256_file(a.lbl),
        },
        "datum": {
            "vertical": "height relative to the MOLA areoid ('MOLAtopography_DeltaGeoid' in the product name; DTMs tied to the MOLA-controlled CTX DTM, see lineage in the USGS FGDC metadata)",
            "horizontal": "D_Mars_2000_Sphere, planetocentric latitude, east-positive longitude",
            "sphere_radius_m": R,
        },
        "projection": {
            "type": "local equirectangular tangent plane",
            "formula": "x = R cos(lat0) (lon - lon0); y = R (lat - lat0); angles in radians",
            "centre": {"lat": lat0, "lon_e": lon0, "fact_id": "jezero.location.landing_site"},
            "x_axis": "east", "y_axis": "north (row 0 is the northern edge)",
            "sampling": "bilinear in the source mosaic; source is Equirectangular lat_ts=0 at 1 m/px, i.e. cos(lat) m per column on the ground",
            "source_resolution": {"pixels_per_degree": ppd, "map_scale_m_per_px": 1.0},
        },
        "grid": {"width": n, "height": n, "resolution_m": a.res_m, "extent_m": [float(x[0]), float(x[-1]), float(y[-1]), float(y[0])], "centre_pixel": [c, c]},
        "encoding": {"format": "PNG 16-bit greyscale", "dtype": "uint16", "offset_m": offset, "scale_m": scale,
                     "formula": "elevation_m = offset_m + scale_m * value", "nodata": None},
        "elevation_m": {"min": float(elev.min()), "max": float(elev.max()), "centre": float(elev[c, c]),
                        "centre_3x3_std": float(nb.std()), "centre_3x3_range": [float(nb.min()), float(nb.max())]},
        "generated_by": f"terrain/{Path(__file__).name}", "generated_on": datetime.date.today().isoformat(),
        "facts_content_hash": facts.get("content_hash"),
    }
    a.out.with_suffix(".json").write_text(json.dumps(sidecar, indent=2) + "\n")
    print(f"wrote {a.out} ({n}x{n} @ {a.res_m:g} m) and sidecar; elevation {elev.min():.1f}..{elev.max():.1f} m, centre {elev[c, c]:.1f} m")
    return 0


def main(argv=None):
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("cmd", choices=["fetch", "export"])
    ap.add_argument("--lbl", type=Path, default=RAW / "meta" / (PRODUCT + ".lbl"))
    ap.add_argument("--facts", type=Path, default=ROOT / "facts" / "index.json")
    ap.add_argument("--size-km", type=float, default=5.0)
    ap.add_argument("--res-m", type=float, default=1.0)
    ap.add_argument("--scale-m", type=float, default=0.05, help="vertical quantisation of the PNG")
    ap.add_argument("--out", type=Path, default=ROOT / "web" / "terrain" / "jezero_hirise_5km.png")
    a = ap.parse_args(argv)
    lbl = parse_isis_label(a.lbl.read_text(errors="replace"))
    facts = json.loads(a.facts.read_text())
    return cmd_fetch(a, lbl, facts) if a.cmd == "fetch" else cmd_export(a, lbl, facts)


if __name__ == "__main__":
    sys.exit(main())
