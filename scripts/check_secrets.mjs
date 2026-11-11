// Fail if anything resembling an API key or a private key is in a tracked file,
// or if .env itself is tracked. Runs in CI and in `npm test`.
//   node scripts/check_secrets.mjs            # scan `git ls-files` in the repo
import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

export const PATTERNS = [
  [/sk-ant-[A-Za-z0-9_-]{20,}/, "Anthropic API key"],
  [/\bsk-[A-Za-z0-9]{32,}\b/, "secret key (sk-...)"],
  [/\bAKIA[0-9A-Z]{16}\b/, "AWS access key id"],
  [/\bgh[pousr]_[A-Za-z0-9]{36,}\b/, "GitHub token"],
  [/\bxox[baprs]-[A-Za-z0-9-]{10,}/, "Slack token"],
  [/-----BEGIN (?:RSA |EC |OPENSSH |DSA |PGP )?PRIVATE KEY-----/, "private key block"],
  [/\b[A-Z_]*(?:API_KEY|SECRET|TOKEN)\s*=\s*["']?[A-Za-z0-9_\-]{16,}/, "a key or token assigned a value in a file"],
];
const SKIP_EXT = new Set([".png", ".jpg", ".jpeg", ".gif", ".wasm", ".pdf", ".zip", ".gz", ".ico", ".woff", ".woff2", ".ttf", ".tif", ".tiff", ".img", ".lbl"]);
const MAX_BYTES = 4 << 20;

/** Findings in one text: [{ line, what, sample }]. */
export function scanText(text) {
  const out = [];
  const lines = text.split("\n");
  for (let i = 0; i < lines.length; i++) {
    for (const [re, what] of PATTERNS) {
      const m = re.exec(lines[i]);
      if (m) out.push({ line: i + 1, what, sample: m[0].slice(0, 12) + "..." });
    }
  }
  return out;
}

export function trackedFiles(root) {
  return execFileSync("git", ["ls-files", "-z"], { cwd: root, encoding: "utf8" }).split("\0").filter(Boolean);
}

export function scanRepo(root) {
  const findings = [];
  const files = trackedFiles(root);
  for (const f of files) {
    const base = path.basename(f);
    if (base === ".env" || (base.startsWith(".env.") && base !== ".env.example")) findings.push({ file: f, line: 0, what: "an environment file is tracked; it must stay gitignored" });
    if (SKIP_EXT.has(path.extname(f).toLowerCase())) continue;
    let buf;
    try { buf = readFileSync(path.join(root, f)); } catch { continue; }
    if (buf.length > MAX_BYTES || buf.subarray(0, 8000).includes(0)) continue;          // binary or huge
    for (const hit of scanText(buf.toString("utf8"))) findings.push({ file: f, ...hit });
  }
  return { files: files.length, findings };
}

if (process.argv[1] && import.meta.url === new URL(`file://${process.argv[1]}`).href) {
  const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
  const { files, findings } = scanRepo(root);
  if (findings.length) {
    for (const f of findings) console.error(`${f.file}:${f.line}: ${f.what}${f.sample ? " (" + f.sample + ")" : ""}`);
    console.error(`check:secrets: ${findings.length} finding(s) in ${files} tracked files`);
    process.exit(1);
  }
  console.log(`check:secrets: ok, ${files} tracked files, nothing that looks like a key`);
}
