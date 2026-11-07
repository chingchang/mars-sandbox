#!/usr/bin/env python3
"""
Write the Mars Year 36 MEDA records into facts/jezero.json from
facts/derive/out/meda_my36.json (task F2). Idempotent: existing records whose
id contains ".my36_" are replaced; the records they supersede get
`superseded_by`. Every value is copied from the derivation output, never
typed, and each record's notes carry a machine-checkable link
`derive: facts/derive/out/meda_my36.json#<json.path>` that
test/facts.test.mjs resolves and compares to the stored value.

    python -I facts/derive/meda_records.py
"""
import json, sys
from pathlib import Path

ROOT = Path(__file__).resolve().parents[2]
OUT = ROOT / "facts" / "derive" / "out" / "meda_my36.json"
BUNDLE = ROOT / "facts" / "jezero.json"
LINK = "facts/derive/out/meda_my36.json"


def get(d, path):
    cur = d
    for part in path.replace("]", "").split("."):
        for key in part.split("["):
            cur = cur[int(key)] if isinstance(cur, list) else cur[key]
    return cur


def main():
    s = json.loads(OUT.read_text())
    p, t = s["pressure_pa"], s["air_temperature_k"]
    sol_lo, sol_hi = s["sol_range"]
    base = {"tier": "measured", "source_ids": ["meda-pds-archive"], "as_of": "2022-12",
            "valid_for": {"site": "jezero", "lat": 18.44, "lon_e": 77.45, "season": "MY36, Ls %.1f-%.1f" % tuple(s["ls_range"])}}
    prov = (f" MEDA bundle v{s['bundle_version']}, products {', '.join(s['product_versions'])}, sols {sol_lo}-{sol_hi}; "
            f"statistic of the archive computed by facts/derive/meda_my36.py (method in {LINK}).")
    r1 = lambda x: round(x, 1)

    def rec(id_, label, value, unit, unc, path, notes, instrument, extra=None):
        return {"id": id_, "label": label, "value": value, "unit": unit, "uncertainty": unc, **base, "instrument": instrument,
                **(extra or {}), "notes": f"{notes}{prov} derive: {LINK}#{path}"}

    PS, ATS = "Perseverance MEDA PS (derived level, barocap 3)", "Perseverance MEDA ATS (calibrated level, median of the three mast sensors at 1.45 m)"
    pa, ta, pd_, td = p["annual"], t["annual"], p["diurnal"], t["diurnal"]
    records = [
        rec("jezero.pressure.my36_daily_mean", "Surface pressure, MY36 mean of daily means",
            r1(pa["mean_of_daily_means"]), "Pa",
            {"type": "range", "low": r1(pa["daily_mean_min"][0]), "high": r1(pa["daily_mean_max"][0]),
             "note": f"range of the daily means over the year (seasonal CO2 cycle); min on sol {pa['daily_mean_min'][1]} (Ls {pa['daily_mean_min'][2]:.0f}), max on sol {pa['daily_mean_max'][1]} (Ls {pa['daily_mean_max'][2]:.0f}); {pa['n_sols_for_mean']} sols with >=16 of 24 hours sampled"},
            "pressure_pa.annual.mean_of_daily_means",
            f"Replaces the placeholder envelope. Absolute 1 Hz extremes over the year: {r1(pa['absolute_min'][0])} Pa (sol {pa['absolute_min'][1]}) to {r1(pa['absolute_max'][0])} Pa (sol {pa['absolute_max'][1]}).", PS),
        rec("jezero.pressure.my36_diurnal_swing", "Surface pressure, typical daily swing (max - min within a sol)",
            r1(pd_["swing_p10_p50_p90"][1]), "Pa",
            {"type": "range", "low": r1(pd_["swing_p10_p50_p90"][0]), "high": r1(pd_["swing_p10_p50_p90"][2]), "note": f"10th-90th percentile over {pd_['n_sols_swing']} sols with both pre-dawn and afternoon coverage"},
            "pressure_pa.diurnal.swing_p10_p50_p90[1]",
            f"Median over sols. Daily minimum typically near {pd_['t_min_median_ltst']:.1f} LTST, maximum near {pd_['t_max_median_ltst']:.1f} LTST (thermal tide).", PS),
        rec("jezero.pressure.my36_daily_mean_by_season", "Surface pressure, median daily mean by season",
            {k: {"ls": v["ls"], "daily_mean_p50_pa": r1(v["daily_mean_p50"]), "n_sols": v["n_sols_mean"]} for k, v in p["by_season"].items()}, "Pa",
            {"type": "categorical", "note": "per-season medians of the daily means; seasons are Ls quarters"},
            "pressure_pa.by_season",
            "Structured companion to jezero.pressure.my36_daily_mean for the climate model.", PS),
        rec("jezero.temperature.my36_air_annual_mean", "Air temperature at 1.45 m, MY36 mean of daily means",
            r1(ta["mean_of_daily_means"]), "K",
            {"type": "range", "low": r1(ta["daily_mean_min"][0]), "high": r1(ta["daily_mean_max"][0]), "note": f"range of the daily means over the year; {ta['n_sols_for_mean']} sols with >=16 of 24 hours sampled"},
            "air_temperature_k.annual.mean_of_daily_means",
            "Replaces the press-release value.", ATS, {"display_unit": "%.0f °C" % (ta["mean_of_daily_means"] - 273.15)}),
        rec("jezero.temperature.my36_air_diurnal_min", "Air temperature at 1.45 m, typical nightly minimum",
            r1(td["min_p10_p50_p90"][1]), "K",
            {"type": "range", "low": r1(td["min_p10_p50_p90"][0]), "high": r1(td["min_p10_p50_p90"][2]), "note": f"10th-90th percentile of sol minima over {td['n_sols_min']} sols with pre-dawn (03-07 LTST) coverage"},
            "air_temperature_k.diurnal.min_p10_p50_p90[1]",
            f"Replaces the placeholder value. Minimum typically near {td['t_min_median_ltst']:.1f} LTST.", ATS, {"display_unit": "%.0f °C" % (td["min_p10_p50_p90"][1] - 273.15)}),
        rec("jezero.temperature.my36_air_diurnal_max", "Air temperature at 1.45 m, typical afternoon maximum",
            r1(td["max_p10_p50_p90"][1]), "K",
            {"type": "range", "low": r1(td["max_p10_p50_p90"][0]), "high": r1(td["max_p10_p50_p90"][2]), "note": f"10th-90th percentile of sol maxima over {td['n_sols_max']} sols with afternoon (12-16 LTST) coverage"},
            "air_temperature_k.diurnal.max_p10_p50_p90[1]",
            f"Replaces the placeholder value. Maximum typically near {td['t_max_median_ltst']:.1f} LTST. Ground temperature (TIRS) runs hotter at midday; this is air at 1.45 m.", ATS, {"display_unit": "%.0f °C" % (td["max_p10_p50_p90"][1] - 273.15)}),
        rec("jezero.temperature.my36_air_diurnal_swing", "Air temperature at 1.45 m, typical day-night swing",
            r1(td["swing_p10_p50_p90"][1]), "K",
            {"type": "range", "low": r1(td["swing_p10_p50_p90"][0]), "high": r1(td["swing_p10_p50_p90"][2]), "note": f"10th-90th percentile over {td['n_sols_swing']} sols with both windows covered"},
            "air_temperature_k.diurnal.swing_p10_p50_p90[1]",
            "Replaces the press-release value. This swing, not the mean, is what an unheated structure must bridge every sol.", ATS),
        rec("jezero.temperature.my36_air_diurnal_by_season", "Air temperature at 1.45 m, typical nightly minimum and afternoon maximum by season",
            {k: {"ls": v["ls"], "min_p50_k": r1(v["min_p10_p50_p90"][1]), "max_p50_k": r1(v["max_p10_p50_p90"][1]), "swing_p50_k": r1(v["swing_p50"]), "n_sols": [v["n_sols_min"], v["n_sols_max"]]} for k, v in t["by_season"].items()}, "K",
            {"type": "categorical", "note": "per-season medians of sol minima/maxima; seasons are Ls quarters"},
            "air_temperature_k.by_season",
            "Structured companion to the diurnal records for the climate model.", ATS),
    ]
    supersede = {
        "jezero.pressure.annual_envelope": "jezero.pressure.my36_daily_mean",
        "jezero.temperature.air_annual_mean": "jezero.temperature.my36_air_annual_mean",
        "jezero.temperature.air_diurnal_min_typical": "jezero.temperature.my36_air_diurnal_min",
        "jezero.temperature.air_diurnal_max_typical": "jezero.temperature.my36_air_diurnal_max",
        "jezero.temperature.diurnal_range_typical": "jezero.temperature.my36_air_diurnal_swing",
    }
    bundle = json.loads(BUNDLE.read_text())
    bundle["facts"] = [f for f in bundle["facts"] if ".my36_" not in f["id"]]
    for f in bundle["facts"]:
        if f["id"] in supersede:
            f["superseded_by"] = supersede[f["id"]]
    bundle["facts"].extend(records)
    BUNDLE.write_text(json.dumps(bundle, indent=2, ensure_ascii=False) + "\n")
    print(f"wrote {len(records)} MY36 records into {BUNDLE.relative_to(ROOT)}; superseded {len(supersede)}")
    return 0


if __name__ == "__main__":
    sys.exit(main())
