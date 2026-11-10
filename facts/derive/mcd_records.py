#!/usr/bin/env python3
"""
Write the MCD v6.2 climatology records into facts/jezero_climatology.json
from facts/derive/out/mcd62_jezero.json (task F3). Idempotent: the bundle is
regenerated in full. Every value object is copied from the derivation output
and each record's notes carry `derive: facts/derive/out/mcd62_jezero.json#records.<key>`
which test/facts.test.mjs resolves.

    python -I facts/derive/mcd_records.py
"""
import json, sys
from pathlib import Path

ROOT = Path(__file__).resolve().parents[2]
OUT = ROOT / "facts" / "derive" / "out" / "mcd62_jezero.json"
BUNDLE = ROOT / "facts" / "jezero_climatology.json"
LINK = "facts/derive/out/mcd62_jezero.json"
BUNDLE_VERSION = "0.1.0"

SCENARIO_NOTES = {
    "clim_ave": "MCD 'climatology, average solar EUV' scenario: the LMD GCM forced by the dust climatology reconstructed from Mars Years 24-31, i.e. a standard year without a planet-encircling storm.",
    "storm_ave": "MCD 'dust storm, average solar EUV' scenario: a PLANET-WIDE dust storm with dust opacity fixed at 5 everywhere and darker dust optical properties, defined by the MCD only for Ls 180-360. This is not the January 2022 regional storm at Jezero (tau ~2, jezero.dust.optical_depth_storm_jan2022); for that case scale the climatology through the primitives with the measured tau. Use this scenario for the global-storm survival case.",
    "my36": "MCD 'Martian Year 36' scenario: the MCD's best representation of MY36 (daily dust loading and solar EUV as observed). Included so the climate model can be checked against the MEDA MY36 statistics in jezero.json; see facts/derive/out/mcd_vs_meda_my36.md.",
}


def main():
    s = json.loads(OUT.read_text())
    recs = []
    for scen, byvar in s["records"].items():
        for var, value in byvar.items():
            key = f"{scen}.{var}"
            vmeta, smeta = s["variables"][var], s["scenarios"][scen]
            ls = smeta["ls_deg"]
            has_rms = "day_to_day_rms" in value
            unc = ({"type": "series", "pointer": "value.day_to_day_rms",
                    "note": f"MCD day-to-day RMS variability ({vmeta['rms_variable']}), same shape as series"} if has_rms
                   else {"type": "unstated", "note": "GCM output; the MCD provides no variability estimate for this variable"})
            recs.append({
                "id": f"jezero.climate.mcd62.{scen}.{var}",
                "label": f"{vmeta['label']}, MCD 6.2 {smeta['name']} scenario, diurnal profiles at {len(ls)} Ls",
                "value": value, "unit": vmeta["unit"], "uncertainty": unc,
                "tier": "modeled", "source_ids": ["mcd-lmd", "forget-1999-gcm", "millour-2018-mcd"],
                "as_of": s["as_of"],
                "valid_for": {"site": "jezero", "lat": s["site"]["lat"], "lon_e": s["site"]["lon_e"],
                              "season": f"Ls {ls[0]}-{ls[-1]} in steps of 30 deg ({len(ls)} Ls)"},
                "notes": (f"{SCENARIO_NOTES[scen]} Values from the MCD {s['mcd_version']} web interface in high-resolution mode (32 ppd MOLA topography) at "
                          f"the landing-site coordinates, {s['site']['altitude_above_surface_m']} m above the local surface for air temperature; series[i][j] is at "
                          f"axes.ls_deg[i] and axes.local_time_ltst_h[j] (local true solar time at the site). {s['as_of_note']} Retrieved {s['retrieved_on']}; "
                          f"request URLs and sha256 of each ASCII response in {LINK} (manifest). Licence: scientific use free with citation; commercial use needs LMD authorization; "
                          f"public release of a product built on these values waits on that authorization (see sources.md mcd-lmd). derive: {LINK}#records.{key}"),
            })
    bundle = {
        "bundle": "jezero-climatology", "version": BUNDLE_VERSION,
        "description": ("Modeled diurnal climatology at the Perseverance landing site from the Mars Climate Database v6.2 web interface: "
                        "three scenarios (climatology, planet-wide dust storm, Mars Year 36) x six variables, hourly profiles at 12 solar longitudes. "
                        "These drive the engine's seasons and sky; the measured MY36 records in jezero.json are the check on them."),
        "facts": recs,
    }
    BUNDLE.write_text(json.dumps(bundle, indent=2, ensure_ascii=False) + "\n")
    print(f"wrote {len(recs)} records to {BUNDLE.relative_to(ROOT)}")
    return 0


if __name__ == "__main__":
    sys.exit(main())
