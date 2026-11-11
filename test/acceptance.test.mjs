// A1 scaffolding: the behaviour checks judge the samples and the fixtures the way the acceptance
// runs will be judged (with a module that must fail each check); the runner runs against a recorded
// model in-process; the judge turns a transcript into a verdict. No network, no key.
import { test, after } from "node:test";
import assert from "node:assert/strict";
import { readFileSync, writeFileSync, mkdtempSync, readdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { createHash } from "node:crypto";
import { compileAndTest } from "../workshop/compile.mts";
import { createWorkshopServer } from "../workshop/server.mts";
import { LlmError } from "../workshop/llm.mts";
import { readIndex, readKeys } from "../workshop/prompt.mts";
import { CHECKS, weatherStation, beacon, solarPanel, creature, dustGauge, occluded } from "./acceptance/behaviour.mjs";
import { judgeTranscript, listTranscripts, questionsBeforeBuild, summarize } from "./acceptance/judge.mjs";
import { questionFactIds, otherFactIds, numbersWithoutFacts, unsourcedNumbersIn, transcriptName, ACCEPTANCE_PROMPTS, runPrompt } from "../workshop/acceptance/run.mts";

const read = p => readFileSync(new URL(p, import.meta.url));
const wasm = name => new Uint8Array(read(`../build/${name}.wasm`));
const fixtureSrc = name => read(`./acceptance/fixtures/${name}.ts`).toString("utf8");
const fixture = async name => { const r = await compileAndTest(fixtureSrc(name)); assert.ok(r.ok, `${name} builds and passes the smoke test: ${r.ok ? "" : r.error}`); return r.wasm; };
const index = readIndex(), keys = readKeys();
const STATION_SRC = read("../behaviors/weather_station.ts").toString("utf8");
const STATION_MANIFEST = JSON.parse(read("../behaviors/weather_station.manifest.json"));
const QUESTION = "Should it read at 1.45 m like the MEDA mast [jezero.temperature.my36_air_hourly_mean]?";
const moduleReply = (manifest, source) => `===MANIFEST===\n${JSON.stringify(manifest)}\n===SOURCE===\n${source}===EXPLANATION===\nIt uses the hourly record [jezero.temperature.my36_air_hourly_mean]; the threshold is yours.\n`;
function recorded(script) { const calls = []; return { calls, llm: async (system, messages) => { calls.push(messages.map(m => ({ ...m }))); if (!script.length) throw new Error("script exhausted"); const next = script.shift(); if (next instanceof Error) throw next; return next; } }; }
/** An in-process stand-in for startChildServer: the real createWorkshopServer with a recorded model. */
const inProcess = llm => async () => { const srv = createWorkshopServer({ llm, index, keys }); const port = await new Promise(r => srv.listen(0, "127.0.0.1", () => r(srv.address().port))); const url = `http://127.0.0.1:${port}`; const health = await (await fetch(url + "/health")).json(); return { url, health, stop: () => srv.close() }; };
const tmp = () => mkdtempSync(path.join(tmpdir(), "acceptance-"));
after(() => setTimeout(() => process.exit(0), 200).unref());

test("the five prompts are the brief's, verbatim; transcript names carry the prompt and a timestamp", () => {
  assert.equal(ACCEPTANCE_PROMPTS.length, 5);
  assert.match(ACCEPTANCE_PROMPTS[0], /^A weather station that logs temperature every hour/);
  assert.match(ACCEPTANCE_PROMPTS[4], /dust optical depth\.$/);
  assert.equal(transcriptName(2, ACCEPTANCE_PROMPTS[1], new Date("2026-11-11T17:00:00Z")), "2-a-beacon-that-lights-up-when-any-rover-is-20261111T170000Z.json");
});

test("fact ids in a question: brackets count, other punctuation is recorded apart; unsourced numbers are found in the forms a model writes them", () => {
  assert.deepEqual(questionFactIds("Should it read at 1.45 m [jezero.temperature.my36_air_hourly_mean]?"), ["jezero.temperature.my36_air_hourly_mean"]);
  assert.deepEqual(questionFactIds("Should it read at 1.45 m [no.such.fact]?"), []);
  assert.deepEqual(questionFactIds("about `jezero.dust.optical_depth_typical`"), [], "superseded ids do not count");
  assert.deepEqual(otherFactIds("See `mars.time.sol` and (jezero.dust.optical_depth_background_my36) and [mars.gravity.surface_equatorial]."), ["mars.time.sol", "jezero.dust.optical_depth_background_my36"]);
  assert.deepEqual(numbersWithoutFacts("The sol is 88775 s [mars.time.sol]. The flag is 0.5 m tall."), []);
  assert.deepEqual(numbersWithoutFacts("Mars gets 586 W/m^2 on average, and nights reach 190 K."), ["586 W/m^2", "190 K"]);
  const forms = "It gets to minus 80 degrees at night, or −70 °C; pressure is 7 millibars (610 pascals); a year is 687 days; 95% of the air is CO2; the sun gives 586 watts per square metre; gravity is 3.71 m/s^2.";
  const found = numbersWithoutFacts(forms);
  for (const want of ["minus 80 degrees", "−70 °C", "7 millibars", "610 pascals", "687 days", "95 %", "586 watts per square metre", "3.71 m/s^2"]) assert.ok(found.includes(want), `${want} in ${JSON.stringify(found)}`);
  assert.deepEqual(numbersWithoutFacts("Nights reach 190 K and the sol is 88775 s [mars.time.sol]."), ["190 K"], "a cited id covers the number before it, not every number in the sentence");
  const all = unsourcedNumbersIn({ questions: [{ text: "Is 95% CO2 fine?" }], explanation: "ok [mars.time.sol]", manifest: { description: "reads 7 mbar", state: [{ label: "temp at 1.45 m" }], did_you_know: { text: "a sol is 88775 s [mars.time.sol]" } }, source: "// nights hit 190 K\nconst x: f32 = 1.0; /* 586 W/m^2 */" });
  assert.deepEqual(Object.keys(all).sort(), ["manifest.description", "question 1", "source comments"]);
  assert.deepEqual(all["source comments"], ["190 K", "586 W/m^2"]);
});

test("check 1: the weather station sample passes; a module that never logs or flags fails; one that logs every tick fails on cadence; thresholds of 240 K and 197 K fail", async () => {
  const r = await weatherStation(wasm("weather_station"), STATION_MANIFEST);
  assert.equal(r.pass, true, r.evidence.join(" | ")); assert.match(r.evidence[0], /^2[0-9] ticks with a log/); assert.match(r.evidence[2], /5 h \(19[0-9]\.\d K\): red shape at y/); assert.match(r.evidence[2], /1\.5 h \(20[01]\.\d K\): red shape at y/); assert.match(r.evidence[2], /7\.5 h \(20[5-7]\.\d K\): red shape none/);
  for (const k of ["240.0", "197.0"]) {
    const c = await compileAndTest(STATION_SRC.replace("const COLD_K: f32 = 203.15;", `const COLD_K: f32 = ${k};`)); assert.ok(c.ok);
    const t = await weatherStation(c.wasm, STATION_MANIFEST);
    assert.equal(t.pass, false, `${k} K threshold: ${t.evidence.join(" | ")}`);
  }
  const idle = await weatherStation(wasm("patrol"), null);
  assert.equal(idle.pass, false, idle.evidence.join(" | "));
  const chatty = STATION_SRC.replace("log(LOG_HOUR, temp);                                 // the hourly temperature log", "").replace("state_set(SLOT_T_NOW_K, temp);", "state_set(SLOT_T_NOW_K, temp); log(LOG_HOUR, temp);");
  const c = await compileAndTest(chatty); assert.ok(c.ok, c.ok ? "" : c.error);
  const every = await weatherStation(c.wasm, STATION_MANIFEST);
  assert.equal(every.pass, false, every.evidence.join(" | ")); assert.match(every.evidence.join(" | "), /not one log per hour change/);
});

test("check 2: the beacon sample passes at the 20 m line; 16 m and 24 m radii fail; an unchanging shape fails", async () => {
  const r = await beacon(wasm("beacon"), null);
  assert.equal(r.pass, true, r.evidence.join(" | "));
  const src = read("../behaviors/beacon.ts").toString("utf8");
  for (const radius of ["16.0", "24.0"]) {
    const c = await compileAndTest(src.replace("const TRIGGER_M: f32 = 20.0;", `const TRIGGER_M: f32 = ${radius};`)); assert.ok(c.ok);
    const b = await beacon(c.wasm, null);
    assert.equal(b.pass, false, `${radius} m: ${b.evidence.join(" | ")}`);
  }
  const inverted = await compileAndTest(src.replace("(d >= 0.0 && d < TRIGGER_M) ? 1 : 0", "(d >= 0.0 && d < TRIGGER_M) ? 0 : 1")); assert.ok(inverted.ok);
  const inv = await beacon(inverted.wasm, null);
  assert.equal(inv.pass, false, `inverted: ${inv.evidence.join(" | ")}`); assert.match(inv.evidence.join(" | "), /not a lighting-up/);
  assert.equal((await beacon(wasm("churn"), null)).pass, false);
});

test("check 3: the solar-panel fixture passes, also when it parks at night; the beacon fails", async () => {
  const r = await solarPanel(await fixture("solar_panel"), null);
  assert.equal(r.pass, true, r.evidence.join(" | ")); assert.match(r.evidence[0], /settled at every hour/); assert.match(r.evidence[1], /one direction/); assert.ok(r.evidence.some(e => /at noon/.test(e)), r.evidence.join(" | "));
  const parking = fixtureSrc("solar_panel").replace("pose(panel, 0.0, 1.4, 0.0, yaw, 0.3);", "pose(panel, 0.0, 1.4, 0.0, elev > 0.0 ? yaw : 0.0, 0.3);");
  const c = await compileAndTest(parking); assert.ok(c.ok, c.ok ? "" : c.error);
  const p = await solarPanel(c.wasm, { name: "p", description: "d", version: 1, author: "a", state: [{ slot: 0, label: "output", unit: "W" }, { slot: 1, label: "yaw", unit: "rad" }] });
  assert.equal(p.pass, true, p.evidence.join(" | ")); assert.ok(p.evidence.some(e => /^"output" \(W\)/.test(e)), p.evidence.join(" | "));
  assert.ok(r.evidence.some(e => /settled pitch at/.test(e)), "the settled pitch per hour is in the evidence for single-axis trackers");
  const slowMotor = await compileAndTest(fixtureSrc("solar_panel_motor").replaceAll("0.5 * dt", "0.2 * dt")); assert.ok(slowMotor.ok);
  const sm = await solarPanel(slowMotor.wasm, null);
  assert.equal(sm.pass, true, `0.2 rad/s motor: ${sm.evidence.join(" | ")}`);
  const spin = await solarPanel(await fixture("solar_panel_spin"), null);
  assert.equal(spin.pass, false, spin.evidence.join(" | ")); assert.match(spin.evidence[0], /never settled/);
  const motor = await solarPanel(await fixture("solar_panel_motor"), { name: "m", description: "d", version: 1, author: "a", state: [{ slot: 0, label: "output", unit: "W" }] });
  assert.equal(motor.pass, true, motor.evidence.join(" | ")); assert.match(motor.evidence[0], /settled at every hour/);
  assert.equal((await solarPanel(wasm("beacon"), null)).pass, false);
});

test("check 4: occlusion geometry; the creature fixture hides; the wander-only control and the patrol sample do not", async () => {
  assert.ok(occluded({ x: 0, z: 0 }, { x: 10, z: 0 }, [{ x: 5, z: 1.0, r: 1.2 }]), "a rock 1 m off the line, between");
  assert.equal(occluded({ x: 0, z: 0 }, { x: 10, z: 0 }, [{ x: 5, z: 2.0, r: 1.2 }]), null, "2 m off the line is not occlusion");
  assert.equal(occluded({ x: 0, z: 0 }, { x: 10, z: 0 }, [{ x: 12, z: 0, r: 1.2 }]), null, "beyond the rover is not between");
  const r = await creature(await fixture("creature"), null);
  assert.equal(r.pass, true, r.evidence.join(" | ")); assert.match(r.evidence[1], /it reacted to the rover/); assert.match(r.evidence[2], /it stopped after/); assert.match(r.evidence[3], /^then occluded in (8|9|10) of 10 samples/); assert.match(r.evidence[4], /no rock between them/);
  const w = await creature(await fixture("wander_only"), null);
  assert.equal(w.pass, false, w.evidence.join(" | ")); assert.match(w.evidence[1], /no reaction to the rover/);
  const fast = await compileAndTest(fixtureSrc("wander_only").replace("phase += dt * 0.7; drive(0.5, Mathf.sin(phase) * 0.6);", "phase += dt * 1.3; drive(0.6, Mathf.sin(phase) * 0.5);")); assert.ok(fast.ok);
  const f = await creature(fast.wasm, null);
  assert.equal(f.pass, false, `faster wanderer: ${f.evidence.join(" | ")}`); assert.match(f.evidence[1], /no reaction to the rover/);
  const slow = await compileAndTest(fixtureSrc("creature").replace("drive(dist > 0.8 ? 0.9 : 0.0, clamp(err * 1.5, -1.0, 1.0));", "drive(dist > 0.8 ? 0.3 : 0.0, clamp(err * 1.5, -1.0, 1.0));")); assert.ok(slow.ok);
  const s = await creature(slow.wasm, null);
  assert.equal(s.pass, true, `slow hider: ${s.evidence.join(" | ")}`); assert.match(s.evidence[2], /it stopped after/);
  assert.equal((await creature(wasm("patrol"), null)).pass, false);
});

test("check 5: the dust-gauge fixture's estimate rises fourfold with the tau facts; a tau copy alone fails; a storm-tau gauge passes; the weather station fails", async () => {
  const r = await dustGauge(await fixture("dust_gauge"), null);
  assert.equal(r.pass, true, r.evidence.join(" | ")); assert.match(r.evidence[1], /ratio 4\.00/);
  const copyOnly = fixtureSrc("dust_gauge").replace("dirt += tau * dt * 0.01;", "dirt = 0.0;");
  const c = await compileAndTest(copyOnly); assert.ok(c.ok);
  const cp = await dustGauge(c.wasm, null);
  assert.equal(cp.pass, false, cp.evidence.join(" | "));
  const storm = fixtureSrc("dust_gauge").replaceAll("FACT_JEZERO_DUST_OPTICAL_DEPTH_BACKGROUND_MY36", "FACT_JEZERO_DUST_OPTICAL_DEPTH_STORM_JAN2022");
  const s = await compileAndTest(storm); assert.ok(s.ok);
  const st = await dustGauge(s.wasm, { name: "g", description: "d", version: 1, author: "a", fact_ids: ["jezero.dust.optical_depth_storm_jan2022"], state: [{ slot: 0, label: "dirt estimate" }, { slot: 1, label: "tau" }] });
  assert.equal(st.pass, true, st.evidence.join(" | ")); assert.match(st.evidence[1], /^"dirt estimate"/);
  const quarter = await compileAndTest(fixtureSrc("dust_gauge").replace("state_set(0, dirt); state_set(1, tau);", "state_set(0, dirt); state_set(1, tau * 0.25);")); assert.ok(quarter.ok);
  const q = await dustGauge(quarter.wasm, null);
  assert.equal(q.pass, true, `tau * 0.25 reading: ${q.evidence.join(" | ")}`);
  const hourly = await dustGauge(await fixture("dust_gauge_hourly"), null);
  assert.equal(hourly.pass, true, `hourly gauge: ${hourly.evidence.join(" | ")}`); assert.match(hourly.evidence[1], /ratio 4\.00/);
  assert.equal((await dustGauge(wasm("weather_station"), null)).pass, false);
  assert.deepEqual(Object.keys(CHECKS), ["1", "2", "3", "4", "5"]);
});

test("runner: question then module, recorded in full; a declined turn with a follow-up; a failed build with every try's source; never overwrites; writes even when the server will not start", async () => {
  const dir = tmp();
  try {
    const good = recorded([QUESTION, moduleReply(STATION_MANIFEST, STATION_SRC)]);
    const t = await runPrompt(1, { answers: ["1.45 m, and -70 C is mine"], startServer: inProcess(good.llm), outDir: dir, quiet: true });
    assert.equal(t.result, "module"); assert.equal(t.tries, 1); assert.equal(t.question_fact_grounded, true); assert.deepEqual(t.questions[0].fact_ids, ["jezero.temperature.my36_air_hourly_mean"]);
    assert.equal(t.model, "claude-opus-5-5"); assert.match(t.system_sha256, /^[0-9a-f]{64}$/); assert.match(t.git_head, /^[0-9a-f]{40}$/);
    assert.equal(t.turns.length, 2); assert.equal(t.turns[1].request_messages.length, 3);
    assert.equal(t.wasm_sha256, createHash("sha256").update(Buffer.from(t.wasm_base64, "base64")).digest("hex"));
    assert.equal(t.log.length, 1); assert.equal(t.log[0].source, STATION_SRC); assert.deepEqual(JSON.parse(t.log[0].manifestText), STATION_MANIFEST);
    assert.deepEqual(Object.keys(t.numbers_without_facts).sort(), ["manifest.description", "manifest.state[2].label", "source comments"], "the aid flags the player's -70 C and the source comments; did_you_know is tied to its fact_id field");
    assert.deepEqual(t.numbers_without_facts["source comments"], ["203.15 K", "-70 C", "-70 C"]);
    const declined = recorded([new LlmError("the model declined this request: no", 422), QUESTION]);
    const d = await runPrompt(2, { answers: ["please try a simpler version"], startServer: inProcess(declined.llm), outDir: dir, quiet: true });
    assert.equal(d.result, "error 422"); assert.match(String(d.error), /declined/);
    assert.equal(d.after_failure_turn.type, "questions", "the operator's follow-up in the same conversation is recorded");
    assert.equal(declined.calls[1].length, 2, "the follow-up carried the history: user, user (the declined turn has no assistant text)");
    const broken = STATION_SRC.replace("let flagUp: i32 = -1;", 'let flagUp: i32 = "x";');
    const failing = recorded([moduleReply(STATION_MANIFEST, broken), moduleReply(STATION_MANIFEST, broken), moduleReply(STATION_MANIFEST, broken)]);
    const f = await runPrompt(3, { startServer: inProcess(failing.llm), outDir: dir, quiet: true });
    assert.equal(f.result, "failed"); assert.equal(f.tries, 3); assert.equal(f.log.length, 3); assert.ok(f.log.every(l => l.source === broken && !l.ok), "every failed try keeps its source");
    const again = await runPrompt(1, { answers: ["same"], startServer: inProcess(recorded([QUESTION, moduleReply(STATION_MANIFEST, STATION_SRC)]).llm), outDir: dir, quiet: true });
    assert.notEqual(again.file, t.file, "a rerun gets its own file");
    const e = await runPrompt(4, { startServer: async () => { throw new Error("no server today"); }, outDir: dir, quiet: true });
    assert.equal(e.result, "runner error"); assert.match(e.error, /no server today/);
    assert.equal(readdirSync(dir).filter(f => f.endsWith(".json")).length, 5, "five files for five runs, none overwritten");
    const ids = listTranscripts(dir).map(f => path.basename(f)[0]); assert.deepEqual(ids, ["1", "1", "2", "3", "4"]);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test("judge: a good transcript passes with evidence; failed or over-tries transcripts fail with a reason; a changed source is reported", async () => {
  const dir = tmp();
  try {
    const good = recorded([QUESTION, moduleReply(STATION_MANIFEST, STATION_SRC)]);
    const t = await runPrompt(1, { answers: ["1.45 m"], startServer: inProcess(good.llm), outDir: dir, quiet: true });
    const j = await judgeTranscript(t.file);
    assert.equal(j.verdict, "pass", JSON.stringify(j)); assert.equal(j.rebuilt, true); assert.equal(j.hash_match, true); assert.match(j.smoke, /^ok: 600 ticks/); assert.ok(j.check.evidence.length >= 3);
    const f = await runPrompt(3, { startServer: inProcess(recorded([moduleReply(STATION_MANIFEST, STATION_SRC.replace("let flagUp: i32 = -1;", 'let flagUp: i32 = "x";'))]).llm), outDir: dir, quiet: true });
    const jf = await judgeTranscript(f.file);
    assert.equal(jf.verdict, "fail"); assert.match(jf.why, /no module/);
    assert.deepEqual(questionsBeforeBuild(JSON.parse(readFileSync(t.file, "utf8"))), [QUESTION]);
    const tamper = async (name, mutate, expectVerdict, expectWhy) => { const x = JSON.parse(readFileSync(t.file, "utf8")); mutate(x); const f2 = path.join(dir, `1-${name}.json`); writeFileSync(f2, JSON.stringify(x)); const j2 = await judgeTranscript(f2); assert.equal(j2.verdict, expectVerdict, `${name}: ${j2.why}`); assert.match(j2.why, expectWhy, name); return j2; };
    await tamper("source-edited", x => { x.source = x.source.replace("COLD_K: f32 = 203.15", "COLD_K: f32 = 210.0"); }, "inconsistent", /source does not rebuild to the recorded sha256/);
    await tamper("source-swapped", x => { x.source = fixtureSrc("dust_gauge").replace("dirt += tau * dt * 0.01;", "dirt = 0.0;"); }, "inconsistent", /source does not rebuild/);
    await tamper("bytes-swapped", x => { x.wasm_base64 = Buffer.from(read("../build/patrol.wasm")).toString("base64"); }, "inconsistent", /recorded bytes do not hash/);
    await tamper("question-emptied", x => { x.turns[0].answer.text = "Sure, building it now."; x.questions = [{ text: "", fact_ids: [] }]; x.question_fact_grounded = true; }, "fail", /no fact-grounded question/);
    await tamper("questions-removed", x => { x.turns = x.turns.filter(u => u.answer.type !== "questions"); delete x.questions; x.question_fact_grounded = true; }, "fail", /no fact-grounded question/);
    const jr = await tamper("other-punctuation", x => { x.turns[0].answer.text = "Should it read at 1.45 m like the MEDA mast `jezero.temperature.my36_air_hourly_mean`?"; }, "reviewer", /without brackets/);
    assert.deepEqual(jr.question_other_ids, ["jezero.temperature.my36_air_hourly_mean"]);
    await tamper("three-tries", x => { x.tries = 3; x.log = [x.log[0], x.log[0], x.log[0]]; }, "fail", /3 tries/);
    await tamper("tries-vs-log", x => { x.log = [x.log[0], x.log[0], x.log[0]]; }, "inconsistent", /tries is 1 but the log holds 3/);
    await tamper("other-prompt", x => { x.turns[0].request_messages[0].content = "A beacon, please."; }, "inconsistent", /first message is not the acceptance prompt/);
    const groups = summarize([{ system_sha256: "a", verdict: "pass", prompt_number: 1 }, { system_sha256: "a", verdict: "fail", prompt_number: 2 }, { system_sha256: "b", verdict: "reviewer", prompt_number: 1 }]);
    assert.deepEqual(groups, [{ hash: "a", total: 2, pass: 1, reviewer: 0, prompts: [1, 2] }, { hash: "b", total: 1, pass: 0, reviewer: 1, prompts: [1] }]);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});
