// Smoke check against a deployed site, with no key and no access code: the page
// loads with its security headers, /health says only "ok", and /workshop
// without the code is refused. Run by hand or after a deploy, not in npm test.
//   node scripts/deploy_check.mjs https://<app>.fly.dev
const base = (process.argv[2] ?? "").replace(/\/$/, "");
if (!/^https?:\/\//.test(base)) { console.error("usage: node scripts/deploy_check.mjs https://host"); process.exit(2); }
const problems = [];
const check = (cond, what) => { console.log(`${cond ? "ok " : "BAD"} ${what}`); if (!cond) problems.push(what); };
const get = (p, init) => fetch(base + p, { redirect: "manual", ...init });

const page = await get("/");
check(page.status === 200, `GET / is 200 (got ${page.status})`);
check((page.headers.get("content-type") ?? "").startsWith("text/html"), "GET / is HTML");
const csp = page.headers.get("content-security-policy") ?? "";
check(/script-src 'self'/.test(csp) && /worker-src 'self'/.test(csp) && /connect-src 'self'/.test(csp), "the page carries a Content-Security-Policy with script-src, worker-src and connect-src 'self'");
check(!/'unsafe-inline'/.test(csp.split("style-src")[0]), "no 'unsafe-inline' for scripts");
check(page.headers.get("x-content-type-options") === "nosniff", "X-Content-Type-Options: nosniff");
check(/max-age=\d+/.test(page.headers.get("strict-transport-security") ?? ""), "Strict-Transport-Security");
check(!/cdn\.jsdelivr\.net(?:\s|;|$)/.test(csp), "the CDN allowance is a path, not the whole CDN");
const html = await page.text();
check(html.includes("ws-input") && html.includes('name="workshop-url"'), "the page is the packed client with the workshop panel");
check(!/sk-ant-[A-Za-z0-9_-]{20,}/.test(html), "nothing key-shaped in the page");

const worker = await get("/runtime/worker.mjs");
check(worker.status === 200 && (worker.headers.get("content-type") ?? "").startsWith("text/javascript"), "the sandbox worker is served as JavaScript");
check((worker.headers.get("content-security-policy") ?? "").includes("worker-src 'self'"), "the worker script carries the policy too");

const health = await get("/health");
const hj = await health.json().catch(() => null);
check(health.status === 200 && hj && hj.ok === true && Object.keys(hj).length === 1, `/health says only { ok: true } to a stranger (got ${JSON.stringify(hj)})`);

const body = JSON.stringify({ messages: [{ role: "user", content: "a beacon" }] });
const noCode = await get("/workshop", { method: "POST", headers: { "content-type": "application/json" }, body });
check(noCode.status === 401, `POST /workshop without a code is 401 (got ${noCode.status})`);
const wrong = await get("/workshop", { method: "POST", headers: { "content-type": "application/json", authorization: "Bearer not-the-code" }, body });
check(wrong.status === 401 || wrong.status === 429, `POST /workshop with a wrong code is 401 (or 429 once throttled) (got ${wrong.status})`);

const traversal = await get("/../package.json");
check(traversal.status === 404, `a path above the site is 404 (got ${traversal.status})`);

if (problems.length) { console.error(`\n${problems.length} problem(s)`); process.exit(1); }
console.log("\ndeploy check: ok");
