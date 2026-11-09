# MCD 6.2 vs MEDA, Mars Year 36, Jezero

Derived report (facts/derive/mcd_vs_meda.py). Not a fact. MEDA = measured medians from facts/derive/out/meda_my36.json; MCD = web-interface profiles from mcd62_jezero.json.

| scenario | season | p daily mean MCD / MEDA (Pa) | Δ | T min MCD / MEDA (K) | Δ | T max MCD / MEDA (K) | Δ | swing MCD / MEDA (K) | Δ |
|---|---|---|---|---|---|---|---|---|---|
| my36 | spring | 743.1 / 751.4 | -8.3 | 193.0 / 193.2 | -0.3 | 241.3 / 254.4 | -13.1 | 48.3 / 61.0 | -12.6 |
| my36 | summer | 660.7 / 639.9 | +20.8 | 199.5 / 195.3 | +4.2 | 247.8 / 261.9 | -14.1 | 48.4 / 67.6 | -19.3 |
| my36 | autumn | 725.8 / 753.6 | -27.8 | 195.9 / 192.9 | +3.0 | 247.8 / 262.3 | -14.5 | 52.0 / 69.1 | -17.1 |
| my36 | winter | 766.9 / 734.8 | +32.1 | 190.6 / 190.2 | +0.5 | 235.5 / 256.6 | -21.1 | 44.9 / 67.1 | -22.2 |
| my36 | annual | 724.1 / 719.2 | +4.9 | 194.7 / 193.0 | +1.7 | 243.1 / 257.1 | -14.0 | 48.4 / 65.5 | -17.1 |
| clim_ave | spring | 741.8 / 751.4 | -9.6 | 194.1 / 193.2 | +0.9 | 243.5 / 254.4 | -10.9 | 49.4 / 61.0 | -11.6 |
| clim_ave | summer | 661.2 / 639.9 | +21.4 | 197.4 / 195.3 | +2.1 | 247.4 / 261.9 | -14.5 | 50.0 / 67.6 | -17.7 |
| clim_ave | autumn | 724.5 / 753.6 | -29.0 | 196.2 / 192.9 | +3.3 | 249.2 / 262.3 | -13.1 | 53.1 / 69.1 | -16.0 |
| clim_ave | winter | 765.1 / 734.8 | +30.3 | 191.1 / 190.2 | +1.0 | 238.8 / 256.6 | -17.8 | 47.7 / 67.1 | -19.3 |
| clim_ave | annual | 723.2 / 719.2 | +4.0 | 194.7 / 193.0 | +1.7 | 244.7 / 257.1 | -12.3 | 50.0 / 65.5 | -15.5 |

## Caveats

- MEDA values are medians over sols with coverage rules (see meda_my36.json method); MCD values are the mean of the 3 Ls points per quarter from hourly climatological profiles, so sol-to-sol weather is averaged out on the MCD side only.
- MEDA air temperature is the median of three mast sensors at 1.45 m; MCD t is at 1.45 m above the model surface in high-resolution mode.
- MEDA pressure daily means use sols with >= 16 of 24 hours sampled; MCD daily mean is the mean of the 24 hourly values.
- The MCD afternoon air temperature at 1.45 m is 11-21 K below the MEDA median maximum in every season while night minima agree within 1-4 K. Part of this is likely MEDA-side: the median of three mast sensors includes daytime heating of the rover deck and mast, which is why the MEDA papers pick the upwind sensor. Part may be the GCM's near-surface layer. Treat the MCD diurnal swing as a lower bound until an upwind-sensor MEDA statistic exists.
- Seasonal pressure differs by up to +-30 Pa with opposite signs in autumn and winter: the quarter means of three Ls points do not resolve the timing of the CO2-cycle maximum the same way the MEDA sol medians do. Compare at matching Ls before concluding anything about the model.
- This is a report for humans and for tuning the engine's climate model; it is not a fact and nothing here is cited by a record.
