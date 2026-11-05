// Behavior: explore, but go back to the charging pad when the battery
// drops under 25 % and leave again once it is above 95 %.
// (sample of the LLM output for
//  "wander around, and return to the charger automatically when low on power")
import { read, drive, set_led, set_arm, log, clamp, wrapAngle,
         BATTERY, CHARGER_DIST, CHARGER_BEARING, OBSTACLE_DIST, OBSTACLE_SIDE, TIME } from "./host";

const LOW: f32 = 0.25, FULL: f32 = 0.95;
const LOG_STATE: i32 = 10;     // 0 explore, 1 returning, 2 charging
const LOG_BATTERY: i32 = 11;

let state: i32 = 0;
let lastReport: f32 = 0;

export function init(): void {
  state = 0;
  set_led(0.0, 1.0, 0.3);
}

export function tick(dt: f32): void {
  const bat = read(BATTERY);
  const t = read(TIME);
  if (t - lastReport > 5.0) { lastReport = t; log(LOG_BATTERY, bat); }

  if (state == 0 && bat < LOW)  { state = 1; log(LOG_STATE, 1); set_led(1.0, 0.8, 0.0); }
  if (state == 1 && read(CHARGER_DIST) < 2.0) { state = 2; log(LOG_STATE, 2); set_led(1.0, 0.0, 0.0); }
  if (state == 2 && bat > FULL) { state = 0; log(LOG_STATE, 0); set_led(0.0, 1.0, 0.3); }

  if (state == 2) {              // parked and charging
    drive(0.0, 0.0);
    set_arm(0.0);
    return;
  }

  let throttle: f32 = 0.8;
  let steer: f32 = 0.0;

  if (state == 1) {              // head for the pad
    steer = clamp(read(CHARGER_BEARING) * 2.0, -1.0, 1.0);
    if (read(CHARGER_DIST) < 6.0) throttle = 0.4;
  } else {                       // explore: slow weave
    steer = <f32>Math.sin(t * 0.3) * 0.5;
    set_arm(0.5 + 0.5 * <f32>Math.sin(t * 2.0));   // wave the arm around
  }

  const od = read(OBSTACLE_DIST);
  if (od < 5.0) { steer = -read(OBSTACLE_SIDE); throttle = 0.4; }

  drive(throttle, steer);
}
