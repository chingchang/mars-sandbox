// A1 scaffolding: the behaviour checks judge the samples and the fixtures the way the acceptance
// runs will be judged; the runner's pieces that need no model are exercised too.
import { test, after } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { compileAndTest } from "../workshop/compile.mts";
import { CHECKS, weatherStation, beacon, solarPanel, creature, dustGauge } from "./acceptance/behaviour.mjs";
import { questionFactIds, numbersWithoutFacts, transcriptName, ACCEPTANCE_PROMPTS } from "../workshop/acceptance/run.mts";

const read = p => readFileSync(new URL(p, import.meta.url));
const wasm = name => new Uint8Array(read(`../build/${name}.wasm`));
const fixture = async name => { const r = await compileAndTest(read(`./acceptance/fixtures/${name}.ts`).toString("utf8")); assert.ok(r.ok, `${name} builds and passes the smoke test: ${r.ok ? "" : r.error}`); return r.wasm; };
after(() => setTimeout(() => process.exit(0), 200).unref());

test("the five prompts are the brief's, verbatim, and transcripts get stable names", () => {
  assert.equal(ACCEPTANCE_PROMPTS.length, 5);
  assert.match(ACCEPTANCE_PROMPTS[0], /^A weather station that logs temperature every hour/);
  assert.match(ACCEPTANCE_PROMPTS[4], /dust optical depth\.$/);
  assert.equal(transcriptName(2, ACCEPTANCE_PROMPTS[1]), "2-a-beacon-that-lights-up-when-any-rover-is.json");
});

test("a question is fact-grounded when it cites an id that is in the index; Mars numbers without a fact id nearby are flagged", () => {
  assert.deepEqual(questionFactIds("Should it read at 1.45 m [jezero.temperature.my36_air_hourly_mean]?"), ["jezero.temperature.my36_air_hourly_mean"]);
  assert.deepEqual(questionFactIds("Should it read at 1.45 m [no.such.fact]?"), []);
  assert.deepEqual(numbersWithoutFacts("The sol is 88775 s [mars.time.sol]. The flag is 0.5 m tall."), []);
  assert.deepEqual(numbersWithoutFacts("Mars gets 586 W/m^2 on average, and nights reach 190 K."), ["586 W/m^2", "190 K"]);
});

test("check 1: the weather station sample passes; a module that never logs or flags fails", async () => {
  const r = await weatherStation(wasm("weather_station"), JSON.parse(read("../behaviors/weather_station.manifest.json")));
  assert.equal(r.pass, true, r.evidence.join(" | ")); assert.match(r.evidence[0], /^2[0-9] ticks with a log/);
  const idle = await weatherStation(wasm("patrol"), null);
  assert.equal(idle.pass, false, idle.evidence.join(" | "));
});

test("check 2: the beacon sample passes; a module with one unchanging shape fails", async () => {
  const r = await beacon(wasm("beacon"), null);
  assert.equal(r.pass, true, r.evidence.join(" | "));
  const r2 = await beacon(wasm("churn"), null);
  assert.equal(r2.pass, false, r2.evidence.join(" | "));
});

test("check 3: the solar-panel fixture passes (yaw follows the hour, output higher at noon); the beacon fails", async () => {
  const r = await solarPanel(await fixture("solar_panel"), null);
  assert.equal(r.pass, true, r.evidence.join(" | ")); assert.match(r.evidence[1], /at noon/);
  assert.equal((await solarPanel(wasm("beacon"), null)).pass, false);
});

test("check 4: the creature fixture wanders and hides behind a rock; the patrol sample does not hide", async () => {
  const r = await creature(await fixture("creature"), null);
  assert.equal(r.pass, true, r.evidence.join(" | "));
  const p = await creature(wasm("patrol"), null);
  assert.equal(p.pass, false, p.evidence.join(" | "));
});

test("check 5: the dust-gauge fixture's reading rises with the tau fact; the weather station's does not", async () => {
  const r = await dustGauge(await fixture("dust_gauge"), null);
  assert.equal(r.pass, true, r.evidence.join(" | "));
  assert.equal((await dustGauge(wasm("weather_station"), null)).pass, false);
  assert.deepEqual(Object.keys(CHECKS), ["1", "2", "3", "4", "5"]);
});
