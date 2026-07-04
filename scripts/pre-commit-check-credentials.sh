#!/bin/bash
#
# Pre-commit secret-hygiene gate (24/7-autonomy P1: secret hygiene & rotation).
#
# Rejects staged changes that would leak real credentials or personal infra
# into a tracked file — the "sanitize-before-push" rule, automated. Generalized
# beyond a single hardcoded VM IP / home dir so ANY real routable IP, provider
# token, or home-directory key path is caught before it reaches git history.
#
# Committed config must use placeholders (your-gpu-vm-host, your_ssh_user,
# /path/to/your/ssh/key). Operator values live in gitignored config/local.json.
set -e

echo "🔍 Checking for exposed credentials and personal infra..."

# Only scan text files that are actually added/changed (ACM), never deletions.
# Exclude this hook itself — it legitimately contains the secret-shape patterns
# below, which would otherwise self-match and block every commit that edits it.
STAGED_FILES=$(git diff --cached --name-only --diff-filter=ACM | grep -v 'scripts/pre-commit-check-credentials.sh')
if [ -z "$STAGED_FILES" ]; then
  echo "✅ No staged files"
  exit 0
fi

# Provider tokens / private keys — literal high-signal secret shapes.
SECRET_PATTERNS=(
  "ghp_[A-Za-z0-9_]{36,}"          # GitHub personal access token
  "gh[ousr]_[A-Za-z0-9_]{36,}"     # GitHub OAuth/server/refresh tokens
  "hf_[A-Za-z0-9]{32,}"            # HuggingFace token
  "xox[baprs]-[A-Za-z0-9-]{10,}"   # Slack token
  "AKIA[0-9A-Z]{16}"               # AWS access key id
  "AIza[0-9A-Za-z_-]{35}"          # Google API key
  "-----BEGIN[A-Z ]*PRIVATE KEY-----"
)

# The OPERATOR'S OWN absolute home path — never belongs in a tracked file (the
# correct location is gitignored config/local.json). Keyed to the real current
# user rather than any /home/* or /Users/* so placeholder fixtures like
# `/home/user/.ssh/id_rsa` or `/path/to/your/key` don't produce false positives.
REAL_USER=$(id -un 2>/dev/null || whoami)
INFRA_PATTERNS=(
  "/Users/${REAL_USER}(/|\b)"      # operator macOS home dir
  "/home/${REAL_USER}(/|\b)"       # operator Linux home dir
)
# Also flag the literal $HOME string if it differs from the two above.
if [ -n "${HOME:-}" ] && [ "$HOME" != "/Users/${REAL_USER}" ] && [ "$HOME" != "/home/${REAL_USER}" ]; then
  INFRA_PATTERNS+=("$(printf '%s' "$HOME" | sed 's/[.[\*^$/]/\\&/g')")
fi

ERRORS=0

scan() {
  local pattern="$1"
  local label="$2"
  # -I skips binary files; only report the offending files+lines.
  if echo "$STAGED_FILES" | xargs grep -InE "$pattern" 2>/dev/null; then
    echo "❌ ERROR: ${label}: /$pattern/"
    ERRORS=$((ERRORS + 1))
  fi
}

for pattern in "${SECRET_PATTERNS[@]}"; do
  scan "$pattern" "secret token/key in staged files"
done

for pattern in "${INFRA_PATTERNS[@]}"; do
  scan "$pattern" "personal infra path in staged files"
done

# Real routable IPv4: flag any dotted-quad whose octets are all <=255 that is
# NOT a placeholder / loopback / RFC1918 private / link-local / documentation
# range. Awk does the range logic bash can't express cleanly. Matches source
# content, not filenames.
IP_HITS=$(echo "$STAGED_FILES" | xargs grep -InoE '([0-9]{1,3}\.){3}[0-9]{1,3}' 2>/dev/null | awk -F: '
{
  # field 1=file, 2=line, 3=matched ip (grep -o puts match last)
  ip = $NF
  n = split(ip, o, ".")
  if (n != 4) next
  for (i = 1; i <= 4; i++) if (o[i] < 0 || o[i] > 255) next
  a = o[1]; b = o[2]
  # Skip reserved/private/placeholder ranges.
  if (a == 0 || a == 127 || a == 10 || a == 255) next
  if (a == 192 && b == 168) next
  if (a == 172 && b >= 16 && b <= 31) next
  if (a == 169 && b == 254) next
  if (a == 192 && b == 0) next          # 192.0.2.0/24 TEST-NET / 192.0.0.0
  if (a == 198 && (b == 18 || b == 19)) next
  if (a == 203 && b == 0) next          # 203.0.113.0/24 TEST-NET-3
  print $0
}')
if [ -n "$IP_HITS" ]; then
  echo "$IP_HITS"
  echo "❌ ERROR: real routable IP address in staged files (use a placeholder host)"
  ERRORS=$((ERRORS + 1))
fi

# Never commit the local secrets files themselves.
if echo "$STAGED_FILES" | grep -E '(^|/)\.env(\.|$)|config/local\.json'; then
  echo "❌ ERROR: local secrets file in staged changes (.env* or config/local.json)"
  ERRORS=$((ERRORS + 1))
fi

if [ $ERRORS -gt 0 ]; then
  echo "❌ Found $ERRORS blocked pattern(s). Use placeholders in committed config;"
  echo "   keep operator values in gitignored config/local.json. Rotate anything"
  echo "   that already reached a shared branch."
  exit 1
fi

echo "✅ No credentials or personal infra found"
exit 0
