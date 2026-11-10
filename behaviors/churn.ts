// Spawns one shape and removes it every tick, forever, and logs the handle it
// got. With handle reuse this must keep working with at most one live shape;
// without it, spawn would return -1 after 32 ticks. For test/hostapi.test.mjs.
import { read, spawn, remove, log, TIME, SHAPE_BOX } from "./host";

let held: i32 = -1;

export function init(): void {}

export function tick(dt: f32): void {
  read(TIME);
  if (held >= 0) remove(held);
  held = spawn(SHAPE_BOX, 0.5, 0.5, 0.5, 0.5, 0.5, 0.5);
  log(60, <f32>held);
}
