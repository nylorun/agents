---
name: release
description: Release the Nylorun npm packages and images. Use when a release is requested — a beta release by default, or a promotion to latest when the user asks for latest.
---

# Release

You run the whole release. Merging the release PR publishes it through the
**Publish reviewed release** workflow (`.github/workflows/publish.yml`). A beta
release needs no human. A promotion to `latest` waits for one human step: an
administrator approves the `release` environment. [RELEASING.md](../../../RELEASING.md)
is the reference: the versioning rules, what each workflow job does, and the
Recovery table.

Release on **beta** unless the user asked for `latest`.

## Beta release

1. **Start clean.** Confirm no release is already in flight:
   `gh pr list --state open --search "chore(release) in:title"` lists none, and
   `gh run list --workflow publish.yml --limit 3` shows no run in progress.
   Then branch from the latest `main` in a fresh worktree or a clean checkout:

   ```sh
   git fetch origin
   git switch -c release/beta-$(date +%Y-%m-%d) origin/main
   npm run setup
   ```

   Done when `git status --porcelain` is empty on the new branch.

2. **Prepare.** `npm run release:prepare -- --channel beta`. If it reports no
   pending changesets, there is nothing to release: stop and tell the user.
   Done when it prints `Release prepared`.

3. **Open the PR.** Commit every change together, titled
   `chore(release): beta for <themes> (<package@version, …>)`, with the themes
   drawn from the consumed changesets. The PR body is a table of the
   versions in `.release/plan.json` (mark Studio as an image), the themes, and
   the test plan. Then:

   ```sh
   git push -u origin HEAD
   gh pr create --title "<title>" --body-file <body>
   gh pr merge --auto --squash
   ```

   Done when the PR is queued for merge.

4. **Land it.** CI runs `release:check` because the PR changes the release
   plan. If a check fails, diagnose it. Fix product code in its own PR to
   `main`, then close this PR and restart from step 1, so the plan matches
   `main`. Done when `gh pr view --json state,mergeCommit` shows `MERGED`;
   note the merge commit SHA.

5. **Watch the publication.** The merge starts the workflow for that SHA:

   ```sh
   gh run list --workflow publish.yml --commit <sha>
   gh run watch <run-id> --exit-status
   ```

   On failure, find the error in the Recovery table of RELEASING.md and apply
   that row. A failed job usually reruns as-is (`gh run rerun <run-id> --failed`);
   the release skips what already succeeded. If your token cannot rerun or
   dispatch workflows, give the user the exact command. Done when the run
   concludes `success`.

6. **Verify.** For every package in `.release/plan.json` except Studio (image
   only), `npm view <package>@beta version` prints the plan's version, and
   `docker buildx imagetools inspect ghcr.io/nylorun/<runtime|studio>:<version>`
   succeeds for each image the plan publishes. Done when every check matches.
   Report the versions, the PR and the run URL.

## Promotion to latest

Promote only when the user asks for `latest`. A promotion moves the `latest`
tag onto versions already published on beta; it publishes nothing new.

Follow the beta steps with these changes:

- Step 2 runs `npm run release:prepare -- --channel latest`. It refuses pending
  changesets: run a beta release first, then promote. Its only change is
  `.release/plan.json`.
- Title the PR `chore(release): promote <themes> beta to latest`.
- In step 5 the run pauses at the `promote` job, waiting for review. Send the
  user the run URL and ask them to approve the `release` environment; that
  approval is theirs alone. Then keep watching until the run concludes.
- Step 6 checks `npm view <package> dist-tags.latest` instead.
