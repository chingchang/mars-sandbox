// Must-pass fixture: tracks the sun's azimuth from the local hour through a motor limited to 0.5 rad/s.
import { read, spawn, pose, state_set, fact, wrapAngle, clamp, ENV_LOCAL_HOUR, SHAPE_PANEL, FACT_MARS_SOLAR_CONSTANT_MEAN } from "./host";
let panel: i32 = -1; let yawNow: f32 = 0.0;
export function init(): void { panel = spawn(SHAPE_PANEL, 1.2, 0.8, 0.05, 0.1, 0.2, 0.6); }
export function tick(dt: f32): void {
  const hour = read(ENV_LOCAL_HOUR);
  const target: f32 = (hour - 12.0) / 24.0 * 6.2831853;
  yawNow += clamp(wrapAngle(target - yawNow), -0.5 * dt, 0.5 * dt);
  pose(panel, 0.0, 1.4, 0.0, yawNow, 0.3);
  const elev: f32 = Mathf.sin((hour - 6.0) / 12.0 * 3.1415927);
  state_set(0, elev > 0.0 ? elev * fact(FACT_MARS_SOLAR_CONSTANT_MEAN) * 0.96 * 0.2 : 0.0);
}
