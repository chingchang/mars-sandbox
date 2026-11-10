#!/usr/bin/env python3
"""
Derived report, not facts: compare the MCD v6.2 "Martian Year 36" scenario
(and the climatology) at Jezero with the MEDA MY36 statistics in
facts/derive/out/meda_my36.json. Writes facts/derive/out/mcd_vs_meda_my36.json
and .md. Season = Ls quarter, as in meda_my36.py; MCD values per season are
the mean over the Ls points in that quarter (3 of the 12).

    python -I facts/derive/mcd_vs_meda.py
"""
import json, sys
from pathlib import Path
import numpy as np

ROOT = Path(__file__).resolve().parents[2]
OUT = ROOT / "facts" / "derive" / "out"
SEASONS = [("spring", 0, 90), ("summer", 90, 180), ("autumn", 180, 270), ("winter", 270, 360)]


def main():
    mcd = json.loads((OUT / "mcd62_jezero.json").read_text())
    meda = json.loads((OUT / "meda_my36.json").read_text())
    rows, report = [], {"description": __doc__.strip(), "mcd_version": mcd["mcd_version"], "comparisons": []}
    for scen in ("my36", "clim_ave"):
        ls = mcd["records"][scen]["ps"]["axes"]["ls_deg"]
        ps = np.array(mcd["records"][scen]["ps"]["series"]); t = np.array(mcd["records"][scen]["t"]["series"])
        # diurnal profiles have 25 points with hour 24 == hour 0; drop the duplicate for means
        ps_m, t_m = ps[:, :24], t[:, :24]
        for name, lo, hi in SEASONS:
            sel = [i for i, l in enumerate(ls) if lo <= l < hi]
            mp, mt = meda["pressure_pa"]["by_season"][name], meda["air_temperature_k"]["by_season"][name]
            c = {"scenario": scen, "season": name, "ls_points": [ls[i] for i in sel],
                 "pressure_daily_mean_pa": {"mcd": float(ps_m[sel].mean()), "meda_p50": mp["daily_mean_p50"]},
                 "air_t_min_k": {"mcd": float(t_m[sel].min(axis=1).mean()), "meda_p50": mt["min_p10_p50_p90"][1]},
                 "air_t_max_k": {"mcd": float(t_m[sel].max(axis=1).mean()), "meda_p50": mt["max_p10_p50_p90"][1]},
                 "air_t_swing_k": {"mcd": float((t_m[sel].max(axis=1) - t_m[sel].min(axis=1)).mean()), "meda_p50": mt["swing_p50"]}}
            for k in ("pressure_daily_mean_pa", "air_t_min_k", "air_t_max_k", "air_t_swing_k"):
                c[k]["mcd_minus_meda"] = c[k]["mcd"] - c[k]["meda_p50"]
            report["comparisons"].append(c); rows.append(c)
        ann = {"scenario": scen, "season": "annual",
               "pressure_daily_mean_pa": {"mcd": float(ps_m.mean()), "meda_p50": meda["pressure_pa"]["annual"]["mean_of_daily_means"]},
               "air_t_min_k": {"mcd": float(t_m.min(axis=1).mean()), "meda_p50": meda["air_temperature_k"]["diurnal"]["min_p10_p50_p90"][1]},
               "air_t_max_k": {"mcd": float(t_m.max(axis=1).mean()), "meda_p50": meda["air_temperature_k"]["diurnal"]["max_p10_p50_p90"][1]},
               "air_t_swing_k": {"mcd": float((t_m.max(axis=1) - t_m.min(axis=1)).mean()), "meda_p50": meda["air_temperature_k"]["diurnal"]["swing_p10_p50_p90"][1]}}
        for k in ("pressure_daily_mean_pa", "air_t_min_k", "air_t_max_k", "air_t_swing_k"):
            ann[k]["mcd_minus_meda"] = ann[k]["mcd"] - ann[k]["meda_p50"]
        report["comparisons"].append(ann); rows.append(ann)
    report["caveats"] = [
        "MEDA values are medians over sols with coverage rules (see meda_my36.json method); MCD values are the mean of the 3 Ls points per quarter from hourly climatological profiles, so sol-to-sol weather is averaged out on the MCD side only.",
        "MEDA air temperature is the median of three mast sensors at 1.45 m; MCD t is at 1.45 m above the model surface in high-resolution mode.",
        "MEDA pressure daily means use sols with >= 16 of 24 hours sampled; MCD daily mean is the mean of the 24 hourly values.",
        "The MCD afternoon air temperature at 1.45 m is 11-21 K below the MEDA median maximum in every season while night minima agree within 1-4 K. Part of this is likely MEDA-side: the median of three mast sensors includes daytime heating of the rover deck and mast, which is why the MEDA papers pick the upwind sensor. Part may be the GCM's near-surface layer. Treat the MCD diurnal swing as a lower bound until an upwind-sensor MEDA statistic exists.",
        "Seasonal pressure differs by up to +-30 Pa with opposite signs in autumn and winter: the quarter means of three Ls points do not resolve the timing of the CO2-cycle maximum the same way the MEDA sol medians do. Compare at matching Ls before concluding anything about the model.",
        "This is a report for humans and for tuning the engine's climate model; it is not a fact and nothing here is cited by a record.",
    ]
    (OUT / "mcd_vs_meda_my36.json").write_text(json.dumps(report, indent=1) + "\n")
    md = ["# MCD 6.2 vs MEDA, Mars Year 36, Jezero", "", "Derived report (facts/derive/mcd_vs_meda.py). Not a fact. MEDA = measured medians from facts/derive/out/meda_my36.json; MCD = web-interface profiles from mcd62_jezero.json.", "",
          "| scenario | season | p daily mean MCD / MEDA (Pa) | Δ | T min MCD / MEDA (K) | Δ | T max MCD / MEDA (K) | Δ | swing MCD / MEDA (K) | Δ |", "|---|---|---|---|---|---|---|---|---|---|"]
    for c in rows:
        f = lambda k: f"{c[k]['mcd']:.1f} / {c[k]['meda_p50']:.1f} | {c[k]['mcd_minus_meda']:+.1f}"
        md.append(f"| {c['scenario']} | {c['season']} | {f('pressure_daily_mean_pa')} | {f('air_t_min_k')} | {f('air_t_max_k')} | {f('air_t_swing_k')} |")
    md += ["", "## Caveats", ""] + [f"- {x}" for x in report["caveats"]]
    (OUT / "mcd_vs_meda_my36.md").write_text("\n".join(md) + "\n")
    print("\n".join(md[:4] + md[4:]))
    return 0


if __name__ == "__main__":
    sys.exit(main())
