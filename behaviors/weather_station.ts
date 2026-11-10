// Weather station, built only from the generic host calls (task X1 sample).
// Two shapes (a mast and a panel), two state slots (sols elapsed, reference air
// temperature from the fact base), one signal (code 100: a pulse every Mars hour).
// It reads no rover sensor except TIME and drives nothing: it is not a rover.
//
// Honest limit: there is no live temperature read yet (that is H1), so the
// temperature shown is the MY36 annual mean air temperature at Jezero from
// facts/, tier measured, not the current value.
import { read, fact, fact_tier, spawn, pose, state_set, signal_emit, log, TIME,
         SHAPE_CYLINDER, SHAPE_PANEL, FACT_JEZERO_TEMPERATURE_MY36_AIR_ANNUAL_MEAN, FACT_MARS_TIME_SOL } from "./host";

const SLOT_SOLS: i32 = 0;
const SLOT_T_REF_K: i32 = 1;
const SIGNAL_HOUR: i32 = 100;
const LOG_HOUR: i32 = 30;
let mast: i32 = -1, panel: i32 = -1;
let lastHour: i32 = -1;

export function init(): void {
  mast = spawn(SHAPE_CYLINDER, 0.1, 2.0, 0.1, 0.8, 0.8, 0.8);
  panel = spawn(SHAPE_PANEL, 0.6, 0.4, 0.05, 0.1, 0.3, 0.9);
  pose(mast, 0.0, 1.0, 0.0, 0.0, 0.0);
  pose(panel, 0.0, 2.1, 0.0, 0.0, 0.3);
  state_set(SLOT_T_REF_K, fact(FACT_JEZERO_TEMPERATURE_MY36_AIR_ANNUAL_MEAN));
  log(31, <f32>fact_tier(FACT_JEZERO_TEMPERATURE_MY36_AIR_ANNUAL_MEAN));   // report the tier of what we rest on
}

export function tick(dt: f32): void {
  const t = read(TIME);
  const sol = fact(FACT_MARS_TIME_SOL);                 // seconds per sol, from facts/
  const sols = t / sol;
  state_set(SLOT_SOLS, sols);
  const hour = <i32>Math.floor(sols * 24.0);
  if (hour != lastHour) {
    lastHour = hour;
    signal_emit(SIGNAL_HOUR, <f32>hour);
    log(LOG_HOUR, <f32>hour);
  }
}
