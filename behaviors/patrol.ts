// Behavior: patrol a 30 m square around the spawn point, dodging rocks.
// (sample of what the LLM generates from the prompt
//  "make the rover patrol a square around where it started and avoid rocks")
import { read, drive, set_led, log, mem_get, mem_set, clamp, wrapAngle,
         POS_X, POS_Z, HEADING, OBSTACLE_DIST, OBSTACLE_SIDE } from "./host";

const SIDE: f32 = 30.0;
const LOG_CORNER: i32 = 1;
const LOG_DODGE: i32 = 2;

let originX: f32 = 0, originZ: f32 = 0;
let corner: i32 = 0;

export function init(): void {
  originX = read(POS_X);
  originZ = read(POS_Z);
  corner = <i32>mem_get(0);   // resume at the corner we were heading to before a reload
  set_led(0.2, 0.6, 1.0);
}

function targetX(c: i32): f32 { return originX + ((c == 1 || c == 2) ? SIDE : 0.0); }
function targetZ(c: i32): f32 { return originZ + ((c == 2 || c == 3) ? SIDE : 0.0); }

export function tick(dt: f32): void {
  const x = read(POS_X), z = read(POS_Z), h = read(HEADING);
  const dx = targetX(corner) - x, dz = targetZ(corner) - z;
  const dist = <f32>Math.sqrt(dx * dx + dz * dz);

  if (dist < 2.0) {
    corner = (corner + 1) % 4;
    mem_set(0, <f32>corner);
    log(LOG_CORNER, <f32>corner);
    return;
  }

  // bearing to target, relative to heading
  const want = <f32>Math.atan2(dx, dz);
  let steer = clamp(wrapAngle(want - h) * 1.5, -1.0, 1.0);

  // rock in the way: steer away from it and slow down
  const od = read(OBSTACLE_DIST);
  let throttle: f32 = dist < 6.0 ? 0.5 : 1.0;
  if (od < 5.0) {
    steer = -read(OBSTACLE_SIDE) * 1.0;
    throttle = 0.4;
    set_led(1.0, 0.5, 0.0);
    log(LOG_DODGE, od);
  } else {
    set_led(0.2, 0.6, 1.0);
  }
  drive(throttle, steer);
}
