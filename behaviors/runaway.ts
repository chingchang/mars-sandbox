// Behavior: deliberately broken. Drives normally for 3 seconds, then its
// tick() never returns. Exists to show the host's watchdog killing the
// worker and the rover coasting to a stop with the module disabled.
import { read, drive, set_led, log, TIME } from "./host";

let t0: f32 = -1;
export function init(): void { set_led(1.0, 1.0, 1.0); }

export function tick(dt: f32): void {
  const t = read(TIME);
  if (t0 < 0) t0 = t;
  if (t - t0 < 3.0) { drive(1.0, 0.3); return; }
  log(99, 0.0);
  let x: f64 = 0;
  while (true) { x += 1.0; }     // infinite loop: the watchdog must catch this
}
