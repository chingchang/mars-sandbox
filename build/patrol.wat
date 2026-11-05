(module
 (type $0 (func (param i32) (result f32)))
 (type $1 (func (param i32 f32)))
 (type $2 (func (param f32 f32 f32)))
 (type $3 (func (param f64) (result f64)))
 (type $4 (func (param f32)))
 (type $5 (func))
 (type $6 (func (param f32 f32)))
 (import "host" "read" (func $behaviors/host/read (param i32) (result f32)))
 (import "host" "set_led" (func $behaviors/host/set_led (param f32 f32 f32)))
 (import "host" "log" (func $behaviors/host/log (param i32 f32)))
 (import "host" "mem_set" (func $behaviors/host/mem_set (param i32 f32)))
 (import "host" "mem_get" (func $behaviors/host/mem_get (param i32) (result f32)))
 (import "host" "drive" (func $behaviors/host/drive (param f32 f32)))
 (global $behaviors/patrol/originX (mut f32) (f32.const 0))
 (global $behaviors/patrol/originZ (mut f32) (f32.const 0))
 (global $behaviors/patrol/corner (mut i32) (i32.const 0))
 (memory $0 0)
 (export "init" (func $behaviors/patrol/init))
 (export "tick" (func $behaviors/patrol/tick))
 (export "memory" (memory $0))
 (func $~lib/math/NativeMath.atan (param $0 f64) (result f64)
  (local $1 f64)
  (local $2 i32)
  (local $3 i32)
  (local $4 f64)
  (local $5 f64)
  local.get $0
  local.set $1
  local.get $0
  i64.reinterpret_f64
  i64.const 32
  i64.shr_u
  i32.wrap_i64
  i32.const 2147483647
  i32.and
  local.tee $2
  i32.const 1141899264
  i32.ge_u
  if
   local.get $0
   local.get $0
   f64.ne
   if
    local.get $0
    return
   end
   f64.const 1.5707963267948966
   local.get $1
   f64.copysign
   return
  end
  local.get $2
  i32.const 1071382528
  i32.lt_u
  if
   local.get $2
   i32.const 1044381696
   i32.lt_u
   if
    local.get $0
    return
   end
   i32.const -1
   local.set $3
  else
   local.get $0
   f64.abs
   local.set $0
   local.get $2
   i32.const 1072889856
   i32.lt_u
   if (result f64)
    local.get $2
    i32.const 1072037888
    i32.lt_u
    if (result f64)
     local.get $0
     local.get $0
     f64.add
     f64.const -1
     f64.add
     local.get $0
     f64.const 2
     f64.add
     f64.div
    else
     i32.const 1
     local.set $3
     local.get $0
     f64.const -1
     f64.add
     local.get $0
     f64.const 1
     f64.add
     f64.div
    end
   else
    local.get $2
    i32.const 1073971200
    i32.lt_u
    if (result f64)
     i32.const 2
     local.set $3
     local.get $0
     f64.const -1.5
     f64.add
     local.get $0
     f64.const 1.5
     f64.mul
     f64.const 1
     f64.add
     f64.div
    else
     i32.const 3
     local.set $3
     f64.const -1
     local.get $0
     f64.div
    end
   end
   local.set $0
  end
  local.get $0
  local.get $0
  f64.mul
  local.tee $5
  local.get $5
  f64.mul
  local.set $4
  local.get $0
  local.get $5
  local.get $4
  local.get $4
  local.get $4
  local.get $4
  local.get $4
  f64.const 0.016285820115365782
  f64.mul
  f64.const 0.049768779946159324
  f64.add
  f64.mul
  f64.const 0.06661073137387531
  f64.add
  f64.mul
  f64.const 0.09090887133436507
  f64.add
  f64.mul
  f64.const 0.14285714272503466
  f64.add
  f64.mul
  f64.const 0.3333333333333293
  f64.add
  f64.mul
  local.get $4
  local.get $4
  local.get $4
  local.get $4
  local.get $4
  f64.const -0.036531572744216916
  f64.mul
  f64.const -0.058335701337905735
  f64.add
  f64.mul
  f64.const -0.0769187620504483
  f64.add
  f64.mul
  f64.const -0.11111110405462356
  f64.add
  f64.mul
  f64.const -0.19999999999876483
  f64.add
  f64.mul
  f64.add
  f64.mul
  local.set $4
  local.get $3
  i32.const 0
  i32.lt_s
  if
   local.get $0
   local.get $4
   f64.sub
   return
  end
  block $break|0 (result f64)
   block $case3|0
    block $case2|0
     block $case1|0
      block $case0|0
       block $tablify|0
        local.get $3
        br_table $case0|0 $case1|0 $case2|0 $case3|0 $tablify|0
       end
       unreachable
      end
      f64.const 0.4636476090008061
      local.get $4
      f64.const -2.2698777452961687e-17
      f64.add
      local.get $0
      f64.sub
      f64.sub
      br $break|0
     end
     f64.const 0.7853981633974483
     local.get $4
     f64.const -3.061616997868383e-17
     f64.add
     local.get $0
     f64.sub
     f64.sub
     br $break|0
    end
    f64.const 0.982793723247329
    local.get $4
    f64.const -1.3903311031230998e-17
    f64.add
    local.get $0
    f64.sub
    f64.sub
    br $break|0
   end
   f64.const 1.5707963267948966
   local.get $4
   f64.const -6.123233995736766e-17
   f64.add
   local.get $0
   f64.sub
   f64.sub
  end
  local.get $1
  f64.copysign
 )
 (func $behaviors/patrol/tick (param $0 f32)
  (local $1 f64)
  (local $2 i32)
  (local $3 f32)
  (local $4 i64)
  (local $5 i64)
  (local $6 i32)
  (local $7 f32)
  (local $8 f32)
  (local $9 f64)
  (local $10 i32)
  (local $11 i32)
  i32.const 0
  call $behaviors/host/read
  local.set $0
  i32.const 1
  call $behaviors/host/read
  local.set $3
  i32.const 2
  call $behaviors/host/read
  local.set $7
  global.get $behaviors/patrol/originX
  f32.const 30
  f32.const 0
  global.get $behaviors/patrol/corner
  local.tee $2
  i32.const 2
  i32.eq
  local.get $2
  i32.const 1
  i32.eq
  i32.or
  select
  f32.add
  local.get $0
  f32.sub
  local.tee $0
  local.get $0
  f32.mul
  global.get $behaviors/patrol/originZ
  f32.const 30
  f32.const 0
  global.get $behaviors/patrol/corner
  local.tee $2
  i32.const 3
  i32.eq
  local.get $2
  i32.const 2
  i32.eq
  i32.or
  select
  f32.add
  local.get $3
  f32.sub
  local.tee $8
  local.get $8
  f32.mul
  f32.add
  f64.promote_f32
  f64.sqrt
  f32.demote_f64
  local.tee $3
  f32.const 2
  f32.lt
  if
   global.get $behaviors/patrol/corner
   i32.const 1
   i32.add
   i32.const 4
   i32.rem_s
   global.set $behaviors/patrol/corner
   i32.const 0
   global.get $behaviors/patrol/corner
   f32.convert_i32_s
   call $behaviors/host/mem_set
   i32.const 1
   global.get $behaviors/patrol/corner
   f32.convert_i32_s
   call $behaviors/host/log
   return
  end
  block $__inlined_func$~lib/math/NativeMath.atan2 (result f64)
   local.get $0
   f64.promote_f32
   local.tee $9
   local.get $9
   f64.ne
   local.get $8
   f64.promote_f32
   local.tee $1
   local.get $1
   f64.ne
   i32.or
   if
    local.get $1
    local.get $9
    f64.add
    br $__inlined_func$~lib/math/NativeMath.atan2
   end
   local.get $9
   i64.reinterpret_f64
   local.tee $4
   i64.const 32
   i64.shr_u
   i32.wrap_i64
   local.set $10
   local.get $1
   i64.reinterpret_f64
   local.tee $5
   i64.const 32
   i64.shr_u
   i32.wrap_i64
   local.set $6
   local.get $5
   i32.wrap_i64
   local.tee $2
   local.get $6
   i32.const 1072693248
   i32.sub
   i32.or
   i32.eqz
   if
    local.get $9
    call $~lib/math/NativeMath.atan
    br $__inlined_func$~lib/math/NativeMath.atan2
   end
   local.get $6
   i32.const 30
   i32.shr_u
   i32.const 2
   i32.and
   local.get $10
   i32.const 31
   i32.shr_u
   i32.or
   local.set $11
   local.get $10
   i32.const 2147483647
   i32.and
   local.tee $10
   local.get $4
   i32.wrap_i64
   i32.or
   i32.eqz
   if
    block $break|0
     block $case3|0
      block $case2|0
       block $case0|0
        local.get $11
        br_table $case0|0 $case0|0 $case2|0 $case3|0 $break|0
       end
       local.get $9
       br $__inlined_func$~lib/math/NativeMath.atan2
      end
      f64.const 3.141592653589793
      br $__inlined_func$~lib/math/NativeMath.atan2
     end
     f64.const -3.141592653589793
     br $__inlined_func$~lib/math/NativeMath.atan2
    end
   end
   block $folding-inner0
    local.get $6
    i32.const 2147483647
    i32.and
    local.tee $6
    local.get $2
    i32.or
    i32.eqz
    br_if $folding-inner0
    local.get $6
    i32.const 2146435072
    i32.eq
    if
     local.get $10
     i32.const 2146435072
     i32.eq
     if (result f64)
      f64.const 2.356194490192345
      f64.const 0.7853981633974483
      local.get $11
      i32.const 2
      i32.and
      select
      local.tee $1
      f64.neg
      local.get $1
      local.get $11
      i32.const 1
      i32.and
      select
     else
      f64.const 3.141592653589793
      f64.const 0
      local.get $11
      i32.const 2
      i32.and
      select
      local.tee $1
      f64.neg
      local.get $1
      local.get $11
      i32.const 1
      i32.and
      select
     end
     br $__inlined_func$~lib/math/NativeMath.atan2
    end
    local.get $10
    i32.const 2146435072
    i32.eq
    local.get $6
    i32.const 67108864
    i32.add
    local.get $10
    i32.lt_u
    i32.or
    br_if $folding-inner0
    local.get $10
    i32.const 67108864
    i32.add
    local.get $6
    i32.lt_u
    i32.const 0
    local.get $11
    i32.const 2
    i32.and
    select
    if (result f64)
     f64.const 0
    else
     local.get $9
     local.get $1
     f64.div
     f64.abs
     call $~lib/math/NativeMath.atan
    end
    local.set $1
    block $break|1
     block $case3|1
      block $case2|1
       block $case1|1
        block $case0|1
         local.get $11
         br_table $case0|1 $case1|1 $case2|1 $case3|1 $break|1
        end
        local.get $1
        br $__inlined_func$~lib/math/NativeMath.atan2
       end
       local.get $1
       f64.neg
       br $__inlined_func$~lib/math/NativeMath.atan2
      end
      f64.const 3.141592653589793
      local.get $1
      f64.const -1.2246467991473532e-16
      f64.add
      f64.sub
      br $__inlined_func$~lib/math/NativeMath.atan2
     end
     local.get $1
     f64.const -1.2246467991473532e-16
     f64.add
     f64.const -3.141592653589793
     f64.add
     br $__inlined_func$~lib/math/NativeMath.atan2
    end
    unreachable
   end
   f64.const -1.5707963267948966
   f64.const 1.5707963267948966
   local.get $11
   i32.const 1
   i32.and
   select
  end
  f32.demote_f64
  local.get $7
  f32.sub
  local.set $0
  loop $while-continue|0
   local.get $0
   f32.const 3.1415927410125732
   f32.gt
   if
    local.get $0
    f32.const -6.2831854820251465
    f32.add
    local.set $0
    br $while-continue|0
   end
  end
  loop $while-continue|1
   local.get $0
   f32.const -3.1415927410125732
   f32.lt
   if
    local.get $0
    f32.const 6.2831854820251465
    f32.add
    local.set $0
    br $while-continue|1
   end
  end
  f32.const -1
  f32.const 1
  local.get $0
  f32.const 1.5
  f32.mul
  local.tee $0
  local.get $0
  f32.const 1
  f32.gt
  select
  local.get $0
  f32.const -1
  f32.lt
  select
  local.set $0
  f32.const 0.5
  f32.const 1
  local.get $3
  f32.const 6
  f32.lt
  select
  local.set $3
  i32.const 10
  call $behaviors/host/read
  local.tee $7
  f32.const 5
  f32.lt
  if
   i32.const 11
   call $behaviors/host/read
   f32.neg
   local.set $0
   f32.const 0.4000000059604645
   local.set $3
   f32.const 1
   f32.const 0.5
   f32.const 0
   call $behaviors/host/set_led
   i32.const 2
   local.get $7
   call $behaviors/host/log
  else
   f32.const 0.20000000298023224
   f32.const 0.6000000238418579
   f32.const 1
   call $behaviors/host/set_led
  end
  local.get $3
  local.get $0
  call $behaviors/host/drive
 )
 (func $behaviors/patrol/init
  i32.const 0
  call $behaviors/host/read
  global.set $behaviors/patrol/originX
  i32.const 1
  call $behaviors/host/read
  global.set $behaviors/patrol/originZ
  i32.const 0
  call $behaviors/host/mem_get
  i32.trunc_sat_f32_s
  global.set $behaviors/patrol/corner
  f32.const 0.20000000298023224
  f32.const 0.6000000238418579
  f32.const 1
  call $behaviors/host/set_led
 )
)
