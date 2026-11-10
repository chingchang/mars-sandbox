// Behavior: deliberately hostile. Sends NaN and Infinity through every
// actuator and into host memory every tick. The host must treat every
// non-finite argument as 0 (or ignore the call) so nothing non-finite ever
// reaches the world. Exists for test/runtime.test.mjs; it is not in the UI.
import { read, drive, set_arm, set_led, log, mem_set, TIME } from "./host";

let nan: f32 = 0.0;
let inf: f32 = 1.0;

export function init(): void {
  nan = <f32>(0.0 / 0.0);          // NaN
  inf = <f32>(1.0 / 0.0);          // +Infinity
  set_led(nan, 0.0, 0.0);
}

export function tick(dt: f32): void {
  read(TIME);
  drive(nan, inf);
  set_arm(-inf);
  set_led(nan, inf, -inf);
  mem_set(0, inf);
  mem_set(1, nan);
  log(7, nan);
  log(8, 1.0);                      // a finite log must still arrive
}
