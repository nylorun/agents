#!/bin/sh
# Checks a repo brief: a title, the three sections, and at most 400 words.
# Usage: sh check.sh /workspace/brief.md
file="${1:-/workspace/brief.md}"
if [ ! -f "$file" ]; then
  echo "missing: $file"
  exit 1
fi
status=0
grep -q "^# " "$file" || { echo "missing: a # title"; status=1; }
for heading in "## Summary" "## Findings" "## Risks"; do
  grep -q "^$heading" "$file" || { echo "missing: $heading"; status=1; }
done
words=$(wc -w < "$file" | tr -d ' ')
if [ "$words" -gt 400 ]; then
  echo "too long: $words words (at most 400)"
  status=1
fi
if [ "$status" -eq 0 ]; then
  echo "ok: $words words"
fi
exit "$status"
