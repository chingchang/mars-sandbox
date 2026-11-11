// The workshop panel (W2): the player talks to the design agent, answers its
// questions, confirms a proposal, and watches the module get placed. Pure
// helpers (tier, citations, next steps) are exported for tests; the panel
// itself touches only the elements it is given and the callbacks the page
// passes in. It talks to the workshop server only; no key ever reaches here.
import { validateManifest } from "../runtime/manifest.mjs";   // pack.mjs rewrites this to ./runtime/ in dist

export const DEFAULT_WORKSHOP_URL = "http://127.0.0.1:8787";
export const MAX_RETRIES_WHEN_BUSY = 6;

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
  if (kind === "busy") return { title: "The workshop is busy with other builds.", detail: `Trying again in ${outcome.retryAfter} s.`, question: null, retry: true };
  if (kind === "unreachable") return { title: `The workshop server is not reachable at ${outcome.url}.`,
    detail: "Start it with `npm run workshop` in the project folder, and open this page from http://localhost:8000 (a page opened as a file cannot reach it).", question: "Once it is running, send your message again.", retry: false };
  if (kind === "refused") return { title: "The workshop would not take that request.", detail: outcome.message ?? "", question: "Try a shorter message, or reload the page from http://localhost:8000.", retry: false };
  return { title: "Something went wrong talking to the workshop.", detail: outcome.message ?? "", question: "Try sending your message again.", retry: false };
}

/** The HTTP call. Returns { kind: "questions" | "module" | "failed" | "busy" | "declined" | "refused" | "unreachable" | "error", ... }. */
export async function askWorkshop(url, messages, { fetchImpl = fetch, tries } = {}) {
  let res;
  try {
    res = await fetchImpl(url.replace(/\/$/, "") + "/workshop", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ messages, ...(tries ? { tries } : {}) }) });
  } catch (e) { return { kind: "unreachable", url, message: String(e?.message ?? e) }; }
  let body = null; try { body = await res.json(); } catch {}
  if (res.status === 503) return { kind: "busy", retryAfter: Math.max(1, Math.min(60, Number(res.headers.get("retry-after")) || 5)), message: body?.error };
  if (res.status === 422) return { kind: "declined", message: body?.error };
  if (res.status === 400 || res.status === 403 || res.status === 413 || res.status === 415) return { kind: "refused", message: body?.error ?? `status ${res.status}` };
  if (!res.ok || !body) return { kind: "error", message: body?.error ?? `status ${res.status}` };
  if (body.type === "questions") return { kind: "questions", text: body.text };
  if (body.type === "module") return { kind: "module", ...body };
  if (body.type === "failed") return { kind: "failed", error: body.error, tries: body.tries, log: body.log };
  return { kind: "error", message: "unexpected answer from the workshop" };
}

const esc = s => String(s).replace(/[&<>"]/g, c => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c]));
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
export function createWorkshopPanel({ els, index, workshopUrl = DEFAULT_WORKSHOP_URL, place, log = () => {}, fetchImpl = fetch, sleep = ms => new Promise(r => setTimeout(r, ms)) }) {
  const messages = [];          // the conversation as sent to the server
  let busy = false, proposal = null, retries = 0;
  const E = els;

  function addTurn(role, html, cls = "") {
    const d = document.createElement("div"); d.className = `turn ${role} ${cls}`.trim(); d.innerHTML = html; E.thread.appendChild(d); E.thread.scrollTop = E.thread.scrollHeight; return d;
  }
  function setStatus(text, cls = "") { E.status.textContent = text; E.status.className = `wstatus ${cls}`.trim(); E.status.hidden = !text; }
  function setBusy(b) { busy = b; E.send.disabled = b; E.input.disabled = b; }

  function showProposal(r) {
    proposal = r;
    const m = r.manifest, ids = Array.isArray(m.fact_ids) ? m.fact_ids : [];
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
      <p class="report ${nearBudget ? "warn" : ""}"><b>Built and tested</b> in ${r.tries} tr${r.tries === 1 ? "y" : "ies"}: ${esc(report)}${nearBudget ? " (near the budget: some ticks were slow)" : ""}</p>
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
      log("host", `placed ${id} from the workshop (${r.tries} tr${r.tries === 1 ? "y" : "ies"}, ${(r.fact_ids ?? []).length} fact id${(r.fact_ids ?? []).length === 1 ? "" : "s"})`);
      messages.length = 0;                                   // a placed object ends this conversation; the next message starts a new design
    } catch (e) {
      const step = nextStepFor({ kind: "error", message: e.message });
      setStatus("", ""); addTurn("agent", `<b>${esc("It did not load: " + e.message)}</b><br>${esc(step.question)}`, "next");
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
      r = await askWorkshop(workshopUrl, messages, { fetchImpl });
      if (r.kind !== "busy" || retries >= MAX_RETRIES_WHEN_BUSY) break;
      retries++;
      const step = nextStepFor(r); setStatus(`${step.title} ${step.detail}`, "loading");
      await sleep(r.retryAfter * 1000);
    }
    setBusy(false);
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
      if (r.kind === "failed" && Array.isArray(r.log)) addTurn("host", `<details><summary>what each try hit</summary>${r.log.map(l => `<div>try ${l.attempt}: ${esc((l.error ?? l.report ?? "ok").split("\n").slice(0, 2).join(" "))}</div>`).join("")}</details>`);
    }
    E.input.focus();
  }

  E.send.onclick = () => send();
  E.input.addEventListener("keydown", e => { if (e.key === "Enter" && !e.shiftKey) { e.preventDefault(); send(); } });
  return { send, messages, get busy() { return busy; }, get proposal() { return proposal; }, placeProposal, workshopUrl };
}

/** The inspector's view of one object: manifest slots with live values, weakest tier, citations, did-you-know. Returns HTML. */
export function inspectorHtml(index, obj, stats) {
  const m = obj.manifest ?? null;
  const slots = Array.from(obj.state ?? []);
  const rows = m?.state?.length ? m.state.map(s => `<div class="stat"><b>${esc(s.label)}${s.unit ? ` (${esc(s.unit)})` : ""}</b><span>${fmt(slots[s.slot])}</span></div>`).join("")
    : slots.map((v, i) => v !== 0 ? `<div class="stat"><b>slot ${i}</b><span>${fmt(v)}</span></div>` : "").join("") || `<div class="stat"><b>state</b><span>nothing set</span></div>`;
  const ids = m?.fact_ids ?? [];
  const tier = weakestTier(index, ids);
  const cites = ids.map(id => { const c = citationsFor(index, id); return `<li><span class="factref" data-fact="${esc(id)}">${esc(id)}</span> <span class="pill tier-${esc(c.tier ?? "unknown")}">${esc(c.tier ?? "not in index")}</span>${c.superseded_by ? ` <span class="pill warn">superseded by ${esc(c.superseded_by)}</span>` : ""}<div class="cite">${c.sources.map(s => s.url ? `<a href="${esc(s.url)}" target="_blank" rel="noopener">${esc(s.citation)}</a>` : esc(s.citation)).join("<br>") || "no source"}</div></li>`; }).join("");
  const dyk = m?.did_you_know ? citationsFor(index, m.did_you_know.fact_id) : null;
  return `
    <div class="ptitle">${esc(m?.name ?? obj.module?.name ?? obj.id)} <span class="pill">${esc(obj.id)}</span> <span class="pill">v${esc(obj.version ?? 1)}</span> <span class="pill">${esc(obj.owner ?? "?")}</span> ${stats ? `<span class="pill ${stats.enabled ? "running" : "dead"}">${stats.enabled ? "running" : "stopped"}</span>` : ""}</div>
    ${m ? `<p class="pdesc">${esc(m.description)} <span class="dim">by ${esc(m.author)}</span></p>` : `<p class="pdesc dim">No manifest: a sample or a hand-loaded module. Slots below are raw numbers.</p>`}
    <div class="stats">${rows}</div>
    <h4>Facts this design rests on ${tier ? `<span class="pill tier-${esc(tier)}" title="weakest provenance tier among them">weakest tier: ${esc(tier)}</span>` : `<span class="pill">none cited</span>`}</h4>
    ${ids.length ? `<ul class="cites">${cites}</ul>` : `<p class="dim">Nothing here is tied to a sourced fact; treat its numbers as the player's assumptions.</p>`}
    ${dyk ? `<p class="dyk"><b>Did you know?</b> ${esc(m.did_you_know.text)} <span class="src">${dyk.known ? esc(dyk.sources.map(s => s.citation).join("; ")) : "(fact id not in the index)"}</span></p>` : ""}
    ${stats ? `<p class="dim">${stats.ticks} ticks, ${stats.avgMs.toFixed(2)} ms average, ${stats.shapes} shape${stats.shapes === 1 ? "" : "s"}, ${stats.badActions} bad action${stats.badActions === 1 ? "" : "s"}</p>` : ""}`;
}
function fmt(v) { return v === undefined ? "—" : Number.isInteger(v) ? String(v) : Number(v).toFixed(2); }
