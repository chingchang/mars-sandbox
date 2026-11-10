// Weather station, built only from the generic host calls (X1 sample, extended
// in L1 with the live read). Two shapes (a mast and a panel) plus a red flag
// when it is cold; state slots: sols elapsed, air temperature now, flag; one
// signal (code 100: a pulse every Mars hour). It drives nothing.
//
// ENV_AIR_TEMP_K is the typical temperature for the current hour over one
// measured Mars year (Perseverance MEDA, MY36): not today's weather. The
// flag threshold, 203.15 K (-70 C), is the player's choice from the prompt,
// not a fact about Mars.
import { read, fact, fact_tier, spawn, pose, remove, state_set, signal_emit, log, TIME, ENV_AIR_TEMP_K,
         SHAPE_CYLINDER, SHAPE_PANEL, SHAPE_CONE, FACT_MARS_TIME_SOL, FACT_JEZERO_TEMPERATURE_MY36_AIR_HOURLY_MEAN } from "./host";

const SLOT_SOLS: i32 = 0;
const SLOT_T_NOW_K: i32 = 1;
const SLOT_FLAG: i32 = 2;
const SIGNAL_HOUR: i32 = 100;
const LOG_HOUR: i32 = 30;          // value: air temperature at that hour (K)
const LOG_TIER: i32 = 31;
const LOG_FLAG: i32 = 32;          // value: 1 up, 0 down
const COLD_K: f32 = 203.15;        // -70 C, from the player's request
let mast: i32 = -1, panel: i32 = -1, flag: i32 = -1;
let lastHour: i32 = -1;
let flagUp: i32 = -1;

export function init(): void {
  mast = spawn(SHAPE_CYLINDER, 0.1, 2.0, 0.1, 0.8, 0.8, 0.8);
  panel = spawn(SHAPE_PANEL, 0.6, 0.4, 0.05, 0.1, 0.3, 0.9);
  pose(mast, 0.0, 1.0, 0.0, 0.0, 0.0);
  pose(panel, 0.0, 2.1, 0.0, 0.0, 0.3);
  // fact_tier of the record behind the live read: what the inspector should show
  log(LOG_TIER, <f32>fact_tier(FACT_JEZERO_TEMPERATURE_MY36_AIR_HOURLY_MEAN));
}

export function tick(dt: f32): void {
  const t = read(TIME);
  const temp = read(ENV_AIR_TEMP_K);
  const sol = fact(FACT_MARS_TIME_SOL);                 // seconds per sol, from facts/
  const sols = t / sol;
  state_set(SLOT_SOLS, sols);
  state_set(SLOT_T_NOW_K, temp);
  const hour = <i32>Math.floor(sols * 24.0);
  if (hour != lastHour) {
    lastHour = hour;
    signal_emit(SIGNAL_HOUR, <f32>hour);
    log(LOG_HOUR, temp);                                 // the hourly temperature log
  }
  const cold: i32 = temp < COLD_K ? 1 : 0;
  if (cold != flagUp) {
    flagUp = cold;
    state_set(SLOT_FLAG, <f32>cold);
    if (flag >= 0) { remove(flag); flag = -1; }
    if (cold == 1) { flag = spawn(SHAPE_CONE, 0.5, 0.6, 0.5, 1.0, 0.1, 0.1); pose(flag, 0.0, 2.6, 0.0, 0.0, 0.0); }
    log(LOG_FLAG, <f32>cold);
  }
}
