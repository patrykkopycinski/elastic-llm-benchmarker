#!/usr/bin/env bash
# Verify pilot Qwen3.6-35B-A3B: batch-summary, golden scores/traces, matrix cells.
set -euo pipefail

MODEL="Qwen/Qwen3.6-35B-A3B"
PLUGIN="${SKILL_DEV_PLUGIN_DIR:-$HOME/Projects/agent-builder-skill-dev-cursor-plugin}"
KIBANA_ROOT="${KIBANA_ROOT:-$HOME/Projects/kibana.worktrees/weekly-evals-matrix}"

echo "=== Queue ==="
curl -sf "http://localhost:3200/api/queue/current" | python3 -m json.tool || echo "(idle)"

echo "=== Latest batch-summary for model ==="
python3 - <<PY
import json, glob, os
model = "$MODEL"
plugin = os.path.expanduser("$PLUGIN")
files = sorted(glob.glob(os.path.join(plugin, "matrix-output", "batch-summary-*.json")), reverse=True)
for path in files[:20]:
    data = json.load(open(path))
    hits = [r for r in data.get("results", []) if r.get("model") == model]
    if hits:
        print(path)
        print("  suites:", len(hits), "pass:", sum(1 for h in hits if h.get("status")=="pass"))
        for h in hits:
            print(f"    {h['suite']}: {h['status']} {h.get('duration_ms',0)//1000}s")
        break
else:
    print("no batch-summary yet for", model)
PY

echo "=== Golden score probe (14d window) ==="
cd "$PLUGIN"
node scripts/run-generate-matrix.mjs --window 14d --run-id-prefix "batch-" 2>/dev/null | python3 - <<'PY'
import json,sys
raw=sys.stdin.read()
# script prints JSON summary then per-model blocks
try:
    start=raw.index('{')
    end=raw.rindex('}')+1
    obj=json.loads(raw[start:end].split('\n\n')[0] if '\n\n' in raw[start:end] else raw[start:end])
    print(json.dumps(obj.get('summary', obj), indent=2)[:1500])
except Exception as e:
    print(raw[:2000] or f"parse err: {e}")
PY

echo "=== Matrix cells for $MODEL ==="
node - <<'NODE'
const fs = require('fs');
const path = require('path');
const plugin = process.env.HOME + '/Projects/agent-builder-skill-dev-cursor-plugin';
const html = path.join(plugin, 'matrix-output', 'latest-security-llm-matrix.html');
const jsonPath = path.join(plugin, 'matrix-output', 'latest-security-llm-matrix.json');
const model = 'Qwen/Qwen3.6-35B-A3B';
if (fs.existsSync(jsonPath)) {
  const report = JSON.parse(fs.readFileSync(jsonPath, 'utf8'));
  const m = (report.models || []).find((x) => x.modelId === model);
  if (m) {
    console.log('composite:', m.compositeScore, 'recommendation:', m.recommendation);
    for (const cat of ['C1','C2','C3','C4','C6']) {
      const layers = m.cells?.[cat];
      if (!layers) { console.log(cat, ': (no cell)'); continue; }
      const fmt = (c) => c ? `${c.layer} score=${c.score ?? 'N/A'} status=${c.status ?? '?'}` : '';
      console.log(cat, Object.values(layers).map(fmt).filter(Boolean).join(' | '));
    }
  } else {
    console.log('model not in matrix json yet');
  }
} else {
  console.log('matrix json missing — run: node scripts/run-generate-matrix.mjs');
}
console.log('html:', fs.existsSync(html) ? html : 'missing');
NODE
