// Test fixture for the dust-gauge behaviour check (not an acceptance object the agent is shown):
// dirt accumulates in proportion to the clear-season optical depth fact.
import { read, spawn, pose, state_set, fact, TIME, SHAPE_BOX, FACT_JEZERO_DUST_OPTICAL_DEPTH_BACKGROUND_MY36 } from "./host";
let dirt: f32 = 0.0; let box: i32 = -1;
export function init(): void { box = spawn(SHAPE_BOX, 0.4, 0.2, 0.4, 0.6, 0.5, 0.4); pose(box, 0.0, 0.1, 0.0, 0.0, 0.0); }
export function tick(dt: f32): void {
  read(TIME);
  const tau = fact(FACT_JEZERO_DUST_OPTICAL_DEPTH_BACKGROUND_MY36);
  dirt += tau * dt * 0.01;                                            // the deposition rate per unit tau is the player's assumption
  state_set(0, dirt); state_set(1, tau);
}
