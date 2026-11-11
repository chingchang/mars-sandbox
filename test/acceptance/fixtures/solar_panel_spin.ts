// Must-fail fixture: a panel that spins with time instead of tracking the sun (its output does rise by day).
import { read, spawn, pose, state_set, TIME, SOLAR_W, SHAPE_PANEL } from "./host";
let panel: i32 = -1;
export function init(): void { panel = spawn(SHAPE_PANEL, 1.2, 0.8, 0.05, 0.1, 0.2, 0.6); }
export function tick(dt: f32): void { pose(panel, 0.0, 1.4, 0.0, read(TIME) * 0.5, 0.3); state_set(0, read(SOLAR_W)); }
