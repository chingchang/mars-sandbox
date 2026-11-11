// The workshop panel (W2): the player talks to the design agent, answers its
// questions, confirms a proposal, and watches the module get placed. Pure
// helpers (tier, citations, next steps) are exported for tests; the panel
// itself touches only the elements it is given and the callbacks the page
// passes in. It talks to the workshop server only; no key ever reaches here.
import { validateManifest } from "../runtime/manifest.mjs";   // pack.mjs rewrites this to ./runtime/ in dist

export const DEFAULT_WORKSHOP_URL = "http://127.0.0.1:8787";
export const MAX_RETRIES_WHEN_BUSY = 6;
const LOCAL_PAGE = /^(?:localhost|127\.0\.0\.1|\[::1\])$/;

/**
 * Where the page finds the workshop server, in order: ?workshop= in the page's URL, the URL
 * packed into the page (WORKSHOP_URL at pack time, for a server on another host), the local
 * server when the page itself is local (development, unchanged), else the page's own origin
 * (production: one process serves the page and the workshop).
 */
export function resolveWorkshopUrl({ search = "", packed = "", origin = "", hostname = "" } = {}) {
  const param = new URLSearchParams(search).get("workshop");
  if (param) return param;
  if (packed && packed.trim() && packed.trim() !== "__WORKSHOP_URL__") return packed.trim();
  if (LOCAL_PAGE.test(hostname) || !origin || origin === "null") return DEFAULT_WORKSHOP_URL;
  return origin;
}

/** The weakest provenance tier among fact ids, by the index's tier order (strongest first); null when none resolve. */
export function weakestTier(index, factIds) {
  const order = index?.tier_order ?? [];
  let worst = null, rank = -1;
  for (const id of factIds ?? []) {
    const f = index?.facts?.[id]; if (!f) continue;
    const r = order.indexOf(f.tier);
    if (r > rank) { rank = r; worst = f.tier; }
  }
  return worst;
}

/** Citations for a fact id from the index: [{ source_id, citation, url }], plus the record's label and tier. */
export function citationsFor(index, factId) {
  const f = index?.facts?.[factId];
  if (!f) return { known: false, label: factId, tier: null, superseded_by: null, sources: [] };
  const sources = (f.source_ids ?? []).map(sid => { const s = index.sources?.[sid]; return { source_id: sid, citation: s?.citation ?? sid, url: s?.urls?.[0] ?? null }; });
  return { known: true, label: f.label, tier: f.tier, superseded_by: f.superseded_by ?? null, sources };
}

/** Fact ids mentioned in prose as [some.fact.id]. */
export function citedIds(text) {
  return [...new Set([...(text ?? "").matchAll(/\[([a-z][a-z0-9_]*(?:\.[a-z0-9_]+)+)\]/g)].map(m => m[1]))];
}

/**
 * Turn a workshop outcome that is not a module into a next step for the player: what happened in
 * plain words and a question or action that moves the design forward. Never a "no".
 */
export function nextStepFor(outcome) {
  const { kind } = outcome;
  if (kind === "failed") {
    const last = (outcome.error ?? "").split("\n").slice(0, 3).join(" ").slice(0, 300);
    return { title: `The workshop tried ${outcome.tries} time${outcome.tries === 1 ? "" : "s"} and could not get this version through its tests.`,
      detail: `Last problem: ${last}`, question: "What would you like to change? A simpler first version often builds on the first try; or ask the agent what it would simplify.", retry: false };
  }
  if (kind === "declined") return { title: "The design agent stepped back from this one.", detail: outcome.message ?? "", question: "Try describing what it should do in the world, or ask the agent what it could build toward the same goal.", retry: false };
  if (kind === "busy" && outcome.exhausted) return { title: `The workshop is still busy after ${outcome.attempts} tries.`, detail: "Other builds are ahead of yours.", question: "Your message is back in the box: send it again in a minute.", retry: false };
  if (kind === "busy") return { title: "The workshop is busy with other builds.", detail: `Trying again in ${outcome.retryAfter} s.`, question: null, retry: true };
  if (kind === "unreachable") return { title: `The workshop server is not reachable at ${outcome.url}.`,
    detail: "Start it with `npm run workshop` in the project folder, and open this page from http://localhost:8000 (a page opened as a file cannot reach it).", question: "Once it is running, send your message again.", retry: false };
  if (kind === "refused") return { title: "The workshop would not take that request.", detail: outcome.message ?? "", question: "Try a shorter message, or reload the page from http://localhost:8000.", retry: false };
  if (kind === "unauthorized") return { title: outcome.hadCode ? "That access code was not accepted." : "This workshop asks for an access code.",
    detail: outcome.hadCode ? "The code may have changed; ask the owner for the current one." : "The owner sets it so that only invited players spend the workshop's budget.", question: "Type the code below: it is kept on this device, and your message goes out as soon as it is accepted.", askCode: true, retry: false };
  if (kind === "throttled") return { title: "Too many wrong access codes from this device.", detail: `The workshop will take another code in ${outcome.retryAfter} s.`, question: "Check the code with the owner, then try again; your message is back in the box.", retry: false };
  if (kind === "closed") return { title: "The workshop is closed for today.", detail: outcome.message ?? "Its model calls for the day are used up.", question: "Your message is back in the box: send it again when it reopens. Meanwhile the samples still load, and anything already built keeps running.", retry: false };
  return { title: "Something went wrong talking to the workshop.", detail: outcome.message ?? "", question: "Try sending your message again.", retry: false };
}

/**
 * The HTTP call. Returns { kind: "questions" | "module" | "failed" | "busy" | "declined" | "refused" | "unauthorized" |
 * "throttled" | "closed" | "unreachable" | "error", ... }. `accessCode` goes as a bearer token when set. A server in
 * keepalive mode answers 200 with leading whitespace and may carry another outcome as { type: "error", status };
 * that is read as if it had been the status.
 */
export async function askWorkshop(url, messages, { fetchImpl = fetch, tries, accessCode } = {}) {
  let res;
  try {
    res = await fetchImpl(url.replace(/\/$/, "") + "/workshop", { method: "POST", headers: { "content-type": "application/json", ...(accessCode ? { authorization: `Bearer ${accessCode}` } : {}) }, body: JSON.stringify({ messages, ...(tries ? { tries } : {}) }) });
  } catch (e) { return { kind: "unreachable", url, message: String(e?.message ?? e) }; }
  let body = null; try { body = await res.json(); } catch {}
  let status = res.status, retryAfter = Number(res.headers.get("retry-after"));
  if (status === 200 && body?.type === "error" && Number.isInteger(body.status) && body.status >= 400 && body.status <= 599) { status = body.status; retryAfter = Number(body.retry_after) || retryAfter; }
  const ok = status >= 200 && status < 300;
  if (status === 503) return { kind: "busy", retryAfter: Math.max(1, Math.min(60, retryAfter || 5)), message: body?.error };
  if (status === 422) return { kind: "declined", message: body?.error };
  if (status === 401) return { kind: "unauthorized", hadCode: Boolean(accessCode), message: body?.error };
  if (status === 429 && body?.code === "closed") return { kind: "closed", message: body?.error, reopensAt: typeof body.reopens_at === "string" ? body.reopens_at : null };
  if (status === 429) return { kind: "throttled", retryAfter: Math.max(1, retryAfter || 60), message: body?.error };
  if (status === 400 || status === 403 || status === 413 || status === 415) return { kind: "refused", message: body?.error ?? `status ${status}` };
  if (!ok || !body) return { kind: "error", message: body?.error ?? `status ${status}` };
  if (body.type === "questions" && typeof body.text === "string") return { kind: "questions", text: body.text };
  if (body.type === "module") {
    const bad = moduleAnswerProblem(body);
    if (bad) return { kind: "error", message: `the workshop's answer was malformed (${bad}); nothing was loaded` };
    // fields picked by name: a body with its own `kind` (or anything else) cannot change what the panel does with it
    return { kind: "module", name: body.name, manifest: body.manifest, source: typeof body.source === "string" ? body.source : "", wasm: body.wasm, explanation: body.explanation ?? "", report: body.report ?? "",
      tries: toCount(body.tries), log: Array.isArray(body.log) ? body.log : [], fact_ids: Array.isArray(body.fact_ids) ? body.fact_ids.filter(x => typeof x === "string") : [] };
  }
  if (body.type === "failed") return { kind: "failed", error: String(body.error ?? ""), tries: toCount(body.tries), log: Array.isArray(body.log) ? body.log : [] };
  return { kind: "error", message: "unexpected answer from the workshop" };
}

const esc = s => String(s).replace(/[&<>"]/g, c => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c]));
/** A count from the server: a non-negative integer or 0. Anything else (markup, strings) is never rendered. */
export const toCount = v => (Number.isInteger(v) && v >= 0 ? v : 0);
/** Why a "module" answer cannot be rendered, or null. The page trusts the server's shape no more than its content. */
export function moduleAnswerProblem(b) {
  if (!b || typeof b !== "object") return "not an object";
  if (!b.manifest || typeof b.manifest !== "object" || Array.isArray(b.manifest)) return "no manifest";
  if (typeof b.wasm !== "string" || !b.wasm) return "no module bytes";
  if (typeof b.name !== "string" || !/^[a-z][a-z0-9_]{0,31}$/.test(b.name)) return "bad name";
  if (b.explanation !== undefined && typeof b.explanation !== "string") return "bad explanation";
  if (b.report !== undefined && typeof b.report !== "string") return "bad report";
  return null;
}
/** Prose with [fact.id] references turned into chips (title = label and tier). */
export function proseHtml(index, text) {
  return esc(text).replace(/\[([a-z][a-z0-9_]*(?:\.[a-z0-9_]+)+)\]/g, (_, id) => {
    const c = citationsFor(index, id);
    return `<span class="factref" data-fact="${esc(id)}" title="${esc(c.known ? `${c.label} (tier ${c.tier})` : "not in the fact index")}">${esc(id)}</span>`;
  });
}

/**
 * The panel. `els`: { input, send, thread, status, proposal }. `place(result)` loads the module into
 * the world and resolves to the object id; `onInspect(id)` opens the inspector.
 */
export function createWorkshopPanel({ els, index, workshopUrl = DEFAULT_WORKSHOP_URL, place, log = () => {}, fetchImpl = fetch, sleep = ms => new Promise(r => setTimeout(r, ms)), storage = defaultStorage() }) {
  const messages = [];          // the conversation as sent to the server
  let busy = false, proposal = null, retries = 0;
  const E = els;
  // the access code, kept per workshop URL on this device (never in the conversation, never logged)
  const codeKey = () => `mars-sandbox.workshop-code:${workshopUrl}`;
  const getCode = () => { try { return storage.getItem(codeKey()) || null; } catch { return null; } };
  const setCode = v => { try { v ? storage.setItem(codeKey(), v) : storage.removeItem(codeKey()); } catch {} };

  function addTurn(role, html, cls = "") {
    const d = document.createElement("div"); d.className = `turn ${role} ${cls}`.trim(); d.innerHTML = html; E.thread.appendChild(d); E.thread.scrollTop = E.thread.scrollHeight; return d;
  }
  function setStatus(text, cls = "") { E.status.textContent = text; E.status.className = `wstatus ${cls}`.trim(); E.status.hidden = !text; }
  function setBusy(b) { busy = b; E.send.disabled = b; E.input.disabled = b; }

  function showProposal(r) {
    proposal = r;
    const m = r.manifest, ids = Array.isArray(m.fact_ids) ? m.fact_ids.filter(x => typeof x === "string") : [];
    const tier = weakestTier(index, ids);
    const dyk = m.did_you_know ? citationsFor(index, m.did_you_know.fact_id) : null;
    const report = r.report ?? "";
    const over = /(\d+) over the (\d+) ms budget/.exec(report);
    const nearBudget = over && Number(over[1]) > 0;
    E.proposal.innerHTML = `
      <div class="ptitle">${esc(m.name)} <span class="pill">v${esc(m.version)}</span> ${tier ? `<span class="pill tier-${esc(tier)}" title="weakest provenance tier among the facts this design rests on">${esc(tier)}</span>` : `<span class="pill">no facts cited</span>`}</div>
      <p class="pdesc">${esc(m.description)}</p>
      <p class="pexpl">${proseHtml(index, r.explanation ?? "")}</p>
      <p class="passume">Anything above without a fact id in brackets is your own assumption, not a fact about Mars.</p>
      ${dyk ? `<p class="dyk"><b>Did you know?</b> ${esc(m.did_you_know.text)} <span class="src">${dyk.known ? esc(dyk.sources.map(s => s.citation).join("; ")) : "(fact id not in the index)"}</span></p>` : ""}
      <p class="report ${nearBudget ? "warn" : ""}"><b>Built and tested</b> in ${toCount(r.tries)} tr${toCount(r.tries) === 1 ? "y" : "ies"}: ${esc(report)}${nearBudget ? " (near the budget: some ticks were slow)" : ""}</p>
      <div class="row"><button class="primary" id="ws-place">Place it in the world</button><button class="ghost" id="ws-change">Change something first</button></div>`;
    E.proposal.hidden = false;
    E.proposal.querySelector("#ws-place").onclick = () => placeProposal();
    E.proposal.querySelector("#ws-change").onclick = () => { E.proposal.hidden = true; proposal = null; E.input.focus(); setStatus("Tell the agent what to change.", ""); };
  }

  async function placeProposal() {
    if (!proposal) return;
    const r = proposal; E.proposal.hidden = true; proposal = null;
    setStatus(`Loading ${r.name} into the world…`, "loading");
    try {
      const errs = validateManifest(r.manifest);
      if (errs.length) throw new Error("the manifest did not validate on the page: " + errs.join("; "));
      const id = await place(r);
      setStatus(`${r.name} is live as "${id}".`, "ok");
      addTurn("host", `Placed <b>${esc(r.name)}</b> as <span class="factref objref" data-object="${esc(id)}">${esc(id)}</span>. ${r.manifest.did_you_know ? "<i>Did you know?</i> " + esc(r.manifest.did_you_know.text) : ""}`);
      log("host", `placed ${id} from the workshop (${toCount(r.tries)} tr${toCount(r.tries) === 1 ? "y" : "ies"}, ${(r.fact_ids ?? []).length} fact id${(r.fact_ids ?? []).length === 1 ? "" : "s"})`);
      messages.length = 0;                                   // a placed object ends this conversation; the next message starts a new design
    } catch (e) {
      setStatus("", ""); addTurn("agent", `<b>${esc("It did not load: " + e.message)}</b><br>${esc("The built module is still here: try placing it again, or change something first.")}`, "next");
      showProposal(r);                                         // the build is paid for; keep it
    }
  }

  async function send(text) {
    text = (text ?? E.input.value).trim();
    if (!text || busy) return;
    E.input.value = "";
    E.proposal.hidden = true; proposal = null;
    messages.push({ role: "user", content: text });
    addTurn("player", esc(text));
    setBusy(true); retries = 0;
    setStatus("Asking the design agent… (it may ask you something first; a build is compiled and tested before you see it)", "loading");
    let r;
    for (;;) {
      r = await askWorkshop(workshopUrl, messages, { fetchImpl, accessCode: getCode() });
      if (r.kind !== "busy") break;
      if (retries >= MAX_RETRIES_WHEN_BUSY) { r = { ...r, exhausted: true, attempts: retries + 1 }; break; }
      retries++;
      const step = nextStepFor(r); setStatus(`${step.title} ${step.detail}`, "loading");
      await sleep(r.retryAfter * 1000);
    }
    setBusy(false);
    if (r.kind === "busy" || r.kind === "unreachable" || r.kind === "refused" || r.kind === "error" || r.kind === "unauthorized" || r.kind === "throttled" || r.kind === "closed") {
      messages.pop();                                          // undelivered: the model never saw it, so it must not be sent twice
      E.input.value = text;                                    // and the player gets it back to send again
    }
    if (r.kind === "unauthorized") {
      if (r.hadCode) setCode(null);                            // a stored code the server no longer takes is forgotten
      const step = nextStepFor(r);
      setStatus("", "");
      const turn = addTurn("agent", `<b>${esc(step.title)}</b> ${esc(step.detail)}<br><span class="q">${esc(step.question)}</span><div class="row"><input id="ws-code" type="password" autocomplete="off" placeholder="access code" aria-label="access code"><button class="primary" id="ws-code-ok">Use this code</button></div>`, "next askcode");
      const input = turn.querySelector("#ws-code"), ok = turn.querySelector("#ws-code-ok");
      const submit = () => { const v = input.value.trim(); if (!v) return; setCode(v); input.value = ""; turn.remove(); send(text); };   // the code is sent only in the header; the message goes again as it was
      ok.onclick = submit; input.addEventListener("keydown", e => { if (e.key === "Enter") { e.preventDefault(); submit(); } });
      input.focus();
      return;
    }
    if (r.kind === "questions") {
      messages.push({ role: "assistant", content: r.text });
      setStatus("The agent has a question for you.", "");
      addTurn("agent", proseHtml(index, r.text));
    } else if (r.kind === "module") {
      messages.push({ role: "assistant", content: r.explanation ?? "(built)" });
      setStatus("Built and tested. Place it, or change something first.", "ok");
      addTurn("agent", proseHtml(index, r.explanation ?? ""));
      showProposal(r);
    } else {
      if (r.kind === "failed") messages.push({ role: "assistant", content: "(the build did not pass its tests: " + (r.error ?? "").split("\n")[0] + ")" });
      const step = nextStepFor(r);
      setStatus("", "");
      addTurn("agent", `<b>${esc(step.title)}</b> ${esc(step.detail)}${step.question ? `<br><span class="q">${esc(step.question)}</span>` : ""}`, "next");
      if (r.kind === "failed" && Array.isArray(r.log)) addTurn("host", `<details><summary>what each try hit</summary>${r.log.map((l, i) => `<div>try ${toCount(l?.attempt) || i + 1}: ${esc(String(l?.error ?? l?.report ?? "ok").split("\n").slice(0, 2).join(" "))}</div>`).join("")}</details>`);
    }
    E.input.focus();
  }

  E.send.onclick = () => send();
  E.input.addEventListener("keydown", e => { if (e.key === "Enter" && !e.shiftKey) { e.preventDefault(); send(); } });
  /** Forget the conversation and the thread (a new design). */
  function reset() { messages.length = 0; proposal = null; E.thread.innerHTML = ""; E.proposal.hidden = true; E.input.value = ""; setStatus("", ""); setBusy(false); }
  /** Forget the access code kept for the current workshop URL (the next request will ask again). */
  function forgetAccessCode() { setCode(null); }
  return { send, messages, get busy() { return busy; }, get proposal() { return proposal; }, placeProposal, reset, forgetAccessCode,
    get hasAccessCode() { return getCode() !== null; },
    get workshopUrl() { return workshopUrl; }, set workshopUrl(u) { workshopUrl = String(u); } };
}
/** localStorage when the page has it (a private window or blocked storage just means typing the code again). */
function defaultStorage() {
  try { if (typeof localStorage !== "undefined") return localStorage; } catch {}
  const m = new Map(); return { getItem: k => m.get(k) ?? null, setItem: (k, v) => m.set(k, String(v)), removeItem: k => m.delete(k) };
}

/**
 * The inspector's view of one object, built once per object (and on load, unload or a state change):
 * manifest slots with their labels, the weakest tier, every cited fact with its citations, the did-you-know
 * line, and the explanation the design came with, rendered like the proposal card so what rests on a fact
 * id and what is the player's assumption stays visible. Live values go into [data-slot] and [data-ticks]
 * spans that updateInspector() refreshes in place, so links stay clickable and text stays selectable.
 */
export function inspectorHtml(index, obj, stats, explanation = null) {
  const m = obj.manifest ?? null;
  const slots = Array.from(obj.state ?? []);
  const rows = m?.state?.length ? m.state.map(s => `<div class="stat"><b>${esc(s.label)}${s.unit ? ` (${esc(s.unit)})` : ""}</b><span data-slot="${toCount(s.slot)}">${fmt(slots[s.slot])}</span></div>`).join("")
    : slots.map((v, i) => `<div class="stat" data-raw-slot="${i}" ${v !== 0 ? "" : "hidden"}><b>slot ${i}</b><span data-slot="${i}">${fmt(v)}</span></div>`).join("") + `<div class="stat" data-no-state ${slots.some(v => v !== 0) ? "hidden" : ""}><b>state</b><span>nothing set</span></div>`;
  const ids = (m?.fact_ids ?? []).filter(x => typeof x === "string");
  const tier = weakestTier(index, ids);
  const cites = ids.map(id => { const c = citationsFor(index, id); return `<li><span class="factref" data-fact="${esc(id)}">${esc(id)}</span> <span class="pill tier-${esc(c.tier ?? "unknown")}">${esc(c.tier ?? "not in index")}</span>${c.superseded_by ? ` <span class="pill warn">superseded by ${esc(c.superseded_by)}</span>` : ""}<div class="cite">${c.sources.map(s => s.url ? `<a href="${esc(s.url)}" target="_blank" rel="noopener">${esc(s.citation)}</a>` : esc(s.citation)).join("<br>") || "no source"}</div></li>`; }).join("");
  const dyk = m?.did_you_know ? citationsFor(index, m.did_you_know.fact_id) : null;
  return `
    <div class="ptitle">${esc(m?.name ?? obj.module?.name ?? obj.id)} <span class="pill">${esc(obj.id)}</span> <span class="pill">v${esc(obj.version ?? 1)}</span> <span class="pill">${esc(obj.owner ?? "?")}</span> <span class="pill ${stats?.enabled ? "running" : "dead"}" data-running>${stats?.enabled ? "running" : "stopped"}</span></div>
    ${m ? `<p class="pdesc">${esc(m.description)} <span class="dim">by ${esc(m.author)}</span></p>` : `<p class="pdesc dim">No manifest: a sample or a hand-loaded module. Slots below are raw numbers.</p>`}
    <div class="stats">${rows}</div>
    ${explanation ? `<h4>How it was designed</h4><p class="pexpl">${proseHtml(index, explanation)}</p><p class="passume">Anything above without a fact id in brackets is the player's own assumption, not a fact about Mars.</p>` : m ? `<p class="passume">No design explanation was kept for this object; anything not listed under the facts below is an assumption.</p>` : ""}
    <h4>Facts this design rests on ${tier ? `<span class="pill tier-${esc(tier)}" title="weakest provenance tier among them">weakest tier: ${esc(tier)}</span>` : `<span class="pill">none cited</span>`}</h4>
    ${ids.length ? `<ul class="cites">${cites}</ul>` : `<p class="dim">Nothing here is tied to a sourced fact; treat its numbers as the player's assumptions.</p>`}
    ${dyk ? `<p class="dyk"><b>Did you know?</b> ${esc(m.did_you_know.text)} <span class="src">${dyk.known ? esc(dyk.sources.map(s => s.citation).join("; ")) : "(fact id not in the index)"}</span></p>` : ""}
    <p class="dim" data-ticks>${tickLine(stats)}</p>`;
}
function tickLine(stats) { return stats ? `${stats.ticks} ticks, ${stats.avgMs.toFixed(2)} ms average, ${stats.shapes} shape${stats.shapes === 1 ? "" : "s"}, ${stats.badActions} bad action${stats.badActions === 1 ? "" : "s"}` : ""; }
/** Refresh the live numbers inside an inspector built by inspectorHtml(), leaving the rest of the DOM alone. */
export function updateInspector(root, obj, stats) {
  const slots = Array.from(obj.state ?? []);
  for (const span of root.querySelectorAll("[data-slot]")) span.textContent = fmt(slots[Number(span.dataset.slot)]);
  for (const row of root.querySelectorAll("[data-raw-slot]")) row.hidden = slots[Number(row.dataset.rawSlot)] === 0;
  const none = root.querySelector("[data-no-state]"); if (none) none.hidden = slots.some(v => v !== 0);
  const t = root.querySelector("[data-ticks]"); if (t) t.textContent = tickLine(stats);
  const r = root.querySelector("[data-running]"); if (r) { r.textContent = stats?.enabled ? "running" : "stopped"; r.className = `pill ${stats?.enabled ? "running" : "dead"}`; }
}
function fmt(v) { return v === undefined ? "—" : Number.isInteger(v) ? String(v) : Number(v).toFixed(2); }
