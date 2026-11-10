(module
 (type $0 (func (param i32 f32)))
 (type $1 (func (param i32) (result f32)))
 (type $2 (func (param i32 f32 f32 f32 f32 f32 f32) (result i32)))
 (type $3 (func (param i32 f32 f32 f32 f32 f32)))
 (type $4 (func (param f32)))
 (type $5 (func))
 (type $6 (func (param i32) (result i32)))
 (import "host" "state_set" (func $behaviors/host/state_set (param i32 f32)))
 (import "host" "spawn" (func $behaviors/host/spawn (param i32 f32 f32 f32 f32 f32 f32) (result i32)))
 (import "host" "pose" (func $behaviors/host/pose (param i32 f32 f32 f32 f32 f32)))
 (import "host" "log" (func $behaviors/host/log (param i32 f32)))
 (import "host" "fact" (func $behaviors/host/fact (param i32) (result f32)))
 (import "host" "signal_emit" (func $behaviors/host/signal_emit (param i32 f32)))
 (import "host" "read" (func $behaviors/host/read (param i32) (result f32)))
 (import "host" "fact_tier" (func $behaviors/host/fact_tier (param i32) (result i32)))
 (global $behaviors/weather_station/mast (mut i32) (i32.const -1))
 (global $behaviors/weather_station/panel (mut i32) (i32.const -1))
 (global $behaviors/weather_station/lastHour (mut i32) (i32.const -1))
 (memory $0 0 256)
 (export "init" (func $behaviors/weather_station/init))
 (export "tick" (func $behaviors/weather_station/tick))
 (export "memory" (memory $0))
 (func $behaviors/weather_station/tick (param $0 f32)
  (local $1 i32)
  i32.const 0
  i32.const 6
  call $behaviors/host/read
  i32.const 3
  call $behaviors/host/fact
  f32.div
  local.tee $0
  call $behaviors/host/state_set
  local.get $0
  f32.const 24
  f32.mul
  f64.promote_f32
  f64.floor
  i32.trunc_sat_f64_s
  local.tee $1
  global.get $behaviors/weather_station/lastHour
  i32.ne
  if
   local.get $1
   global.set $behaviors/weather_station/lastHour
   i32.const 100
   local.get $1
   f32.convert_i32_s
   local.tee $0
   call $behaviors/host/signal_emit
   i32.const 30
   local.get $0
   call $behaviors/host/log
  end
 )
 (func $behaviors/weather_station/init
  i32.const 1
  f32.const 0.10000000149011612
  f32.const 2
  f32.const 0.10000000149011612
  f32.const 0.800000011920929
  f32.const 0.800000011920929
  f32.const 0.800000011920929
  call $behaviors/host/spawn
  global.set $behaviors/weather_station/mast
  i32.const 4
  f32.const 0.6000000238418579
  f32.const 0.4000000059604645
  f32.const 0.05000000074505806
  f32.const 0.10000000149011612
  f32.const 0.30000001192092896
  f32.const 0.8999999761581421
  call $behaviors/host/spawn
  global.set $behaviors/weather_station/panel
  global.get $behaviors/weather_station/mast
  f32.const 0
  f32.const 1
  f32.const 0
  f32.const 0
  f32.const 0
  call $behaviors/host/pose
  global.get $behaviors/weather_station/panel
  f32.const 0
  f32.const 2.0999999046325684
  f32.const 0
  f32.const 0
  f32.const 0.30000001192092896
  call $behaviors/host/pose
  i32.const 1
  i32.const 48
  call $behaviors/host/fact
  call $behaviors/host/state_set
  i32.const 31
  i32.const 48
  call $behaviors/host/fact_tier
  f32.convert_i32_s
  call $behaviors/host/log
 )
)
