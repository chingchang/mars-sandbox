// Deliberately greedy: grows linear memory by one page (64 KiB) every tick,
// forever. With the build's --maximumMemory 256 the growth stops at 16 MiB
// (memory.grow returns -1) and the module keeps running; a module compiled with
// no maximum is rejected at load. For test/hostapi.test.mjs; not in the UI.
import { read, drive, log, TIME } from "./host";

let pages: i32 = 0;
let failed: i32 = 0;

export function init(): void {}

export function tick(dt: f32): void {
  read(TIME);
  const r = memory.grow(1);
  if (r < 0) failed += 1; else pages += 1;
  drive(0.0, 0.0);
  log(40, <f32>pages);
  log(41, <f32>failed);
}
