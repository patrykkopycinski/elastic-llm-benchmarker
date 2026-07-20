#!/usr/bin/env bash
# One-shot poll for Qwen3.6-35B pilot on i9 queue API.
set -euo pipefail
curl -sS http://127.0.0.1:3200/api/queue/current | python3 -c "
import json, sys, subprocess
d = json.load(sys.stdin)
if not d:
    print('STATUS: idle')
    sys.exit(0)
p = d.get('progress') or {}
print('STATUS:', d.get('status'))
print('DETAIL:', p.get('detail'))
print('DONE:', p.get('evalCompleted'))
print('ERR:', d.get('errorMessage'))
try:
    scout = subprocess.check_output(
        ['tail', '-1', '/Users/patrykkopycinski/Projects/agent-builder-skill-dev-cursor-plugin/matrix-output/batch-logs/worker-0-scout.log'],
        stderr=subprocess.DEVNULL, text=True,
    ).strip()
    print('SCOUT:', scout[:120])
except Exception:
    print('SCOUT: n/a')
"
