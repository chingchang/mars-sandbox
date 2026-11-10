// Bundle web/app.html + compiled behaviors into a single self-contained dist/index.html
import { readFileSync, writeFileSync, mkdirSync, cpSync } from "node:fs";

const META = [
  { name:"patrol", label:"Patrol square", prompt:"make the rover patrol a 30 m square around where it started and avoid rocks",
    logNames:{1:"reached corner", 2:"dodging rock at (m)"} },
  { name:"return_home", label:"Auto-return to charger", prompt:"wander around, and return to the charger automatically when low on power",
    logNames:{10:"state (0 explore, 1 returning, 2 charging)", 11:"battery"} },
  { name:"seek_target", label:"Go where I tap", prompt:"go to the spot I click on, carefully on hills",
    logNames:{20:"arrived, distance", 21:"steep slope (rad)"} },
  { name:"runaway", label:"Broken module (infinite loop)", danger:true, prompt:"(a buggy generation: hangs after 3 s so you can watch the watchdog)",
    logNames:{99:"about to hang"} },
];

const behaviors = META.map(m => ({
  ...m,
  source: readFileSync(`behaviors/${m.name}.ts`, "utf8"),
  wasm: readFileSync(`build/${m.name}.wasm`).toString("base64"),
}));

const host = readFileSync("behaviors/host.ts", "utf8").replace(/<\/script/gi, "<\\/script");
let html = readFileSync("web/app.html", "utf8");
html = html.replace("/*__BEHAVIORS__*/", JSON.stringify(behaviors).replace(/<\/script/gi, "<\\/script"));
html = html.replace("/*__HOST__*/", host);
mkdirSync("dist", { recursive: true });
writeFileSync("dist/index.html", html);
// terrain heightmaps and the 16-bit PNG decoder are fetched at runtime, not embedded
cpSync("web/terrain", "dist/terrain", { recursive: true });
cpSync("web/png16.mjs", "dist/png16.mjs");
cpSync("runtime", "dist/runtime", { recursive: true });
console.log(`dist/index.html written (${(html.length/1024).toFixed(0)} KB)`);
