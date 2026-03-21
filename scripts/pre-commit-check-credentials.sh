#!/bin/bash
set -e

echo "🔍 Checking for exposed credentials..."

STAGED_FILES=$(git diff --cached --name-only)
if [ -z "$STAGED_FILES" ]; then
  echo "✅ No staged files"
  exit 0
fi

PATTERNS=(
  "ghp_[A-Za-z0-9_]+"
  "hf_[A-Za-z0-9]+"
  "-----BEGIN.*PRIVATE KEY-----"
)

ERRORS=0
for pattern in "${PATTERNS[@]}"; do
  if echo "$STAGED_FILES" | xargs grep -E "$pattern" 2>/dev/null; then
    echo "❌ ERROR: Credential found: $pattern"
    ERRORS=$((ERRORS + 1))
  fi
done

if echo "$STAGED_FILES" | grep -E "\.env$"; then
  echo "❌ ERROR: .env file in staged changes"
  ERRORS=$((ERRORS + 1))
fi

if [ $ERRORS -gt 0 ]; then
  echo "❌ Found $ERRORS credential exposure(s)"
  exit 1
fi

echo "✅ No credentials found"
exit 0
