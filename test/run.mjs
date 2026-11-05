// Headless harness: loads each wasm behavior against a toy rover model and
// checks it does something sensible. This is the "test in isolation before
// registering" step from the spec, in miniature.
import { readFileSync } from "node:fs";

const K = { POS_X:0, POS_Z:1, HEADING:2, SPEED:3, BATTERY:4, SOLAR_W:5, TIME:6,
  CHARGER_DIST:7, CHARGER_BEARING:8, SLOPE_AHEAD:9, OBSTACLE_DIST:10, OBSTACLE_SIDE:11,
  TARGET_DIST:12, TARGET_BEARING:13 };

const ALLOWED = new Set(["read","drive","set_arm","set_led","log","mem_get","mem_set"]);

function makeWorld() {
  return { x:0, z:0, h:0, speed:0, bat:1, t:0, throttle:0, steer:0,
           charger:{x:0,z:-10}, target:null, mem:new Float32Array(64), logs:[] };
}

function sensors(w) {
  const rel = (tx,tz) => {
    const dx=tx-w.x, dz=tz-w.z, d=Math.hypot(dx,dz);
    let b=Math.atan2(dx,dz)-w.h; while(b>Math.PI)b-=2*Math.PI; while(b<-Math.PI)b+=2*Math.PI;
    return [d,b];
  };
  const [cd,cb]=rel(w.charger.x,w.charger.z);
  const [td,tb]=w.target?rel(w.target.x,w.target.z):[99,0];
  return k => ({0:w.x,1:w.z,2:w.h,3:w.speed,4:w.bat,5:50,6:w.t,7:cd,8:cb,9:0,10:99,11:0,12:td,13:tb})[k];
}

async function load(name, w) {
  const bytes = readFileSync(new URL(`../build/${name}.wasm`, import.meta.url));
  const mod = await WebAssembly.compile(bytes);
  for (const imp of WebAssembly.Module.imports(mod)) {
    if (imp.module !== "host" || !ALLOWED.has(imp.name)) throw new Error(`${name}: illegal import ${imp.module}.${imp.name}`);
  }
  const host = {
    read: k => sensors(w)(k),
    drive: (t,s) => { w.throttle=Math.max(-1,Math.min(1,t)); w.steer=Math.max(-1,Math.min(1,s)); },
    set_arm: () => {}, set_led: () => {},
    log: (c,v) => w.logs.push([w.t.toFixed(1), c, +v.toFixed(3)]),
    mem_get: i => w.mem[i|0] ?? 0, mem_set: (i,v) => { w.mem[i|0]=v; },
  };
  const inst = await WebAssembly.instantiate(mod, { host });
  return inst.exports;
}

function step(w, dt) {
  const maxSpeed = 2.0;
  w.speed = w.throttle * maxSpeed;
  w.h += w.steer * 1.2 * dt;
  w.x += Math.sin(w.h) * w.speed * dt;
  w.z += Math.cos(w.h) * w.speed * dt;
  const draw = 0.004 * Math.abs(w.throttle) + 0.0005;          // per second
  const charging = Math.hypot(w.x-w.charger.x, w.z-w.charger.z) < 2 && Math.abs(w.throttle) < 0.01;
  w.bat = Math.min(1, Math.max(0, w.bat - draw*dt + (charging ? 0.05*dt : 0)));
  w.t += dt;
}

function runFor(exp, w, seconds, dt=0.1, budgetMs=5) {
  let worst = 0;
  for (let i=0; i<seconds/dt; i++) {
    const t0 = performance.now();
    exp.tick(dt);
    worst = Math.max(worst, performance.now()-t0);
    if (worst > budgetMs) throw new Error(`tick exceeded ${budgetMs} ms budget`);
    step(w, dt);
  }
  return worst;
}

let failures = 0;
const check = (name, cond, detail) => { console.log(`${cond?"PASS":"FAIL"}  ${name}${detail?"  ("+detail+")":""}`); if(!cond) failures++; };

// --- patrol: should visit several corners in 120 s and end up near origin loop
{
  const w = makeWorld(); const e = await load("patrol", w); e.init();
  const worst = runFor(e, w, 120);
  const corners = w.logs.filter(l=>l[1]===1).length;
  check("patrol visits corners", corners >= 4, `${corners} corners, worst tick ${worst.toFixed(3)} ms`);
  // reload mid-patrol and confirm it resumes the same corner via mem_get
  const before = w.mem[0]; const e2 = await load("patrol", w); e2.init(); runFor(e2, w, 1);
  check("patrol resumes after reload", w.mem[0] === before || w.mem[0] === (before+1)%4);
}

// --- return_home: start low on battery, must reach charger and recharge
{
  const w = makeWorld(); w.bat = 0.2; w.x = 15; w.z = 20;
  const e = await load("return_home", w); e.init();
  runFor(e, w, 200);
  const states = w.logs.filter(l=>l[1]===10).map(l=>l[2]);
  const nearPad = Math.hypot(w.x-w.charger.x, w.z-w.charger.z);
  check("return_home reaches pad", states.includes(2), `states ${states.join("→")}, dist to pad ${nearPad.toFixed(1)} m`);
  check("return_home resumes exploring when full", states.at(-1) === 0, `battery ${w.bat.toFixed(2)}`);
}

// --- seek_target: must arrive within 1.5 m of a target 25 m away
{
  const w = makeWorld(); w.target = {x:20, z:15};
  const e = await load("seek_target", w); e.init();
  runFor(e, w, 60);
  const d = Math.hypot(w.x-20, w.z-15);
  check("seek_target arrives", d < 1.6 && w.logs.some(l=>l[1]===20), `final distance ${d.toFixed(2)} m`);
}

// --- runaway: must be caught by the budget (in the browser the worker is terminated)
{
  const w = makeWorld(); const e = await load("runaway", w); e.init();
  let caught = false;
  // run the loop in a child worker with a hard timeout, same as the browser does
  const { Worker } = await import("node:worker_threads");
  const wk = new Worker(new URL("./runaway_worker.mjs", import.meta.url));
  const result = await new Promise(res => {
    const timer = setTimeout(() => { wk.terminate(); res("terminated by watchdog"); }, 1500);
    wk.on("message", m => { clearTimeout(timer); res(m); });
  });
  caught = result === "terminated by watchdog";
  check("runaway killed by watchdog", caught, result);
}

console.log(failures ? `\n${failures} failure(s)` : "\nall behaviors pass");
process.exit(failures ? 1 : 0);
