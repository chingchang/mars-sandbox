// Behavior: drive to wherever the player taps on the terrain, stop there,
// and slow down on steep slopes.
// (sample of the LLM output for "go to the spot I click on, carefully on hills")
import { read, drive, set_led, set_arm, log, clamp,
         TARGET_DIST, TARGET_BEARING, SLOPE_AHEAD, OBSTACLE_DIST, OBSTACLE_SIDE } from "./host";

const LOG_ARRIVED: i32 = 20;
const LOG_STEEP: i32 = 21;
let arrived: bool = false;

export function init(): void {
  arrived = false;
  set_led(0.8, 0.2, 1.0);
}

export function tick(dt: f32): void {
  const dist = read(TARGET_DIST);

  if (dist > 90.0 || dist < 1.5) {      // no target, or we're there
    if (!arrived && dist < 1.5) { arrived = true; log(LOG_ARRIVED, dist); set_arm(1.0); }
    drive(0.0, 0.0);
    return;
  }
  arrived = false;
  set_arm(0.0);

  let steer = clamp(read(TARGET_BEARING) * 2.0, -1.0, 1.0);
  let throttle: f32 = dist < 5.0 ? 0.35 : 1.0;

  const slope = read(SLOPE_AHEAD);
  if (slope > 0.25) { throttle *= 0.5; log(LOG_STEEP, slope); }

  const od = read(OBSTACLE_DIST);
  if (od < 4.0) { steer = -read(OBSTACLE_SIDE); throttle = 0.4; }

  drive(throttle, steer);
}
