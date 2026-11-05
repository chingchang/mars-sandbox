// ---------------------------------------------------------------------------
// Mars Sandbox host API  (the ONLY surface a behavior module can touch)
//
// A behavior is a Wasm module that exports:
//     init(): void          called once after load
//     tick(dt: f32): void   called every simulation step (dt in seconds)
//
// and may import exactly the functions below from the "host" namespace.
// Anything else is rejected by the loader before instantiation.
// ---------------------------------------------------------------------------

// ---- sensors: read(key) -> f32 -------------------------------------------
export const POS_X: i32 = 0;           // metres, world frame
export const POS_Z: i32 = 1;           // metres, world frame
export const HEADING: i32 = 2;         // radians, 0 = +Z, increases clockwise seen from above
export const SPEED: i32 = 3;           // m/s
export const BATTERY: i32 = 4;         // 0..1
export const SOLAR_W: i32 = 5;         // watts currently harvested
export const TIME: i32 = 6;            // seconds since world start
export const CHARGER_DIST: i32 = 7;    // metres to charging pad
export const CHARGER_BEARING: i32 = 8; // radians, relative to heading, -pi..pi (+ = turn right)
export const SLOPE_AHEAD: i32 = 9;     // radians, positive = uphill
export const OBSTACLE_DIST: i32 = 10;  // metres to nearest rock in front, 99 if none
export const OBSTACLE_SIDE: i32 = 11;  // -1 rock is left, +1 rock is right, 0 none
export const TARGET_DIST: i32 = 12;    // metres to player-placed target (99 if none)
export const TARGET_BEARING: i32 = 13; // radians relative to heading

@external("host", "read")
export declare function read(key: i32): f32;

// ---- actuators -----------------------------------------------------------
// throttle -1..1, steer -1..1 (+ = right). Values are clamped by the host.
@external("host", "drive")
export declare function drive(throttle: f32, steer: f32): void;

// Robotic arm elevation 0..1 (purely visual in this PoC)
@external("host", "set_arm")
export declare function set_arm(angle: f32): void;

// Status light on the rover, 0..1 each
@external("host", "set_led")
export declare function set_led(r: f32, g: f32, b: f32): void;

// Structured log: a code the module defines plus a value. The host renders it.
@external("host", "log")
export declare function log(code: i32, value: f32): void;

// Behaviors are allowed to persist up to 64 floats between ticks via the host
// (survives a module reload, which is how "v2" can inherit v1's state).
@external("host", "mem_get")
export declare function mem_get(slot: i32): f32;
@external("host", "mem_set")
export declare function mem_set(slot: i32, value: f32): void;

// ---- helpers (compiled into the module, not imports) ---------------------
export function clamp(v: f32, lo: f32, hi: f32): f32 {
  return v < lo ? lo : (v > hi ? hi : v);
}
export function wrapAngle(a: f32): f32 {
  const TWO_PI: f32 = 6.2831853;
  while (a > 3.14159265) a -= TWO_PI;
  while (a < -3.14159265) a += TWO_PI;
  return a;
}
