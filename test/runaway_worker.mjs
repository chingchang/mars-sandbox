import { readFileSync } from "node:fs";
import { parentPort } from "node:worker_threads";
const bytes = readFileSync(new URL("../build/runaway.wasm", import.meta.url));
let t = 0;
const host = { read: k => (k===6 ? t : 0), drive(){}, set_arm(){}, set_led(){}, log(){}, mem_get(){return 0}, mem_set(){} };
const { instance } = await WebAssembly.instantiate(bytes, { host });
instance.exports.init();
for (let i=0;i<100;i++) { instance.exports.tick(0.1); t += 0.1; }   // passes 3 s, then hangs
parentPort.postMessage("runaway returned (should not happen)");
