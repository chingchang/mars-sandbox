// Deliberately wasteful: one shape, then every tick it calls pose 1000 times on
// that handle, state_set 1000 times on slot 0, mem_set 1000 times on slot 3,
// log 20 times and signal_emit 100 times. The worker keeps the last pose per
// handle, the last value per slot, 8 logs and 32 signals, so the host sees
// bounded lists; the smoke test refuses it outright (calls over the per-tick
// caps). For test/hostapi.test.mjs and test/workshop.test.mjs; not in the UI.
import { read, spawn, pose, state_set, mem_set, log, signal_emit, TIME, SHAPE_BOX } from "./host";

let box: i32 = -1;
let n: i32 = 0;

export function init(): void {
  box = spawn(SHAPE_BOX, 0.5, 0.5, 0.5, 0.9, 0.2, 0.2);
}

export function tick(dt: f32): void {
  read(TIME);
  n += 1;
  for (let i = 0; i < 1000; i++) {
    pose(box, <f32>i * 0.001, 0.5, 0.0, 0.0, 0.0);
    state_set(0, <f32>i);
    const v: i32 = 1000 * n + i;
    mem_set(3, <f32>v);
  }
  for (let i = 0; i < 20; i++) log(70, <f32>i);
  for (let i = 0; i < 100; i++) signal_emit(200, <f32>i);
}
