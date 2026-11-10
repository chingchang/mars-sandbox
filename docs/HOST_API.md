# Host API

The complete list of functions a module may call, and the sensor keys it may read. Declared once in `behaviors/host.ts`, enforced by `runtime/worker.mjs` (import allow-list, checked before instantiation) and `runtime/registry.mjs` (every request validated at the host boundary). If it is not here, a module cannot do it. The design agent's prompt is built from this file, so each paragraph says exactly what a call does, what it returns, and what happens to a bad argument.

**The finite-number rule.** Every numeric argument must be a finite number. A NaN or ±Infinity is treated as 0 by the clamped actuators (`drive`, `set_arm`, `set_led`, `pose`), and makes `mem_set`, `log`, `state_set` and `signal_emit` ignore the call. The registry validates again when it receives the module's requests, so nothing non-finite ever reaches the world. A module that sends such values keeps running; the first occurrence is logged against its object.

**Requests, not commands.** Nothing a module calls changes the world directly. Each call records a request; after `tick()` returns, the host validates and applies the batch. The host may clamp, drop or ignore any request.

**Budget and watchdog.** `tick(dt)` must return within 2 ms on average; three consecutive ticks over budget disable the module. A tick that does not return within 400 ms is terminated, together with its worker. `init()` must complete within 3 s. A module may have exactly one linear memory (or none), not imported, 32-bit, declaring a maximum of at most 256 pages (16 MiB); a module with a second memory, an imported memory, a memory64 memory, no declared maximum, or a larger one is rejected at load. `memory.grow` beyond the maximum fails and returns -1; the module keeps running.

## Module shape

A module exports `init(): void`, called once after load, and `tick(dt: f32): void`, called 20 times per simulated second with `dt` in seconds. It may keep its own globals; they are lost on reload. To keep state across a reload (so "v2" inherits "v1"), use `mem_set` / `mem_get`.

## Sensors: `read(key: i32) -> f32`

Returns the current value of one sensor from a snapshot taken by the host before the tick. Keys 0 to 13 are the rover-style sensors (position `POS_X`, `POS_Z`, `HEADING`, `SPEED`, `BATTERY`, `SOLAR_W`, `TIME`, `CHARGER_DIST`, `CHARGER_BEARING`, `SLOPE_AHEAD`, `OBSTACLE_DIST`, `OBSTACLE_SIDE`, `TARGET_DIST`, `TARGET_BEARING`), documented in `host.ts`. For an object that is not the rover, `POS_X`, `POS_Z`, `HEADING`, `SPEED`, `TIME`, `CHARGER_DIST` and `CHARGER_BEARING` are its own; the rest are neutral (99 for distances, 0 otherwise). An unknown key returns 0. Keys are appended, never renumbered.

`ENV_AIR_TEMP_K` (key 14): the air temperature right now, in kelvin, at 1.45 m above the ground. It is the typical temperature for the current local hour over one measured Mars year: the host interpolates the record `jezero.temperature.my36_air_hourly_mean` (Perseverance MEDA, Mars Year 36, all seasons pooled, tier measured) at the world clock. It is not today's weather and carries no season; it swings between roughly 193 K before dawn and 257 K mid-afternoon every sol. A module that needs the record's own provenance can call `fact_tier` on it. Sun direction, solar flux and dust are not live reads yet.

## Actuators (rover style)

`drive(throttle, steer)`: request throttle −1..1 and steering −1..1 (positive = right). Values are clamped. Only an object with wheels (the rover, or a generic object, which uses the same simple kinematics) moves; the request is otherwise ignored.

`set_arm(angle)`: request arm elevation 0..1, clamped. Visual only on the rover.

`set_led(r, g, b)`: set the rover's status light, each channel 0..1, clamped.

`log(code, value)`: append a structured log line the host renders with the label the module's manifest or sample declares for `code`. At most 8 per tick; a non-finite value drops the call. A log recorded in a tick that never returns is never delivered.

`mem_get(slot) -> f32` / `mem_set(slot, value)`: 64 floats of host-owned memory per object. They survive a module reload and are the only state that does. Slots outside 0..63 read 0 and are not written; a non-finite value is not written.

## Visuals

`spawn(shape, w, h, d, r, g, b) -> i32`: create a shape owned by this object and return its handle, 0..31, or −1 if the object already has 32 shapes. `shape` is one of `SHAPE_BOX` (0), `SHAPE_CYLINDER` (1), `SHAPE_SPHERE` (2), `SHAPE_CONE` (3), `SHAPE_PANEL` (4); any other value becomes the nearest valid one. `w`, `h`, `d` are metres, clamped to 0.01..50 (a cylinder and a cone use `w` as diameter and `h` as height; a sphere uses `w` as diameter; a panel is a thin box). `r`, `g`, `b` are colour 0..1. A new shape sits at the object's origin until posed. Handles are per object: a module cannot see, move or remove another object's shapes, because it never holds their handles and the host only honours handles it saw this object spawn.

`pose(handle, x, y, z, yaw, pitch)`: place a shape relative to the object's own position and heading, metres and radians (x right, y up, z forward; yaw about y, pitch about x). Offsets are clamped to ±50 m and angles wrapped to ±π, so a module cannot draw its shapes on top of a distant object. An unknown handle is ignored.

`remove(handle)`: delete a shape and free its handle. `spawn` always returns the lowest free handle, so a module may spawn and remove indefinitely as long as it holds at most 32 shapes at once; the one rule is that a handle freed in a tick is not handed out again until the next tick, so remove-then-spawn in the same tick yields a different handle (and requests are applied in the order spawn, pose, remove within a tick). An unknown handle is ignored. When a module is replaced or unloaded, all its shapes are removed. To recolour a shape, remove it and spawn a new one.

## State

`state_set(slot, value)`: publish a number in one of 16 state slots (0..15). The inspector shows each slot with the label and unit the manifest declares for it, so a type the inspector has never seen still gets a readable panel. A slot outside 0..15 or a non-finite value is ignored. State is for display; it is not read back by the module (use `mem_get` for that) and does not survive a reload.

## Signals

`signal_emit(code, value)`: publish a world-scoped number under an integer code 0..65535. Every module, including this one, can read it on the next tick with `signal_read`; after that tick it is gone unless re-emitted. At most 32 emits per tick per module; a later emit of the same code in the same tick wins. The manifest declares the codes a module emits and the codes it listens to, so the inspector and other players can wire things together.

`signal_read(code) -> f32`: the value emitted under `code` during the previous tick by any module, or 0 if none. There is no way to tell "0 was emitted" from "nothing was emitted"; emit 1 for a boolean flag. A listener whose previous tick was still running when the signal expired misses it, so a value that must be seen should be re-emitted every tick while it holds, not pulsed once.

## World queries

Coordinates are the world frame: x east, z south, metres, origin at the landing site; bearings in radians, 0 = +z, increasing clockwise seen from above.

`terrain_height(x, z) -> f32`: ground height at a point, in metres relative to the landing site (the rover spawns at 0), from a 16 m grid of the real HiRISE terrain. Outside the loaded terrain it returns 0.

`nearest(kind, x, z) -> f32`: distance in metres from (x, z) to the closest thing of `kind`: `KIND_ROVER` (0), `KIND_ROCK` (1), `KIND_CHARGER` (2), `KIND_OBJECT` (3, any player object other than this one). Returns −1 if nothing of that kind exists. The calling object never counts as its own nearest.

`nearest_bearing(kind, x, z) -> f32`: the absolute bearing from (x, z) to that same nearest thing, or 0 if there is none. Check `nearest` first.

## Facts

`fact(key) -> f32`: a sourced number about Mars from `facts/index.json`, by one of the `FACT_*` keys generated into `host.ts` (for example `FACT_MARS_TIME_SOL` is the length of a sol in seconds, `FACT_JEZERO_TEMPERATURE_MY36_AIR_ANNUAL_MEAN` the MY36 mean air temperature in kelvin). The value is in the record's unit, as the comment beside each key says. An unknown key returns NaN. Only scalar facts have keys; tables (the climatology series) and text facts are read by the design agent from the index, not by modules. Keys are append-only.

`fact_tier(key) -> i32`: the provenance rank of that fact: 0 defined, 1 measured, 2 derived, 3 engineering, 4 modeled, 5 hypothesis; −1 for an unknown key. A module should list every fact id it relies on in its manifest's `fact_ids`, so the inspector shows the weakest tier the object rests on, with citations. Nothing about Mars that is not in the index may be written into a module as a number.

## Manifest

Every module travels with a manifest (`runtime/manifest.schema.json`): `name`, `description`, `version` (integer, from 1), `author`, and optionally `state` (slot, label, unit), `signals` (`emits` / `listens`, each code with a label), `shapes` (how many it spawns at most), `fact_ids` (the facts it depends on) and `did_you_know` (`{ text, fact_id }`: one fact the design used, in the player's words; `fact_id` must also appear in `fact_ids`, so the inspector can show the citation). The runtime rejects a load whose manifest fails the schema. The inspector renders from it.

## What is not here

No network, no file system, no timers, no access to other objects' state, memory or shapes, no way to change the world except through the requests above. Physics primitives (conduction, radiation, PV output, crop growth) and live environment reads (current temperature, pressure, dust) arrive in Phase D as further host functions; until then a module gets the sourced means through `fact()`.
