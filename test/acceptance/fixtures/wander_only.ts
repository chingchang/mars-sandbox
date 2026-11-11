// Control fixture: wanders in loops and never reacts to the rover. The creature check must fail it.
import { read, drive, spawn, pose, TIME, SHAPE_SPHERE } from "./host";
let body: i32 = -1; let phase: f32 = 0.0;
export function init(): void { body = spawn(SHAPE_SPHERE, 0.6, 0.6, 0.6, 0.6, 0.4, 0.3); pose(body, 0.0, 0.4, 0.0, 0.0, 0.0); }
export function tick(dt: f32): void { read(TIME); phase += dt * 0.7; drive(0.5, Mathf.sin(phase) * 0.6); }
