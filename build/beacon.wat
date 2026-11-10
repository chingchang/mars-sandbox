(module
 (type $0 (func (param i32 f32)))
 (type $1 (func (param i32) (result f32)))
 (type $2 (func (param i32 f32 f32 f32 f32 f32 f32) (result i32)))
 (type $3 (func (param i32 f32 f32 f32 f32 f32)))
 (type $4 (func (param f32 f32) (result f32)))
 (type $5 (func (param i32 f32 f32) (result f32)))
 (type $6 (func (param f32)))
 (type $7 (func))
 (import "host" "state_set" (func $behaviors/host/state_set (param i32 f32)))
 (import "host" "spawn" (func $behaviors/host/spawn (param i32 f32 f32 f32 f32 f32 f32) (result i32)))
 (import "host" "read" (func $behaviors/host/read (param i32) (result f32)))
 (import "host" "pose" (func $behaviors/host/pose (param i32 f32 f32 f32 f32 f32)))
 (import "host" "terrain_height" (func $behaviors/host/terrain_height (param f32 f32) (result f32)))
 (import "host" "signal_read" (func $behaviors/host/signal_read (param i32) (result f32)))
 (import "host" "nearest" (func $behaviors/host/nearest (param i32 f32 f32) (result f32)))
 (import "host" "log" (func $behaviors/host/log (param i32 f32)))
 (global $behaviors/beacon/lamp (mut i32) (i32.const -1))
 (global $behaviors/beacon/lit (mut i32) (i32.const -1))
 (memory $0 0 256)
 (export "init" (func $behaviors/beacon/init))
 (export "tick" (func $behaviors/beacon/tick))
 (export "memory" (memory $0))
 (func $behaviors/beacon/tick (param $0 f32)
  (local $1 i32)
  (local $2 f32)
  (local $3 f32)
  i32.const 0
  i32.const 0
  i32.const 0
  call $behaviors/host/read
  local.tee $2
  i32.const 1
  call $behaviors/host/read
  local.tee $3
  call $behaviors/host/nearest
  local.tee $0
  call $behaviors/host/state_set
  i32.const 3
  local.get $2
  local.get $3
  call $behaviors/host/terrain_height
  call $behaviors/host/state_set
  i32.const 100
  call $behaviors/host/signal_read
  local.tee $2
  f32.const 0
  f32.gt
  if
   i32.const 2
   local.get $2
   call $behaviors/host/state_set
  end
  local.get $0
  f32.const 20
  f32.lt
  local.get $0
  f32.const 0
  f32.ge
  i32.and
  local.tee $1
  global.get $behaviors/beacon/lit
  i32.ne
  if
   local.get $1
   global.set $behaviors/beacon/lit
   i32.const 1
   local.get $1
   f32.convert_i32_s
   call $behaviors/host/state_set
   global.get $behaviors/beacon/lit
   i32.const 1
   i32.eq
   if (result i32)
    i32.const 2
    f32.const 0.5
    f32.const 0.5
    f32.const 0.5
    f32.const 1
    f32.const 0.10000000149011612
    f32.const 0.10000000149011612
    call $behaviors/host/spawn
   else
    i32.const 2
    f32.const 0.4000000059604645
    f32.const 0.4000000059604645
    f32.const 0.4000000059604645
    f32.const 0.30000001192092896
    f32.const 0.30000001192092896
    f32.const 0.30000001192092896
    call $behaviors/host/spawn
   end
   global.set $behaviors/beacon/lamp
   global.get $behaviors/beacon/lamp
   f32.const 0
   f32.const 1.5
   f32.const 0
   f32.const 0
   f32.const 0
   call $behaviors/host/pose
   i32.const 50
   local.get $1
   f32.convert_i32_s
   call $behaviors/host/log
  end
 )
 (func $behaviors/beacon/init
  i32.const 2
  f32.const 0.4000000059604645
  f32.const 0.4000000059604645
  f32.const 0.4000000059604645
  f32.const 0.30000001192092896
  f32.const 0.30000001192092896
  f32.const 0.30000001192092896
  call $behaviors/host/spawn
  global.set $behaviors/beacon/lamp
  global.get $behaviors/beacon/lamp
  f32.const 0
  f32.const 1.5
  f32.const 0
  f32.const 0
  f32.const 0
  call $behaviors/host/pose
 )
)
