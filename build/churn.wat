(module
 (type $0 (func (param i32 f32 f32 f32 f32 f32 f32) (result i32)))
 (type $1 (func (param i32)))
 (type $2 (func (param i32) (result f32)))
 (type $3 (func (param i32 f32)))
 (type $4 (func (param f32)))
 (type $5 (func))
 (import "host" "spawn" (func $behaviors/host/spawn (param i32 f32 f32 f32 f32 f32 f32) (result i32)))
 (import "host" "remove" (func $behaviors/host/remove (param i32)))
 (import "host" "read" (func $behaviors/host/read (param i32) (result f32)))
 (import "host" "log" (func $behaviors/host/log (param i32 f32)))
 (global $behaviors/churn/held (mut i32) (i32.const -1))
 (memory $0 0 256)
 (export "init" (func $behaviors/churn/init))
 (export "tick" (func $behaviors/churn/tick))
 (export "memory" (memory $0))
 (func $behaviors/churn/tick (param $0 f32)
  i32.const 6
  call $behaviors/host/read
  drop
  global.get $behaviors/churn/held
  i32.const 0
  i32.ge_s
  if
   global.get $behaviors/churn/held
   call $behaviors/host/remove
  end
  i32.const 0
  f32.const 0.5
  f32.const 0.5
  f32.const 0.5
  f32.const 0.5
  f32.const 0.5
  f32.const 0.5
  call $behaviors/host/spawn
  global.set $behaviors/churn/held
  i32.const 60
  global.get $behaviors/churn/held
  f32.convert_i32_s
  call $behaviors/host/log
 )
 (func $behaviors/churn/init
 )
)
