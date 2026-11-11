(module
 (type $0 (func (param i32 f32)))
 (type $1 (func (param f32)))
 (type $2 (func))
 (type $3 (func (param i32) (result f32)))
 (type $4 (func (param f32 f32)))
 (import "host" "log" (func $behaviors/host/log (param i32 f32)))
 (import "host" "read" (func $behaviors/host/read (param i32) (result f32)))
 (import "host" "drive" (func $behaviors/host/drive (param f32 f32)))
 (global $behaviors/memhog/pages (mut i32) (i32.const 0))
 (global $behaviors/memhog/failed (mut i32) (i32.const 0))
 (memory $0 0 256)
 (export "init" (func $behaviors/memhog/init))
 (export "tick" (func $behaviors/memhog/tick))
 (export "memory" (memory $0))
 (func $behaviors/memhog/tick (param $0 f32)
  i32.const 6
  call $behaviors/host/read
  drop
  i32.const 1
  memory.grow
  i32.const 0
  i32.lt_s
  if
   global.get $behaviors/memhog/failed
   i32.const 1
   i32.add
   global.set $behaviors/memhog/failed
  else
   global.get $behaviors/memhog/pages
   i32.const 1
   i32.add
   global.set $behaviors/memhog/pages
  end
  f32.const 0
  f32.const 0
  call $behaviors/host/drive
  i32.const 40
  global.get $behaviors/memhog/pages
  f32.convert_i32_s
  call $behaviors/host/log
  i32.const 41
  global.get $behaviors/memhog/failed
  f32.convert_i32_s
  call $behaviors/host/log
 )
 (func $behaviors/memhog/init
 )
)
