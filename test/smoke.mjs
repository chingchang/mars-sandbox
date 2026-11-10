// Generic smoke test for any behavior: illegal imports, traps, hangs, per-tick budget,
// and "does it ever call drive()". Used by generate.py before a module is accepted.
import { readFileSync } from "node:fs";
import { Worker } from "node:worker_threads";

const name = process.argv[2];
const bytes = readFileSync(new URL(`../build/${name}.wasm`, import.meta.url));
const mod = await WebAssembly.compile(bytes);
const ALLOWED = new Set(["read","drive","set_arm","set_led","log","mem_get","mem_set",
  "spawn","pose","remove","state_set","signal_emit","signal_read","terrain_height","nearest","nearest_bearing","fact","fact_tier"]);
for (const i of WebAssembly.Module.imports(mod))
  if (i.module !== "host" || !ALLOWED.has(i.name)) { console.log(`illegal import ${i.module}.${i.name}`); process.exit(1); }
const ex = WebAssembly.Module.exports(mod).map(e=>e.name);
if (!ex.includes("init") || !ex.includes("tick")) { console.log("must export init() and tick(dt)"); process.exit(1); }

// the mock fact table serves the real sol length from facts/index.json under its real key (no number typed here)
const INDEX = JSON.parse(readFileSync(new URL("../facts/index.json", import.meta.url), "utf8"));
const KEYS = JSON.parse(readFileSync(new URL("../runtime/fact_keys.json", import.meta.url), "utf8"));
const SOL = INDEX.facts["mars.time.sol"].value, SOL_KEY = KEYS.keys["mars.time.sol"];
const code = `
  import { parentPort, workerData } from "node:worker_threads";
  let t=0, drives=0, worst=0, handles=0; const mem=new Float32Array(64);
  const sens = k => [Math.sin(t)*20, Math.cos(t)*20, t*0.1, 1.5, Math.max(0,1-t/200), 60, t, 15, 0.3, 0.05, (t%20<2)?3:99, 1, 30, -0.4][k] ?? 0;
  // "drives" counts any actuator: drive, spawn, pose, state_set, signal_emit (a weather station never drives)
  const SOL = ${SOL}, SOL_KEY = ${SOL_KEY};
  const host = { read: sens, drive(){drives++}, set_arm(){}, set_led(){}, log(){}, mem_get:i=>mem[i|0]??0, mem_set:(i,v)=>{mem[i|0]=v},
    spawn(){ drives++; return handles < 32 ? handles++ : -1; }, pose(){drives++}, remove(){}, state_set(){drives++}, signal_emit(){drives++}, signal_read(){return 0},
    terrain_height(){return 0}, nearest(k){return k===0 ? 12 : -1}, nearest_bearing(){return 0.5}, fact(k){return k===SOL_KEY ? SOL : 200}, fact_tier(){return 1} };
  const { instance } = await WebAssembly.instantiate(workerData, { host });
  try {
    instance.exports.init();
    for (let i=0;i<600;i++) { const a=performance.now(); instance.exports.tick(0.05); worst=Math.max(worst,performance.now()-a); t+=0.05; }
  } catch (e) { parentPort.postMessage({ err: "trap: " + e.message }); process.exit(0); }
  parentPort.postMessage({ drives, worst });
`;
const w = new Worker(code, { eval: true, workerData: bytes });
const res = await new Promise(r => { const k = setTimeout(() => { w.terminate(); r({ err: "hang: tick() did not return within 3 s" }); }, 3000); w.on("message", m => { clearTimeout(k); r(m); }); });
if (res.err) { console.log(res.err); process.exit(1); }
if (res.drives === 0) { console.log("module never called any actuator (drive, spawn, pose, state_set, signal_emit); probably not doing anything"); process.exit(1); }
if (res.worst > 2) { console.log(`tick() took ${res.worst.toFixed(2)} ms, budget is 2 ms`); process.exit(1); }
console.log(`ok: 600 ticks, ${res.drives} actuator calls, worst tick ${res.worst.toFixed(3)} ms`);
