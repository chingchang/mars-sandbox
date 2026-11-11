#!/usr/bin/env python3
"""
Derive the Jezero surface-pressure and air-temperature statistics for Mars
Year 36 from the MEDA products fetched by meda_fetch.py (task F2).

    python -I facts/derive/meda_my36.py            # writes facts/derive/out/meda_my36.json

Inputs (data/raw/meda/manifest.json): DER_PS (derived pressure, 1 Hz,
column PRESSURE in Pa, empty where unreliable) and CAL_ATS (calibrated air
temperature, 2 Hz, ATS_LOCAL_TEMP1..3 on the mast at 1.45 m, TEMP4..5 on
the deck). Air temperature at 1.45 m is taken as the median of the three
mast sensors per sample; MEDA papers pick the upwind sensor, which needs
wind data; the median is a documented, reproducible choice that limits
rover-heating bias from any single sensor.

Per sol: samples are binned by local true solar time (LTST) into 24 hours.
MEDA runs in sessions, so coverage is partial; a sol contributes to a
diurnal minimum only if it has samples in the pre-dawn hours 3-6 LTST, and
to a maximum only if it has samples in hours 12-15 LTST (where the extremes
fall). Daily means use the mean of the hourly means over the hours sampled,
and are only kept for sols with at least 16 of 24 hours sampled, so a sol
sampled only at night does not bias the annual mean.

Samples equal to the fill value 999999999 (present in DER_PS sol 259; the
label declares no missing constant) are dropped and counted as n_fill.

Seasons are Ls quarters: 0-90 northern spring, 90-180 summer, 180-270
autumn, 270-360 winter. Percentiles are over sols. Nothing here is a model;
every number is a statistic of the archive, and the JSON records which
sols and product versions produced it. A per-sol cache in
facts/derive/out/meda_my36_sols.json makes re-runs fast; delete it to
recompute from raw.
"""
import json, sys, time
from pathlib import Path
import numpy as np

ROOT = Path(__file__).resolve().parents[2]
RAW = ROOT / "data" / "raw" / "meda"
OUT = ROOT / "facts" / "derive" / "out"
SEASONS = [("spring", 0, 90), ("summer", 90, 180), ("autumn", 180, 270), ("winter", 270, 360)]
MIN_HOURS, MIN_HRS, MAX_HRS = (3, 4, 5, 6), (3, 4, 5, 6), (12, 13, 14, 15)
MIN_HOURS_FOR_MEAN = 16


def ltst_hours(col: np.ndarray) -> np.ndarray:
    """'0099 23:56:47' -> hour-of-sol as float (sol prefix dropped)."""
    hms = np.char.partition(col.astype(str), " ")[:, 2]
    h = np.char.partition(hms, ":"); m = np.char.partition(h[:, 2], ":")
    return h[:, 0].astype(float) + m[:, 0].astype(float) / 60 + m[:, 2].astype(float) / 3600


def load_csv(path: Path, cols):
    data = np.genfromtxt(path, delimiter=",", names=True, dtype=None, encoding="utf-8", usecols=cols, missing_values="", filling_values=np.nan)
    return data


FILL = 999999999.0   # seen in DER_PS sol 259 (PRESSURE column); the label declares no missing constant


def sol_stats(values: np.ndarray, hours: np.ndarray) -> dict:
    fill = np.isfinite(values) & (values >= FILL)
    ok = np.isfinite(values) & ~fill
    values, hours = values[ok], hours[ok]
    if values.size == 0:
        return {"n": 0, "n_fill": int(fill.sum())}
    hb = np.floor(hours).astype(int) % 24
    sampled = sorted(set(hb.tolist()))
    hourly = {int(h): float(values[hb == h].mean()) for h in sampled}
    out = {"n": int(values.size), "n_fill": int(fill.sum()), "hours_sampled": sampled, "hourly_mean": hourly,
           "min": float(values.min()), "max": float(values.max()),
           "t_min": float(hours[values.argmin()]), "t_max": float(hours[values.argmax()])}
    if len(sampled) >= MIN_HOURS_FOR_MEAN:
        out["mean"] = float(np.mean(list(hourly.values())))
    out["has_min_window"] = any(h in hourly for h in MIN_HRS)
    out["has_max_window"] = any(h in hourly for h in MAX_HRS)
    return out


def per_sol(manifest: dict) -> dict:
    cache = OUT / "meda_my36_sols.json"
    if cache.exists():
        return json.loads(cache.read_text())
    by_sol = {}
    products = manifest["products"]
    t0 = time.time()
    for i, p in enumerate(products):
        path = ROOT / p["file"]
        rec = by_sol.setdefault(str(p["sol"]), {"sol": p["sol"], "ls": p["ls_start"]})
        if p["kind"] == "DER_PS":
            d = load_csv(path, (2, 3))
            rec["ps"] = sol_stats(d["PRESSURE"].astype(float), ltst_hours(d["LTST"]))
            rec["ps"]["product"] = {"lid": p["lid"], "version": p["version_id"], "sha256": p["sha256"]}
        elif p["kind"] == "CAL_ATS":
            d = load_csv(path, (2, 3, 4, 5))
            t = np.nanmedian(np.vstack([d["ATS_LOCAL_TEMP1"], d["ATS_LOCAL_TEMP2"], d["ATS_LOCAL_TEMP3"]]).astype(float), axis=0)
            rec["ats"] = sol_stats(t, ltst_hours(d["LTST"]))
            rec["ats"]["product"] = {"lid": p["lid"], "version": p["version_id"], "sha256": p["sha256"]}
        if (i + 1) % 100 == 0:
            print(f"  {i + 1}/{len(products)} products, {time.time() - t0:.0f} s", flush=True)
    OUT.mkdir(parents=True, exist_ok=True)
    cache.write_text(json.dumps(by_sol) + "\n")
    return by_sol


def pct(a, q):
    return float(np.percentile(np.asarray(a, dtype=float), q)) if len(a) else None


def summarise(by_sol: dict, key: str) -> dict:
    sols = sorted(by_sol.values(), key=lambda r: r["sol"])
    rows = [r for r in sols if key in r and r[key].get("n", 0) > 0]
    means = [r for r in rows if "mean" in r[key]]
    mins = [r for r in rows if r[key]["has_min_window"]]
    maxs = [r for r in rows if r[key]["has_max_window"]]
    swings = [r for r in rows if r[key]["has_min_window"] and r[key]["has_max_window"]]
    def season_of(ls): return next(n for n, lo, hi in SEASONS if lo <= ls < hi)
    out = {
        "sols_with_data": [r["sol"] for r in rows], "n_sols": len(rows),
        "fill_samples_dropped": {str(r["sol"]): r[key]["n_fill"] for r in rows if r[key].get("n_fill")},
        "annual": {
            "n_sols_for_mean": len(means),
            "mean_of_daily_means": float(np.mean([r[key]["mean"] for r in means])) if means else None,
            "daily_mean_min": min(((r[key]["mean"], r["sol"], r["ls"]) for r in means), default=None),
            "daily_mean_max": max(((r[key]["mean"], r["sol"], r["ls"]) for r in means), default=None),
            "absolute_min": min(((r[key]["min"], r["sol"], r["ls"]) for r in mins), default=None),
            "absolute_max": max(((r[key]["max"], r["sol"], r["ls"]) for r in maxs), default=None),
        },
        "diurnal": {
            "n_sols_min": len(mins), "n_sols_max": len(maxs), "n_sols_swing": len(swings),
            "min_p10_p50_p90": [pct([r[key]["min"] for r in mins], q) for q in (10, 50, 90)],
            "max_p10_p50_p90": [pct([r[key]["max"] for r in maxs], q) for q in (10, 50, 90)],
            "swing_p10_p50_p90": [pct([r[key]["max"] - r[key]["min"] for r in swings], q) for q in (10, 50, 90)],
            "t_min_median_ltst": pct([r[key]["t_min"] for r in mins], 50),
            "t_max_median_ltst": pct([r[key]["t_max"] for r in maxs], 50),
        },
        "by_season": {},
    }
    for name, lo, hi in SEASONS:
        sm = [r for r in mins if lo <= r["ls"] < hi]; sx = [r for r in maxs if lo <= r["ls"] < hi]; sw = [r for r in swings if lo <= r["ls"] < hi]
        smean = [r for r in means if lo <= r["ls"] < hi]
        out["by_season"][name] = {
            "ls": [lo, hi], "n_sols_min": len(sm), "n_sols_max": len(sx), "n_sols_mean": len(smean),
            "min_p10_p50_p90": [pct([r[key]["min"] for r in sm], q) for q in (10, 50, 90)],
            "max_p10_p50_p90": [pct([r[key]["max"] for r in sx], q) for q in (10, 50, 90)],
            "swing_p50": pct([r[key]["max"] - r[key]["min"] for r in sw], 50),
            "daily_mean_p50": pct([r[key]["mean"] for r in smean], 50),
        }
    return out


def selftest():
    """Synthetic sol: a cosine with minimum at 05:00 and maximum at 15:00, sampled only in some hours."""
    hours = np.arange(0, 24, 1 / 60)
    values = 220 + 30 * np.cos((hours - 15) / 24 * 2 * np.pi)
    full = sol_stats(values, hours)
    assert abs(full["t_min"] - 3.0) < 0.02 and abs(full["t_max"] - 15.0) < 0.02, full      # cos min 12 h before max
    assert full["has_min_window"] and full["has_max_window"] and "mean" in full and abs(full["mean"] - 220) < 0.1
    night = (hours >= 20) | (hours < 2)
    part = sol_stats(values[night], hours[night])
    assert not part["has_min_window"] and not part["has_max_window"] and "mean" not in part, part
    gaps = np.isfinite(values) & ~((hours >= 3) & (hours < 7))
    nomin = sol_stats(values[gaps], hours[gaps])
    assert not nomin["has_min_window"] and nomin["has_max_window"] and "mean" in nomin, nomin
    assert ltst_hours(np.array(["0099 23:56:47", "0100 12:30:00"])).round(4).tolist() == [23.9464, 12.5]
    by_sol = {"1": {"sol": 1, "ls": 10.0, "ps": {**full, "mean": 700.0}}, "2": {"sol": 2, "ls": 100.0, "ps": {**part}},
              "3": {"sol": 3, "ls": 200.0, "ps": {**full, "mean": 720.0, "min": 690.0, "max": 740.0}}}
    sm = summarise(by_sol, "ps")
    assert sm["n_sols"] == 3 and sm["annual"]["n_sols_for_mean"] == 2 and sm["annual"]["mean_of_daily_means"] == 710.0
    assert sm["annual"]["daily_mean_max"][1] == 3 and sm["diurnal"]["n_sols_swing"] == 2
    assert sm["by_season"]["autumn"]["daily_mean_p50"] == 720.0 and sm["by_season"]["summer"]["n_sols_min"] == 0
    hc = hourly_curve(by_sol, "ps")
    assert len(hc["series"]) == 24 and hc["axes"]["local_time_ltst_h"][0] == 0.5 and hc["axes"]["local_time_ltst_h"][23] == 23.5 and hc["n_sols"][12] == 2 and hc["n_sols"][20] == 3
    assert abs(hc["series"][15] - full["hourly_mean"][15]) < 0.01, "sol 1 and 3 share the same profile; sol 2 only has night hours (values rounded to 0.01)"
    assert hc["day_to_day_rms"][15] == 0.0 and hc["n_sols"][15] == 2
    print("selftest ok")
    return 0


def hourly_curve(by_sol: dict, key: str) -> dict:
    """Typical-day curve: for each local true solar hour bin [h, h+1), the mean over sols of that
    sol's bin mean, and the spread (standard deviation) across sols. All seasons pooled; a sol
    contributes to a bin only if it sampled it. Values sit at the bin centres (0.5 ... 23.5) and the
    table is periodic."""
    rows = [r for r in by_sol.values() if key in r and r[key].get("n", 0) > 0]
    means, spread, n_sols = [], [], []
    for h in range(24):
        vals = [r[key]["hourly_mean"][str(h)] if str(h) in r[key]["hourly_mean"] else r[key]["hourly_mean"].get(h) for r in rows]
        vals = [v for v in vals if v is not None]
        means.append(float(np.mean(vals))); spread.append(float(np.std(vals))); n_sols.append(len(vals))
    return {"variable": "t_air_1p45m", "axes": {"local_time_ltst_h": [h + 0.5 for h in range(24)]}, "series": [round(v, 2) for v in means],
            "day_to_day_rms": [round(v, 2) for v in spread], "n_sols": n_sols,
            "method": "mean over MY36 sols of each sol's hourly mean in the LTST bin [h, h+1); each value sits at the bin centre h+0.5; the table is periodic (interpolate between 23.5 and 0.5 across midnight); day_to_day_rms is the standard deviation across sols"}


def main():
    if "--selftest" in sys.argv:
        return selftest()
    manifest = json.loads((RAW / "manifest.json").read_text())
    by_sol = per_sol(manifest)
    versions = sorted({(p["kind"], p["version_id"]) for p in manifest["products"]})
    summary = {
        "description": "MEDA Mars Year 36 surface pressure and 1.45 m air temperature statistics at Jezero",
        "source_id": "meda-pds-archive",
        "bundle": manifest["bundle"], "bundle_version": manifest["bundle_version"], "base_url": manifest["base_url"],
        "fetched_on": manifest["fetched_on"], "mars_year": 36,
        "sol_range": [manifest["sols"][0], manifest["sols"][-1]],
        "ls_range": [by_sol[str(manifest["sols"][0])]["ls"], by_sol[str(manifest["sols"][-1])]["ls"]],
        "product_versions": [f"{k} v{v}" for k, v in versions],
        "method": __doc__.strip(),
        "pressure_pa": summarise(by_sol, "ps"),
        "air_temperature_k": {**summarise(by_sol, "ats"), "hourly_record": hourly_curve(by_sol, "ats")},
        "generated_by": "facts/derive/meda_my36.py", "generated_on": time.strftime("%Y-%m-%d"),
    }
    OUT.mkdir(parents=True, exist_ok=True)
    (OUT / "meda_my36.json").write_text(json.dumps(summary, indent=1) + "\n")
    p, t = summary["pressure_pa"], summary["air_temperature_k"]
    print(f"pressure: {p['n_sols']} sols; annual mean {p['annual']['mean_of_daily_means']:.1f} Pa; daily means {p['annual']['daily_mean_min'][0]:.1f}..{p['annual']['daily_mean_max'][0]:.1f}; swing p50 {p['diurnal']['swing_p10_p50_p90'][1]:.1f}")
    hc = t["hourly_record"]; print(f"air T hourly curve: min {min(hc['series']):.1f} K at {hc['series'].index(min(hc['series']))} h, max {max(hc['series']):.1f} K at {hc['series'].index(max(hc['series']))} h; spread {min(hc['day_to_day_rms']):.1f}-{max(hc['day_to_day_rms']):.1f} K")
    print(f"air T: {t['n_sols']} sols; annual mean {t['annual']['mean_of_daily_means']:.1f} K; min p50 {t['diurnal']['min_p10_p50_p90'][1]:.1f}; max p50 {t['diurnal']['max_p10_p50_p90'][1]:.1f}; swing p50 {t['diurnal']['swing_p10_p50_p90'][1]:.1f}")
    for s, v in t["by_season"].items():
        print(f"  {s:7s} Ls {v['ls']}: T min p50 {v['min_p10_p50_p90'][1]} max p50 {v['max_p10_p50_p90'][1]} ({v['n_sols_min']}/{v['n_sols_max']} sols); p daily mean p50 {p['by_season'][s]['daily_mean_p50']}")
    return 0


if __name__ == "__main__":
    sys.exit(main())
