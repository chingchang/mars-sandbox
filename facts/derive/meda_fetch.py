#!/usr/bin/env python3
"""
Fetch the MEDA products needed for task F2 from the PDS Atmospheres node:
derived pressure (DER_PS) and calibrated air temperature (CAL_ATS), with
their PDS4 labels, for every sol of Mars Year 36 that has them.

    python -I facts/derive/meda_fetch.py [--max-sol 720] [--workers 8] [--dry-run]

Mars Year 36 is delimited from the labels: the first sol after landing up
to the last sol before mars2020:start_solar_longitude wraps past 360 deg.
Downloads land in data/raw/meda/<collection>/sol_NNNN/ (untrusted data,
gitignored). A manifest with the bundle/collection versions, every file's
LID, version and sha256, and the sol list is written to
data/raw/meda/manifest.json; facts/derive/meda_my36.py reads that manifest.
"""
import argparse, concurrent.futures as cf, hashlib, json, re, sys, time, urllib.request
from pathlib import Path

ROOT = Path(__file__).resolve().parents[2]
RAW = ROOT / "data" / "raw" / "meda"
BASE = "https://atmos.nmsu.edu/PDS/data/PDS4/Mars2020/mars2020_meda/"
PRODUCTS = {"data_derived_env": "DER_PS", "data_calibrated_env": "CAL_ATS"}
UA = {"User-Agent": "mars-sandbox-facts-ingest/0.1"}


def get(url, retries=4, binary=False):
    for i in range(retries):
        try:
            with urllib.request.urlopen(urllib.request.Request(url, headers=UA), timeout=120) as r:
                data = r.read()
                return data if binary else data.decode("utf-8", "replace")
        except Exception as e:  # noqa: BLE001
            if i == retries - 1:
                raise
            time.sleep(2 * (i + 1))


def sol_dir(sol: int) -> str:
    """PDS directory bucket for a sol (90-sol buckets up to 179, then 120-sol buckets)."""
    if sol < 90: return "sol_0000_0089"
    if sol < 180: return "sol_0090_0179"
    lo = 180 + ((sol - 180) // 120) * 120
    return f"sol_{lo:04d}_{lo + 119:04d}"


def inventory(collection: str, kind: str) -> dict:
    """sol -> product version (int) from the collection inventory."""
    csv = get(BASE + f"{collection}/collection_meda_{collection}_inventory.csv")
    out = {}
    for m in re.finditer(rf"we__(\d{{4}})_+{kind.lower()}_+p::(\d+)\.(\d+)", csv):
        out[int(m.group(1))] = int(m.group(2))
    return out


def file_name(sol: int, kind: str, version: int) -> str:
    return f"WE__{sol:04d}___________{kind}{'_' * (24 - len(kind))}P{version:02d}"   # product field is 24 chars wide


def sha256(path: Path) -> str:
    h = hashlib.sha256()
    with open(path, "rb") as f:
        for chunk in iter(lambda: f.read(1 << 20), b""):
            h.update(chunk)
    return h.hexdigest()


def fetch_one(collection, sol, kind, version, dry):
    name = file_name(sol, kind, version)
    d = RAW / collection / f"sol_{sol:04d}"
    d.mkdir(parents=True, exist_ok=True)
    url = BASE + f"{collection}/{sol_dir(sol)}/sol_{sol:04d}/{name}"
    xml_path, csv_path = d / (name + ".xml"), d / (name + ".CSV")
    if not xml_path.exists():
        xml_path.write_bytes(get(url + ".xml", binary=True))
    label = xml_path.read_text(errors="replace")
    ls0 = re.search(r"start_solar_longitude[^>]*>([\d.]+)<", label)
    ls1 = re.search(r"stop_solar_longitude[^>]*>([\d.]+)<", label)
    lid = re.search(r"<logical_identifier>([^<]+)</logical_identifier>", label)
    vid = re.search(r"<version_id>([^<]+)</version_id>", label)
    rec = {"sol": sol, "collection": collection, "kind": kind, "file": str(csv_path.relative_to(ROOT)), "url": url + ".CSV",
           "lid": lid.group(1) if lid else None, "version_id": vid.group(1) if vid else None,
           "ls_start": float(ls0.group(1)) if ls0 else None, "ls_stop": float(ls1.group(1)) if ls1 else None}
    if dry:
        return rec
    if not csv_path.exists():
        csv_path.write_bytes(get(url + ".CSV", binary=True))
    rec["sha256"] = sha256(csv_path); rec["bytes"] = csv_path.stat().st_size
    return rec


def main(argv=None):
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("--max-sol", type=int, default=720)
    ap.add_argument("--workers", type=int, default=8)
    ap.add_argument("--dry-run", action="store_true", help="labels only; report the MY36 sol range")
    a = ap.parse_args(argv)
    RAW.mkdir(parents=True, exist_ok=True)

    bundle = get(BASE + "bundle.xml")
    bundle_version = re.search(r"<version_id>([^<]+)</version_id>", bundle).group(1)
    inv = {c: inventory(c, k) for c, k in PRODUCTS.items()}
    print("bundle version", bundle_version, {c: f"{len(v)} sols" for c, v in inv.items()})

    # phase 1: labels only, to delimit MY36 from pressure-sensor solar longitudes
    ps_inv = inv["data_derived_env"]
    sols = [s for s in sorted(ps_inv) if s <= a.max_sol]
    with cf.ThreadPoolExecutor(a.workers) as ex:
        labels = list(ex.map(lambda s: fetch_one("data_derived_env", s, "DER_PS", ps_inv[s], True), sols))
    my36, prev = [], -1.0
    for rec in labels:
        if rec["ls_start"] is None: continue
        if rec["ls_start"] < prev - 180: break          # wrapped past 360: MY37 begins
        prev = rec["ls_start"]; my36.append(rec["sol"])
    print(f"MY36: {len(my36)} sols with DER_PS, sol {my36[0]}..{my36[-1]}, Ls {labels[0]['ls_start']}..{prev}")
    if a.dry_run:
        return 0

    # phase 2: CSVs for both products over MY36
    jobs = [(c, s, k, inv[c][s]) for c, k in PRODUCTS.items() for s in my36 if s in inv[c]]
    print(f"fetching {len(jobs)} products with {a.workers} workers")
    records, t0, done = [], time.time(), 0
    with cf.ThreadPoolExecutor(a.workers) as ex:
        for rec in ex.map(lambda j: fetch_one(j[0], j[1], j[2], j[3], False), jobs):
            records.append(rec); done += 1
            if done % 50 == 0:
                mb = sum(r["bytes"] for r in records) / 1e6
                print(f"  {done}/{len(jobs)} files, {mb:.0f} MB, {time.time() - t0:.0f} s", flush=True)
    manifest = {"bundle": "urn:nasa:pds:mars2020_meda", "bundle_version": bundle_version, "base_url": BASE,
                "fetched_on": time.strftime("%Y-%m-%d"), "mars_year": 36, "sols": my36,
                "products": sorted(records, key=lambda r: (r["collection"], r["sol"]))}
    (RAW / "manifest.json").write_text(json.dumps(manifest, indent=1) + "\n")
    print(f"wrote {RAW / 'manifest.json'}: {len(records)} files, {sum(r['bytes'] for r in records) / 1e9:.2f} GB")
    return 0


if __name__ == "__main__":
    sys.exit(main())
