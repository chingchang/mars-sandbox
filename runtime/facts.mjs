// Build the per-worker fact table from facts/index.json and runtime/fact_keys.json:
// values[key] (Float32, NaN when unknown) and tiers[key] (Int8 tier rank, -1 when unknown).
export function buildFactTable(index, keyMap) {
  const n = keyMap.next;
  const values = new Float32Array(n).fill(NaN), tiers = new Int8Array(n).fill(-1);
  for (const [id, key] of Object.entries(keyMap.keys)) {
    const r = index.facts[id];
    if (!r) continue;
    if (typeof r.value === "number") values[key] = r.value;          // tables and text stay NaN; their tier is still served
    tiers[key] = typeof r.tier_rank === "number" ? r.tier_rank : index.tier_order.indexOf(r.tier);
  }
  return { values, tiers };
}
