(module
 (type $0 (func (param i32 f32)))
 (type $1 (func (param f32)))
 (type $2 (func (param f32 f32 f32)))
 (type $3 (func))
 (type $4 (func (param i32) (result f32)))
 (type $5 (func (param f32 f32)))
 (import "host" "set_led" (func $behaviors/host/set_led (param f32 f32 f32)))
 (import "host" "mem_set" (func $behaviors/host/mem_set (param i32 f32)))
 (import "host" "log" (func $behaviors/host/log (param i32 f32)))
 (import "host" "set_arm" (func $behaviors/host/set_arm (param f32)))
 (import "host" "read" (func $behaviors/host/read (param i32) (result f32)))
 (import "host" "drive" (func $behaviors/host/drive (param f32 f32)))
 (global $behaviors/nonfinite/nan (mut f32) (f32.const 0))
 (global $behaviors/nonfinite/inf (mut f32) (f32.const 1))
 (memory $0 0)
 (export "init" (func $behaviors/nonfinite/init))
 (export "tick" (func $behaviors/nonfinite/tick))
 (export "memory" (memory $0))
 (func $behaviors/nonfinite/tick (param $0 f32)
  i32.const 6
  call $behaviors/host/read
  drop
  global.get $behaviors/nonfinite/nan
  global.get $behaviors/nonfinite/inf
  call $behaviors/host/drive
  global.get $behaviors/nonfinite/inf
  f32.neg
  call $behaviors/host/set_arm
  global.get $behaviors/nonfinite/nan
  global.get $behaviors/nonfinite/inf
  global.get $behaviors/nonfinite/inf
  f32.neg
  call $behaviors/host/set_led
  i32.const 0
  global.get $behaviors/nonfinite/inf
  call $behaviors/host/mem_set
  i32.const 1
  global.get $behaviors/nonfinite/nan
  call $behaviors/host/mem_set
  i32.const 7
  global.get $behaviors/nonfinite/nan
  call $behaviors/host/log
  i32.const 8
  f32.const 1
  call $behaviors/host/log
 )
 (func $behaviors/nonfinite/init
  f32.const nan:0x400000
  global.set $behaviors/nonfinite/nan
  f32.const inf
  global.set $behaviors/nonfinite/inf
  f32.const nan:0x400000
  f32.const 0
  f32.const 0
  call $behaviors/host/set_led
 )
)
