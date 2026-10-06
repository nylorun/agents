---
name: repo-brief
description: Write a repository brief with fixed sections and check it with the bundled script. Use when asked to write a repo brief.
---

Write the brief in Markdown: a `#` title naming the repository and the date, then exactly these sections, in order.

## Summary

Two or three sentences on what the repository is for.

## Findings

One bullet per finding, each a concrete statement.

## Risks

One bullet per risk.

Then check it in the sandbox:

1. Write the brief to `/workspace/brief.md`.
2. Run `sh /skills/repo-brief/scripts/check.sh /workspace/brief.md`.
3. Fix every problem it prints and run it again until it prints `ok`.
