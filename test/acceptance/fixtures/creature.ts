// Test fixture for the creature behaviour check (not an acceptance object the agent is shown):
// wanders, and when a rover comes within 12 m drives to the far side of the nearest rock.
import { read, drive, spawn, pose, state_set, nearest, nearest_bearing, wrapAngle, clamp,
         POS_X, POS_Z, HEADING, KIND_ROVER, KIND_ROCK, SHAPE_SPHERE } from "./host";
let body: i32 = -1; let phase: f32 = 0.0;
export function init(): void { body = spawn(SHAPE_SPHERE, 0.6, 0.6, 0.6, 0.4, 0.6, 0.3); pose(body, 0.0, 0.4, 0.0, 0.0, 0.0); }
export function tick(dt: f32): void {
  const x = read(POS_X), z = read(POS_Z), h = read(HEADING);
  const dr = nearest(KIND_ROVER, x, z);
  if (dr >= 0.0 && dr < 12.0) {
    const dk = nearest(KIND_ROCK, x, z);
    if (dk >= 0.0) {
      const rb = nearest_bearing(KIND_ROCK, x, z), vb = nearest_bearing(KIND_ROVER, x, z);
      const rockX = x + Mathf.sin(rb) * dk, rockZ = z + Mathf.cos(rb) * dk;
      const roverX = x + Mathf.sin(vb) * dr, roverZ = z + Mathf.cos(vb) * dr;
      let ax = rockX - roverX, az = rockZ - roverZ; const len = Mathf.sqrt(ax * ax + az * az);
      if (len > 0.01) { ax /= len; az /= len; }
      const hideX = rockX + ax * 2.5, hideZ = rockZ + az * 2.5;     // 2.5 m behind the rock, seen from the rover
      const dist = Mathf.sqrt((hideX - x) * (hideX - x) + (hideZ - z) * (hideZ - z));
      const err = wrapAngle(Mathf.atan2(hideX - x, hideZ - z) - h);
      drive(dist > 0.8 ? 0.9 : 0.0, clamp(err * 1.5, -1.0, 1.0));
      state_set(0, 1.0);
      return;
    }
  }
  phase += dt * 0.7;
  drive(0.5, Mathf.sin(phase) * 0.6);                                 // wander
  state_set(0, 0.0);
}
