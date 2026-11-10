// Proximity beacon, built only from the generic host calls (X1 sample; the
// hand-written shape of acceptance prompt A1.2). One sphere that lights up when
// any rover is within 20 m; reports its own terrain height and the last hour
// pulse it heard from a weather station (signal 100). Drives nothing.
import { read, spawn, pose, state_set, signal_read, nearest, terrain_height, log,
         POS_X, POS_Z, SHAPE_SPHERE, KIND_ROVER } from "./host";

const SLOT_ROVER_DIST: i32 = 0;
const SLOT_LIT: i32 = 1;
const SLOT_LAST_HOUR: i32 = 2;
const SLOT_HEIGHT: i32 = 3;
const TRIGGER_M: f32 = 20.0;
let lamp: i32 = -1;
let lit: i32 = -1;

export function init(): void {
  lamp = spawn(SHAPE_SPHERE, 0.4, 0.4, 0.4, 0.3, 0.3, 0.3);
  pose(lamp, 0.0, 1.5, 0.0, 0.0, 0.0);
}

export function tick(dt: f32): void {
  const x = read(POS_X), z = read(POS_Z);
  const d = nearest(KIND_ROVER, x, z);
  state_set(SLOT_ROVER_DIST, d);
  state_set(SLOT_HEIGHT, terrain_height(x, z));
  const h = signal_read(100);
  if (h > 0.0) state_set(SLOT_LAST_HOUR, h);
  const now: i32 = (d >= 0.0 && d < TRIGGER_M) ? 1 : 0;
  if (now != lit) {
    lit = now;
    state_set(SLOT_LIT, <f32>now);
    // re-spawn the lamp in the new colour: red when lit, grey when not
    if (lit == 1) { lamp = spawn(SHAPE_SPHERE, 0.5, 0.5, 0.5, 1.0, 0.1, 0.1); } else { lamp = spawn(SHAPE_SPHERE, 0.4, 0.4, 0.4, 0.3, 0.3, 0.3); }
    pose(lamp, 0.0, 1.5, 0.0, 0.0, 0.0);
    log(50, <f32>now);
  }
}
