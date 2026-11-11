// The world clock, shared by the page and the tests so both use one definition.
// The page runs a sol in DAY_SECONDS of world time (TIME, sensor key 6); the sun
// elevation is sin(TIME / DAY_SECONDS * 2pi + SUN_PHASE). Local true solar hour
// is defined so that 12 h is the sun's highest elevation.
export const DAY_SECONDS = 240;        // one sol on the page, in world seconds (a 4-minute sol so solar fall-off is watchable)
export const SUN_PHASE = 0.9;          // radians, the page's sun phase at TIME 0

/** Local true solar hour (0..24) at world time t (seconds). */
export function localHour(t, daySeconds = DAY_SECONDS, phase = SUN_PHASE) {
  const turn = (t / daySeconds * 2 * Math.PI + phase - Math.PI / 2) / (2 * Math.PI);   // 0 at local noon
  const frac = turn - Math.floor(turn);
  return (frac * 24 + 12) % 24;
}

/**
 * Interpolate a periodic diurnal table whose values sit at the hour-bin centres
 * in `axis` (0.5, 1.5, ..., 23.5), wrapping across midnight. `hour` is 0..24.
 */
export function interpolateDiurnal(axis, series, hour) {
  const n = axis.length, step = 24 / n;
  const h = ((hour % 24) + 24) % 24;
  let i = Math.floor((h - axis[0]) / step);                    // bin to the left of hour
  if (i < 0) i += n;                                            // before the first centre: wrap to the last bin
  const left = axis[i % n], f = (((h - left) % 24) + 24) % 24 / step;
  return series[i % n] * (1 - f) + series[(i + 1) % n] * f;
}

/** Air temperature now from the hourly record's value object. */
export function airTempFromRecord(value, hour) {
  return interpolateDiurnal(value.axes.local_time_ltst_h, value.series, hour);
}
