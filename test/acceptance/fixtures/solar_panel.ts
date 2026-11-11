// Test fixture for the solar-panel behaviour check (not an acceptance object the agent is shown):
// a panel whose yaw follows the local hour and whose output reads the mean solar constant fact.
import { read, spawn, pose, state_set, fact, ENV_LOCAL_HOUR, SHAPE_PANEL, SHAPE_CYLINDER, FACT_MARS_SOLAR_CONSTANT_MEAN } from "./host";
let mast: i32 = -1, panel: i32 = -1;
export function init(): void {
  mast = spawn(SHAPE_CYLINDER, 0.1, 1.2, 0.1, 0.7, 0.7, 0.7); pose(mast, 0.0, 0.6, 0.0, 0.0, 0.0);
  panel = spawn(SHAPE_PANEL, 1.2, 0.8, 0.05, 0.1, 0.2, 0.6);
}
export function tick(dt: f32): void {
  const hour = read(ENV_LOCAL_HOUR);
  const yaw: f32 = (hour - 12.0) / 24.0 * 6.2831853;                 // faces the sun's azimuth: east at 6 h, south at noon, west at 18 h
  const elev: f32 = Mathf.sin((hour - 6.0) / 12.0 * 3.1415927);       // above the horizon between 6 h and 18 h
  pose(panel, 0.0, 1.4, 0.0, yaw, 0.3);
  const sun = fact(FACT_MARS_SOLAR_CONSTANT_MEAN);                   // W/m^2 at Mars' mean distance
  const output: f32 = elev > 0.0 ? elev * sun * 0.96 * 0.2 : 0.0;    // 0.96 m^2 panel at 20 % efficiency: the player's assumption
  state_set(0, output); state_set(1, yaw);
}
