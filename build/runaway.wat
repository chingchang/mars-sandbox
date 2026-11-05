(module
 (type $0 (func (param f32)))
 (type $1 (func))
 (type $2 (func (param f32 f32 f32)))
 (type $3 (func (param i32) (result f32)))
 (type $4 (func (param i32 f32)))
 (type $5 (func (param f32 f32)))
 (import "host" "set_led" (func $behaviors/host/set_led (param f32 f32 f32)))
 (import "host" "read" (func $behaviors/host/read (param i32) (result f32)))
 (import "host" "log" (func $behaviors/host/log (param i32 f32)))
 (import "host" "drive" (func $behaviors/host/drive (param f32 f32)))
 (global $behaviors/runaway/t0 (mut f32) (f32.const -1))
 (memory $0 0)
 (export "init" (func $behaviors/runaway/init))
 (export "tick" (func $behaviors/runaway/tick))
 (export "memory" (memory $0))
 (func $behaviors/runaway/tick (param $0 f32)
  (local $1 f64)
  i32.const 6
  call $behaviors/host/read
  local.set $0
  global.get $behaviors/runaway/t0
  f32.const 0
  f32.lt
  if
   local.get $0
   global.set $behaviors/runaway/t0
  end
  local.get $0
  global.get $behaviors/runaway/t0
  f32.sub
  f32.const 3
  f32.lt
  if
   f32.const 1
   f32.const 0.30000001192092896
   call $behaviors/host/drive
   return
  end
  i32.const 99
  f32.const 0
  call $behaviors/host/log
  loop $while-continue|0
   local.get $1
   f64.const 1
   f64.add
   local.set $1
   br $while-continue|0
  end
  unreachable
 )
 (func $behaviors/runaway/init
  f32.const 1
  f32.const 1
  f32.const 1
  call $behaviors/host/set_led
 )
)
