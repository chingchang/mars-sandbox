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

// ---- generic object API (task X1): a module can be anything ---------------
// Every numeric argument must be finite: a NaN or +/-Infinity is treated as 0
// (or the call is ignored where noted). All calls are requests; the host validates.

// Visuals. spawn() returns a handle 0..31 owned by this object, or -1 when the
// object already has 32 shapes. Sizes in metres, colour 0..1. pose() places a
// shape relative to the object's own position and heading (x right, y up,
// z forward; yaw and pitch in radians). remove() frees the handle.
export const SHAPE_BOX: i32 = 0;
export const SHAPE_CYLINDER: i32 = 1;
export const SHAPE_SPHERE: i32 = 2;
export const SHAPE_CONE: i32 = 3;
export const SHAPE_PANEL: i32 = 4;
@external("host", "spawn")
export declare function spawn(shape: i32, w: f32, h: f32, d: f32, r: f32, g: f32, b: f32): i32;
@external("host", "pose")
export declare function pose(handle: i32, x: f32, y: f32, z: f32, yaw: f32, pitch: f32): void;
@external("host", "remove")
export declare function remove(handle: i32): void;

// State: 16 slots the inspector shows with the labels and units the manifest declares.
@external("host", "state_set")
export declare function state_set(slot: i32, value: f32): void;

// Signals: world-scoped named numbers. An emitted signal is readable by every
// module on the next tick and expires after one tick unless re-emitted.
// signal_read returns 0 when nobody emitted that code last tick.
@external("host", "signal_emit")
export declare function signal_emit(code: i32, value: f32): void;
@external("host", "signal_read")
export declare function signal_read(code: i32): f32;

// World queries, in the world frame (x east, z south, metres; bearings in
// radians, 0 = +Z, clockwise seen from above). terrain_height is relative to
// the landing site (the rover spawns at height 0). nearest returns the distance
// to the closest thing of that kind, or -1 if there is none; nearest_bearing
// the absolute bearing from (x, z) to it (0 if none).
export const KIND_ROVER: i32 = 0;
export const KIND_ROCK: i32 = 1;
export const KIND_CHARGER: i32 = 2;
export const KIND_OBJECT: i32 = 3;
@external("host", "terrain_height")
export declare function terrain_height(x: f32, z: f32): f32;
@external("host", "nearest")
export declare function nearest(kind: i32, x: f32, z: f32): f32;
@external("host", "nearest_bearing")
export declare function nearest_bearing(kind: i32, x: f32, z: f32): f32;

// Facts: sourced Mars numbers from facts/index.json, by the generated FACT_* keys
// below. fact() returns the value in the record's unit (NaN for an unknown key);
// fact_tier() the provenance rank (0 defined, 1 measured, 2 derived,
// 3 engineering, 4 modeled, 5 hypothesis; -1 unknown). A module should report
// the weakest tier it depends on through its manifest's fact_ids.
@external("host", "fact")
export declare function fact(key: i32): f32;
@external("host", "fact_tier")
export declare function fact_tier(key: i32): i32;

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

// ---- facts: generated by runtime/gen_fact_keys.mjs from facts/index.json. Append-only; never edit by hand ----
// fact(key) -> f32 value in the record's unit; fact_tier(key) -> i32 rank in
// facts/index.json tier_order (0 defined ... 5 hypothesis), -1 for an unknown key.
export const FACT_MARS_GRAVITY_SURFACE_EQUATORIAL: i32 = 0;            // Surface gravity [m/s^2] (measured)
export const FACT_MARS_RADIUS_EQUATORIAL: i32 = 1;                     // Equatorial radius [m] (measured)
export const FACT_MARS_MASS: i32 = 2;                                  // Mass [kg] (measured)
export const FACT_MARS_TIME_SOL: i32 = 3;                              // Length of a sol (mean solar day) [s] (measured)
export const FACT_MARS_TIME_SIDEREAL_ROTATION: i32 = 4;                // Sidereal rotation period [s] (measured)
export const FACT_MARS_TIME_YEAR_SOLS: i32 = 5;                        // Length of a Mars year [sol] (derived)
export const FACT_MARS_TIME_YEAR_DAYS: i32 = 6;                        // Sidereal orbital period [Earth day] (measured)
export const FACT_MARS_ORBIT_OBLIQUITY: i32 = 7;                       // Axial tilt (obliquity to orbit) [deg] (measured)
export const FACT_MARS_ORBIT_ECCENTRICITY: i32 = 8;                    // Orbital eccentricity [1] (measured)
export const FACT_MARS_ORBIT_SEMIMAJOR_AXIS: i32 = 9;                  // Mean distance from Sun [m] (measured)
export const FACT_SUN_SOLAR_CONSTANT_1AU: i32 = 10;                    // Total solar irradiance at 1 au (solar constant) [W/m^2] (measured)
export const FACT_ASTRO_AU: i32 = 11;                                  // Astronomical unit [m] (defined)
export const FACT_MARS_SOLAR_CONSTANT_MEAN: i32 = 12;                  // Top-of-atmosphere solar irradiance at mean distance [W/m^2] (derived)
export const FACT_MARS_SOLAR_CONSTANT_PERIHELION: i32 = 13;            // TOA solar irradiance at perihelion [W/m^2] (derived)
export const FACT_MARS_SOLAR_CONSTANT_APHELION: i32 = 14;              // TOA solar irradiance at aphelion [W/m^2] (derived)
export const FACT_MARS_ATMOSPHERE_CO2_FRACTION: i32 = 15;              // CO2 volume mixing ratio (near surface) [1] (measured)
export const FACT_MARS_ATMOSPHERE_AR40_FRACTION: i32 = 16;             // 40Ar volume mixing ratio [1] (measured)
export const FACT_MARS_ATMOSPHERE_N2_FRACTION: i32 = 17;               // N2 volume mixing ratio [1] (measured)
export const FACT_MARS_ATMOSPHERE_O2_FRACTION: i32 = 18;               // O2 volume mixing ratio [1] (measured)
export const FACT_MARS_ATMOSPHERE_CO_FRACTION: i32 = 19;               // CO volume mixing ratio (upper bound) [1] (measured)
export const FACT_CHEM_MOLAR_MASS_CO2: i32 = 20;                       // Molar mass of CO2 [kg/mol] (measured)
export const FACT_CHEM_MOLAR_MASS_AR40: i32 = 21;                      // Molar mass of 40Ar [kg/mol] (measured)
export const FACT_CHEM_MOLAR_MASS_N2: i32 = 22;                        // Molar mass of N2 [kg/mol] (measured)
export const FACT_CHEM_MOLAR_MASS_O2: i32 = 23;                        // Molar mass of O2 [kg/mol] (measured)
export const FACT_MARS_ATMOSPHERE_MEAN_MOLAR_MASS: i32 = 24;           // Mean molar mass of air [kg/mol] (derived)
export const FACT_MARS_RADIATION_GCR_DOSE_EQUIVALENT_SURFACE: i32 = 25; // GCR dose equivalent rate at the surface (Gale, solar max) [mSv/day] (measured)
export const FACT_MARS_RADIATION_GCR_DOSE_EQUIVALENT_CRUISE: i32 = 26; // GCR dose equivalent rate in transit (inside MSL spacecraft) [mSv/day] (measured)
export const FACT_MARS_INTERIOR_HEAT_FLOW_MEAN_PLESA2016: i32 = 27;    // Mean present-day surface heat flux (thermal evolution models) [mW/m^2] (modeled)
export const FACT_MARS_INTERIOR_HEAT_FLOW_MEAN_FRIZZELL2023: i32 = 28; // Mean crustal heat flow (geochemistry + InSight crustal thickness) [mW/m^2] (modeled)
export const FACT_JEZERO_LOCATION_ELEVATION_LANDING: i32 = 29;         // Elevation of landing site (MOLA datum) [m] (measured, superseded by jezero.location.elevation_landing_mola128)
export const FACT_JEZERO_LOCATION_ELEVATION_LANDING_MOLA128: i32 = 30; // Elevation of landing site, MOLA MEGDR 128 ppd (areoid datum) [m] (measured, superseded by jezero.location.elevation_landing_hirise1m)
export const FACT_JEZERO_LOCATION_ELEVATION_LANDING_HIRISE1M: i32 = 31; // Elevation of landing site, USGS Mars 2020 HiRISE DTM mosaic (MOLA areoid datum) [m] (measured)
export const FACT_JEZERO_PRESSURE_FIRST_READING: i32 = 32;             // Surface pressure, first MEDA report (sol 1, Ls~6) [Pa] (measured)
export const FACT_JEZERO_PRESSURE_ANNUAL_ENVELOPE: i32 = 33;           // Surface pressure envelope over a Mars year [Pa] (measured, superseded by jezero.pressure.my36_daily_mean)
export const FACT_JEZERO_TEMPERATURE_AIR_ANNUAL_MEAN: i32 = 34;        // Mean near-surface air temperature over a Mars year (1.45 m) [K] (measured, superseded by jezero.temperature.my36_air_annual_mean)
export const FACT_JEZERO_TEMPERATURE_AIR_DIURNAL_MIN_TYPICAL: i32 = 35; // Typical nightly minimum air temperature [K] (measured, superseded by jezero.temperature.my36_air_diurnal_min)
export const FACT_JEZERO_TEMPERATURE_AIR_DIURNAL_MAX_TYPICAL: i32 = 36; // Typical afternoon maximum air temperature [K] (measured, superseded by jezero.temperature.my36_air_diurnal_max)
export const FACT_JEZERO_TEMPERATURE_DIURNAL_RANGE_TYPICAL: i32 = 37;  // Typical day-night air temperature swing [K] (measured, superseded by jezero.temperature.my36_air_diurnal_swing)
export const FACT_JEZERO_SURFACE_THERMAL_INERTIA_RANGE: i32 = 38;      // Surface thermal inertia along the traverse [J m^-2 K^-1 s^-1/2] (measured)
export const FACT_JEZERO_SURFACE_ALBEDO_BROADBAND: i32 = 39;           // Broadband surface albedo (0.3-3 um) [1] (measured)
export const FACT_JEZERO_DUST_OPTICAL_DEPTH_TYPICAL: i32 = 40;         // Typical visible dust optical depth (clear season) [1] (measured, superseded by jezero.dust.optical_depth_background_my36)
export const FACT_JEZERO_DUST_OPTICAL_DEPTH_BACKGROUND_MY36: i32 = 41; // Visible (880 nm) dust optical depth in the clear season, MY36 [1] (measured)
export const FACT_JEZERO_DUST_OPTICAL_DEPTH_STORM_JAN2022: i32 = 42;   // Peak visible optical depth, regional dust storm 5-11 Jan 2022 (Ls 153-156) [1] (measured)
export const FACT_JEZERO_DUST_DUST_DEVIL_FREQUENCY: i32 = 43;          // Dust devil frequency of occurrence (first 365 sols) [events detected / 365 sols] (measured)
export const FACT_JEZERO_RADIATION_GCR_DOSE_EQUIVALENT_ESTIMATE: i32 = 44; // Estimated GCR dose equivalent at Jezero [mSv/day] (modeled)
export const FACT_JEZERO_SUBSURFACE_THERMAL_STABILITY_DEPTH: i32 = 45; // Depth below which diurnal temperature swing is negligible [m] (derived)
export const FACT_JEZERO_PRESSURE_MY36_DAILY_MEAN: i32 = 46;           // Surface pressure, MY36 mean of daily means [Pa] (measured)
export const FACT_JEZERO_PRESSURE_MY36_DIURNAL_SWING: i32 = 47;        // Surface pressure, typical daily swing (max - min within a sol) [Pa] (measured)
export const FACT_JEZERO_TEMPERATURE_MY36_AIR_ANNUAL_MEAN: i32 = 48;   // Air temperature at 1.45 m, MY36 mean of daily means [K] (measured)
export const FACT_JEZERO_TEMPERATURE_MY36_AIR_DIURNAL_MIN: i32 = 49;   // Air temperature at 1.45 m, typical nightly minimum [K] (measured)
export const FACT_JEZERO_TEMPERATURE_MY36_AIR_DIURNAL_MAX: i32 = 50;   // Air temperature at 1.45 m, typical afternoon maximum [K] (measured)
export const FACT_JEZERO_TEMPERATURE_MY36_AIR_DIURNAL_SWING: i32 = 51; // Air temperature at 1.45 m, typical day-night swing [K] (measured)
export const FACT_ISRU_MOXIE_O2_RATE_PEAK: i32 = 52;                   // MOXIE peak oxygen production rate [g/h] (engineering)
export const FACT_ISRU_MOXIE_O2_TOTAL: i32 = 53;                       // Total oxygen produced over the MOXIE campaign (16 runs) [g] (engineering)
export const FACT_ISRU_MOXIE_O2_RATE_FIRST_RUN: i32 = 54;              // MOXIE first-run production rate [g/h] (engineering)
export const FACT_REGOLITH_PERCHLORATE_PHOENIX_SITE: i32 = 55;         // Perchlorate content of soil at the Phoenix site (68 N) [wt%] (measured)
export const FACT_WATER_SHALLOW_ICE_MIDLATITUDE_DEPTH: i32 = 56;       // Depth to shallow ice where SWIM finds it consistent (northern mid-latitudes) [m] (modeled)
export const FACT_ATMOSPHERE_WATER_VAPOR_EXTRACTION_VIABILITY: i32 = 57; // Atmospheric water column [precipitable micrometres] (modeled)
// ---- end of generated facts ----
