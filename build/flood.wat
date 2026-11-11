(module
 (type $0 (func (param i32 f32)))
 (type $1 (func (param i32 f32 f32 f32 f32 f32 f32) (result i32)))
 (type $2 (func (param i32) (result f32)))
 (type $3 (func (param i32 f32 f32 f32 f32 f32)))
 (type $4 (func (param f32)))
 (type $5 (func))
 (import "host" "state_set" (func $behaviors/host/state_set (param i32 f32)))
 (import "host" "spawn" (func $behaviors/host/spawn (param i32 f32 f32 f32 f32 f32 f32) (result i32)))
 (import "host" "signal_emit" (func $behaviors/host/signal_emit (param i32 f32)))
 (import "host" "read" (func $behaviors/host/read (param i32) (result f32)))
 (import "host" "pose" (func $behaviors/host/pose (param i32 f32 f32 f32 f32 f32)))
 (import "host" "mem_set" (func $behaviors/host/mem_set (param i32 f32)))
 (import "host" "log" (func $behaviors/host/log (param i32 f32)))
 (global $behaviors/flood/box (mut i32) (i32.const -1))
 (global $behaviors/flood/n (mut i32) (i32.const 0))
 (memory $0 0 256)
 (export "init" (func $behaviors/flood/init))
 (export "tick" (func $behaviors/flood/tick))
 (export "memory" (memory $0))
 (func $behaviors/flood/tick (param $0 f32)
  (local $1 i32)
  i32.const 6
  call $behaviors/host/read
  drop
  global.get $behaviors/flood/n
  i32.const 1
  i32.add
  global.set $behaviors/flood/n
  loop $for-loop|0
   local.get $1
   i32.const 1000
   i32.lt_s
   if
    global.get $behaviors/flood/box
    local.get $1
    f32.convert_i32_s
    local.tee $0
    f32.const 1.0000000474974513e-03
    f32.mul
    f32.const 0.5
    f32.const 0
    f32.const 0
    f32.const 0
    call $behaviors/host/pose
    i32.const 0
    local.get $0
    call $behaviors/host/state_set
    i32.const 3
    global.get $behaviors/flood/n
    i32.const 1000
    i32.mul
    local.get $1
    i32.add
    f32.convert_i32_s
    call $behaviors/host/mem_set
    local.get $1
    i32.const 1
    i32.add
    local.set $1
    br $for-loop|0
   end
  end
  i32.const 0
  local.set $1
  loop $for-loop|1
   local.get $1
   i32.const 20
   i32.lt_s
   if
    i32.const 70
    local.get $1
    f32.convert_i32_s
    call $behaviors/host/log
    local.get $1
    i32.const 1
    i32.add
    local.set $1
    br $for-loop|1
   end
  end
  i32.const 0
  local.set $1
  loop $for-loop|2
   local.get $1
   i32.const 100
   i32.lt_s
   if
    i32.const 200
    local.get $1
    f32.convert_i32_s
    call $behaviors/host/signal_emit
    local.get $1
    i32.const 1
    i32.add
    local.set $1
    br $for-loop|2
   end
  end
 )
 (func $behaviors/flood/init
  i32.const 0
  f32.const 0.5
  f32.const 0.5
  f32.const 0.5
  f32.const 0.8999999761581421
  f32.const 0.20000000298023224
  f32.const 0.20000000298023224
  call $behaviors/host/spawn
  global.set $behaviors/flood/box
 )
)
