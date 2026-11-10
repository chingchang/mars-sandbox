#!/usr/bin/env python3
"""
Fetch Jezero diurnal climatology from the Mars Climate Database (MCD) v6.2
web interface and write facts/derive/out/mcd62_jezero.json (task F3).

    python -I facts/derive/mcd_fetch.py            # ~90 requests, throttled, ~10 min

For each scenario and each solar longitude (0, 30, ..., 330 deg) the
interface is asked for hourly profiles (local time "all": 0..24 h) of
  t              air temperature at 1.45 m above the local surface (K)
  tsurf          surface temperature (K)
  ps             surface pressure (Pa), high-resolution mode
  fluxsurf_dn_sw incident solar flux on a horizontal surface (W/m2)
  fluxsurf_lw    thermal IR flux on the surface (W/m2)
  tauref         daily mean dust column visible optical depth
and the MCD day-to-day RMS variability rmst, rmstsurf, rmsps for the first
three. Four variables per request, so three requests per (scenario, Ls).

Scenarios (MCD "dust" codes): 1 climatology, average solar EUV; 5 dust
storm, average solar EUV (a planet-wide storm with dust opacity 5, only
defined for Ls 180-360, NOT the Jan 2022 regional storm); 36 Mars Year 36
(the MCD's best representation of that year, for comparison with MEDA).

Local time: the MCD user manual (v6.1, Table 1) defines the localtime
argument as "the local true solar time at longitude lon, given in martian
hours", and a request for the MCD's own LTST variable returns the hour
axis exactly (checked 2026-11-09). The axis is therefore named
local_time_ltst_h.

The site coordinates come from facts/index.json (jezero.location.landing_site);
nothing about Mars is typed here. Raw ASCII responses are kept under
data/raw/mcd/ (gitignored) and listed with sha256 in the output manifest.

Licence: "Scientific use of the database is freely allowed provided that
the origin of the data is correctly quoted ... This database may not be put
to any commercial use without specific authorization." (LMD access page.)
"""
import hashlib, json, re, sys, time, urllib.parse, urllib.request
from pathlib import Path

ROOT = Path(__file__).resolve().parents[2]
RAW = ROOT / "data" / "raw" / "mcd"
OUT = ROOT / "facts" / "derive" / "out" / "mcd62_jezero.json"
BASE = "https://www-mars.lmd.jussieu.fr/mcd_python/"
CGI = BASE + "cgi-bin/mcdcgi.py"
UA = {"User-Agent": "mars-sandbox-facts-ingest/0.1 (scientific use; contact via repository)"}

SCENARIOS = {
    "clim_ave":  {"dust": 1,  "name": "climatology ave solar", "ls": list(range(0, 360, 30))},
    "storm_ave": {"dust": 5,  "name": "dust storm ave solar",  "ls": list(range(180, 360, 30))},
    "my36":      {"dust": 36, "name": "Martian Year 36",       "ls": list(range(0, 360, 30))},
}
VARS = {
    "t":              {"unit": "K",     "label": "Air temperature at 1.45 m above the local surface", "rms": "rmst"},
    "tsurf":          {"unit": "K",     "label": "Surface temperature", "rms": "rmstsurf"},
    "ps":             {"unit": "Pa",    "label": "Surface pressure (high-resolution mode)", "rms": "rmsps"},
    "fluxsurf_dn_sw": {"unit": "W/m^2", "label": "Incident solar flux on a horizontal surface"},
    "fluxsurf_lw":    {"unit": "W/m^2", "label": "Thermal infrared flux on the surface"},
    "tauref":         {"unit": "1",     "label": "Daily mean dust column visible optical depth"},
}
REQUEST_SETS = [["t", "tsurf", "ps", "fluxsurf_dn_sw"], ["fluxsurf_lw", "tauref", "rmst", "rmstsurf"], ["rmsps"]]
ALTITUDE_M = 1.45


def get(url, binary=False, retries=4):
    for i in range(retries):
        try:
            with urllib.request.urlopen(urllib.request.Request(url, headers=UA), timeout=180) as r:
                data = r.read()
                return data if binary else data.decode("utf-8", "replace")
        except Exception:  # noqa: BLE001
            if i == retries - 1:
                raise
            time.sleep(5 * (i + 1))


def request_profile(lat, lon, ls, dust, variables):
    params = {"datekeyhtml": "1", "ls": str(ls), "localtime": "all", "latitude": f"{lat}", "longitude": f"{lon}",
              "altitude": f"{ALTITUDE_M}", "zkey": "3", "spacecraft": "none", "betatest": "on", "isfixedlt": "off",
              "dust": str(dust), "hrkey": "1", "averaging": "off", "zonmean": "off", "diumean": "off", "animation": "off",
              "animframes": "12", "dpi": "80", "islog": "off", "colorm": "jet", "proj": "cyl", "iswind": "off"}
    for i in range(4):
        params[f"var{i + 1}"] = variables[i] if i < len(variables) else "none"
    url = CGI + "?" + urllib.parse.urlencode(params)
    page = get(url)
    m = re.search(r"href='([^']+\.txt)'", page)
    if not m:
        raise RuntimeError(f"no ASCII link in response for {url}\n{page[-600:]}")
    txt = get(urllib.parse.urljoin(CGI, m.group(1)))
    return url, txt


def parse_ascii(txt):
    """Return {column-2 description: (header lines, hours[], values[])} per block."""
    out = {}
    for block in re.split(r"#{20,}\n(?=### MCD)", txt):
        m = re.search(r"### Column 2 is (.*)", block)
        if not m:
            continue
        rows = [l.split() for l in block.splitlines() if re.match(r"\s*-?[\d.]+e[+-]\d+\s+", l)]
        hours = [float(r[0]) for r in rows]; vals = [float(r[1]) for r in rows]
        header = [l for l in block.splitlines() if l.startswith("###")]
        out[m.group(1).strip()] = (header, hours, vals)
    return out


# the ASCII column labels the interface uses for each variable code (checked against listvar.js)
LABELS = {
    "t": "Temperature (K)", "tsurf": "Surface temperature (K)", "ps": "Surface pressure (Pa)",
    "fluxsurf_dn_sw": "Incident solar flux on horizontal surface (W/m2)", "fluxsurf_lw": "thermal IR flux on surface (W/m2)",
    "tauref": "Daily mean dust column visible optical depth", "rmst": "Temperature RMS day to day variations (K)",
    "rmstsurf": "Surface temperature RMS day to day variations (K)", "rmsps": "Surface pressure RMS day to day variations (Pa)",
}


def main():
    facts = json.loads((ROOT / "facts" / "index.json").read_text())
    site = facts["facts"]["jezero.location.landing_site"]["value"]
    lat, lon = float(site["lat"]), float(site["lon_e"])
    RAW.mkdir(parents=True, exist_ok=True)
    manifest, hours_ref = [], None
    data = {s: {v: {} for v in list(VARS) + ["rmst", "rmstsurf", "rmsps"]} for s in SCENARIOS}
    version = None
    t0 = time.time(); n = 0
    for sname, sc in SCENARIOS.items():
        for ls in sc["ls"]:
            for variables in REQUEST_SETS:
                raw = RAW / f"{sname}_ls{ls:03d}_{'_'.join(variables)}.txt"
                if raw.exists():
                    txt = raw.read_text(); url = (raw.with_suffix(".url")).read_text().strip() if raw.with_suffix(".url").exists() else ""
                else:
                    url, txt = request_profile(lat, lon, ls, sc["dust"], variables)
                    raw.write_text(txt); raw.with_suffix(".url").write_text(url + "\n"); time.sleep(1.0)
                n += 1
                blocks = parse_ascii(txt)
                ver = re.search(r"### (MCD_v[\d.]+) with (.*?) scenario", txt)
                if ver:
                    version = version or ver.group(1)
                    if ver.group(1) != version: raise RuntimeError(f"version changed: {ver.group(1)} vs {version}")
                for v in variables:
                    key = next((k for k in blocks if k.lower().startswith(LABELS[v].lower()[:28])), None)
                    if key is None:
                        raise RuntimeError(f"variable {v} ({LABELS[v]}) not in response {raw.name}: {list(blocks)}")
                    header, hours, vals = blocks[key]
                    if hours_ref is None: hours_ref = hours
                    if hours != hours_ref or len(vals) != len(hours_ref):
                        raise RuntimeError(f"hour axis mismatch in {raw.name} for {v}")
                    data[sname][v][ls] = vals
                manifest.append({"scenario": sname, "dust": sc["dust"], "ls": ls, "variables": variables, "file": str(raw.relative_to(ROOT)),
                                 "url": url, "sha256": hashlib.sha256(txt.encode()).hexdigest(), "bytes": len(txt)})
                if n % 10 == 0:
                    print(f"  {n} requests, {time.time() - t0:.0f} s", flush=True)

    # assemble record-shaped values
    records = {}
    for sname, sc in SCENARIOS.items():
        for v, meta in VARS.items():
            value = {"variable": v, "scenario": {"dust": sc["dust"], "name": sc["name"]},
                     "axes": {"ls_deg": sc["ls"], "local_time_ltst_h": hours_ref},
                     "series": [data[sname][v][ls] for ls in sc["ls"]]}
            if "rms" in meta:
                value["day_to_day_rms"] = [data[sname][meta["rms"]][ls] for ls in sc["ls"]]
            records.setdefault(sname, {})[v] = value
    out = {
        "description": "MCD v6.2 diurnal profiles at the Perseverance landing site, Jezero, from the LMD web interface",
        "source_id": "mcd-lmd", "mcd_version": version, "web_interface": BASE,
        "site": {"lat": lat, "lon_e": lon, "fact_id": "jezero.location.landing_site", "altitude_above_surface_m": ALTITUDE_M, "high_resolution_mode": True},
        "local_time": "local true solar time at the site longitude (MCD user manual v6.1, Table 1); hour axis verified against the MCD loctime variable",
        "scenarios": {s: {"dust": sc["dust"], "name": sc["name"], "ls_deg": sc["ls"]} for s, sc in SCENARIOS.items()},
        "variables": {v: {"unit": m["unit"], "label": m["label"], "rms_variable": m.get("rms")} for v, m in VARS.items()},
        "retrieved_on": time.strftime("%Y-%m-%d"), "requests": len(manifest), "manifest": manifest,
        # as_of should be the MCD 6.2 release date; it is not published on the LMD pages, so the month the
        # values were served by the 6.2 interface is used and the note says so (correct when LMD states it)
        "as_of": time.strftime("%Y-%m"),
        "as_of_note": ("as_of is the month the values were served by the MCD 6.2 interface: the 6.2 release date is not stated on the LMD pages "
                       "(the v6.1 user manual is dated October 2022 and the 6.2 interface serves scenarios through Martian Year 37), so it could not be used; "
                       "to be corrected when LMD states it."),
        "records": records,
        "generated_by": "facts/derive/mcd_fetch.py", "facts_content_hash": facts.get("content_hash"),
    }
    OUT.parent.mkdir(parents=True, exist_ok=True)
    OUT.write_text(json.dumps(out, indent=1) + "\n")
    print(f"wrote {OUT.relative_to(ROOT)}: {version}, {sum(len(v) for v in records.values())} record values, {len(manifest)} requests, {time.time() - t0:.0f} s")
    return 0


if __name__ == "__main__":
    sys.exit(main())
