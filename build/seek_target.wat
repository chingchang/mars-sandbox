(module
 (type $0 (func (param f32)))
 (type $1 (func (param i32) (result f32)))
 (type $2 (func (param i32 f32)))
 (type $3 (func (param f32 f32)))
 (type $4 (func))
 (type $5 (func (param f32 f32 f32)))
 (import "host" "read" (func $behaviors/host/read (param i32) (result f32)))
 (import "host" "set_arm" (func $behaviors/host/set_arm (param f32)))
 (import "host" "log" (func $behaviors/host/log (param i32 f32)))
 (import "host" "drive" (func $behaviors/host/drive (param f32 f32)))
 (import "host" "set_led" (func $behaviors/host/set_led (param f32 f32 f32)))
 (global $behaviors/seek_target/arrived (mut i32) (i32.const 0))
 (memory $0 0)
 (export "init" (func $behaviors/seek_target/init))
 (export "tick" (func $behaviors/seek_target/tick))
 (export "memory" (memory $0))
 (func $behaviors/seek_target/tick (param $0 f32)
  (local $1 f32)
  (local $2 i32)
  (local $3 f32)
  i32.const 12
  call $behaviors/host/read
  local.tee $0
  f32.const 1.5
  f32.lt
  local.tee $2
  local.get $0
  f32.const 90
  f32.gt
  i32.or
  if
   global.get $behaviors/seek_target/arrived
   i32.eqz
   local.get $2
   i32.and
   if
    i32.const 1
    global.set $behaviors/seek_target/arrived
    i32.const 20
    local.get $0
    call $behaviors/host/log
    f32.const 1
    call $behaviors/host/set_arm
   end
   f32.const 0
   f32.const 0
   call $behaviors/host/drive
   return
  end
  i32.const 0
  global.set $behaviors/seek_target/arrived
  f32.const 0
  call $behaviors/host/set_arm
  f32.const -1
  f32.const 1
  i32.const 13
  call $behaviors/host/read
  f32.const 2
  f32.mul
  local.tee $1
  local.get $1
  f32.const 1
  f32.gt
  select
  local.get $1
  f32.const -1
  f32.lt
  select
  local.set $1
  f32.const 0.3499999940395355
  f32.const 1
  local.get $0
  f32.const 5
  f32.lt
  select
  local.set $0
  i32.const 9
  call $behaviors/host/read
  local.tee $3
  f32.const 0.25
  f32.gt
  if
   i32.const 21
   local.get $3
   call $behaviors/host/log
   local.get $0
   f32.const 0.5
   f32.mul
   local.set $0
  end
  i32.const 10
  call $behaviors/host/read
  f32.const 4
  f32.lt
  if (result f32)
   i32.const 11
   call $behaviors/host/read
   f32.neg
   local.set $1
   f32.const 0.4000000059604645
  else
   local.get $0
  end
  local.get $1
  call $behaviors/host/drive
 )
 (func $behaviors/seek_target/init
  i32.const 0
  global.set $behaviors/seek_target/arrived
  f32.const 0.800000011920929
  f32.const 0.20000000298023224
  f32.const 1
  call $behaviors/host/set_led
 )
)
