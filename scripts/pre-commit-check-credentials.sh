#!/bin/bash
set -e

echo "🔍 Checking for exposed credentials and personal infra..."

STAGED_FILES=$(git diff --cached --name-only)
if [ -z "$STAGED_FILES" ]; then
  echo "✅ No staged files"
  exit 0
fi

SECRET_PATTERNS=(
  "ghp_[A-Za-z0-9_]{36,}"
  "hf_[A-Za-z0-9]{32,}"
  "-----BEGIN.*PRIVATE KEY-----"
)

INFRA_PATTERNS=(
  "34\.29\.5\.12"
  "/Users/patrykkopycinski/"
  "SSH_USERNAME=your_ssh_user"
  '"username": "your_ssh_user"'
)

ERRORS=0
for pattern in "${SECRET_PATTERNS[@]}" "${INFRA_PATTERNS[@]}"; do
  if echo "$STAGED_FILES" | xargs grep -E "$pattern" 2>/dev/null; then
    echo "❌ ERROR: Blocked pattern in staged files: $pattern"
    ERRORS=$((ERRORS + 1))
  fi
done

if echo "$STAGED_FILES" | grep -E '\.env$|config/local\.json'; then
  echo "❌ ERROR: Local secrets file in staged changes (.env or config/local.json)"
  ERRORS=$((ERRORS + 1))
fi

if [ $ERRORS -gt 0 ]; then
  echo "❌ Found $ERRORS blocked pattern(s). Use placeholders in committed config."
  exit 1
fi

echo "✅ No credentials or personal infra found"
exit 0
