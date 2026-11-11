// Must-pass fixture: dirt accumulates at each change of the local hour, in proportion to the tau fact.
import { read, spawn, pose, state_set, fact, ENV_LOCAL_HOUR, SHAPE_BOX, FACT_JEZERO_DUST_OPTICAL_DEPTH_BACKGROUND_MY36 } from "./host";
let dirt: f32 = 0.0; let lastHour: i32 = -1; let box: i32 = -1;
export function init(): void { box = spawn(SHAPE_BOX, 0.4, 0.2, 0.4, 0.6, 0.5, 0.4); pose(box, 0.0, 0.1, 0.0, 0.0, 0.0); }
export function tick(dt: f32): void {
  const h = <i32>Mathf.floor(read(ENV_LOCAL_HOUR));
  const tau = fact(FACT_JEZERO_DUST_OPTICAL_DEPTH_BACKGROUND_MY36);
  if (lastHour >= 0 && h != lastHour) dirt += tau * 0.01;            // per hour; the rate is the player's assumption
  lastHour = h;
  state_set(0, dirt); state_set(1, tau);
}
