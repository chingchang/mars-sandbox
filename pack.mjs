// Bundle web/app.html + compiled behaviors into a single self-contained dist/index.html
import { readFileSync, writeFileSync, mkdirSync, cpSync, existsSync } from "node:fs";

const META = [
  { name:"patrol", label:"Patrol square", prompt:"make the rover patrol a 30 m square around where it started and avoid rocks",
    logNames:{1:"reached corner", 2:"dodging rock at (m)"} },
  { name:"return_home", label:"Auto-return to charger", prompt:"wander around, and return to the charger automatically when low on power",
    logNames:{10:"state (0 explore, 1 returning, 2 charging)", 11:"battery"} },
  { name:"seek_target", label:"Go where I tap", prompt:"go to the spot I click on, carefully on hills",
    logNames:{20:"arrived, distance", 21:"steep slope (rad)"} },
  { name:"runaway", label:"Broken module (infinite loop)", danger:true, prompt:"(a buggy generation: hangs after 3 s so you can watch the watchdog)",
    logNames:{99:"about to hang"} },
  // generic-API samples (X1): loadable into any object with sandbox.loadInto(id, name); the workshop panel (W2) will list them
  { name:"weather_station", label:"Weather station (generic API)", hidden:true, prompt:"a weather station: mast, panel, counts sols, pulses a signal every Mars hour",
    logNames:{30:"hourly air temperature (K)", 31:"tier of the temperature record", 32:"cold flag (1 up, 0 down)"} },
  { name:"beacon", label:"Proximity beacon (generic API)", hidden:true, prompt:"a beacon that lights up when any rover is within 20 metres",
    logNames:{50:"lit (1) / dark (0)"} },
];

const behaviors = META.map(m => ({
  ...m,
  source: readFileSync(`behaviors/${m.name}.ts`, "utf8"),
  wasm: readFileSync(`build/${m.name}.wasm`).toString("base64"),
  manifest: existsSync(`behaviors/${m.name}.manifest.json`) ? JSON.parse(readFileSync(`behaviors/${m.name}.manifest.json`, "utf8")) : null,
}));

const host = readFileSync("behaviors/host.ts", "utf8").replace(/<\/script/gi, "<\\/script");
let html = readFileSync("web/app.html", "utf8");
html = html.replace("/*__BEHAVIORS__*/", JSON.stringify(behaviors).replace(/<\/script/gi, "<\\/script"));
html = html.replace("/*__HOST__*/", host);
// where the page finds the workshop server: WORKSHOP_URL at pack time (a separate host), else the page decides at run time (see resolveWorkshopUrl)
html = html.replace("__WORKSHOP_URL__", (process.env.WORKSHOP_URL ?? "").trim().replace(/"/g, ""));
mkdirSync("dist", { recursive: true });
writeFileSync("dist/index.html", html);
// terrain heightmaps and the 16-bit PNG decoder are fetched at runtime, not embedded
cpSync("web/terrain", "dist/terrain", { recursive: true });
cpSync("web/png16.mjs", "dist/png16.mjs");
writeFileSync("dist/workshop.mjs", readFileSync("web/workshop.mjs", "utf8").replaceAll("../runtime/", "./runtime/"));   // the workshop panel (W2); runtime/ sits beside it in dist
cpSync("runtime", "dist/runtime", { recursive: true });
mkdirSync("dist/facts", { recursive: true }); cpSync("facts/index.json", "dist/facts/index.json");   // fact(key) table for the workers
console.log(`dist/index.html written (${(html.length/1024).toFixed(0)} KB)`);
