# Releasing packages and images

Packages have independent versions. Core changes advance its pinned engine/SDK/host consumers and nylorun; engine changes advance Runtime; SDK changes advance Studio and CLI; Runtime and Studio changes advance nylorun, which pins their images. Every package release updates the creator compatibility combination. Internal dependencies use exact tested pins. Merging a release PR (one that changes `.release/plan.json`) publishes it: a beta release with no approval, a promotion to `latest` after one administrator approval. Nothing else publishes on merge or tag push.

Coding agents release by following [the release skill](.claude/skills/release/SKILL.md).

The creator's compatibility combination (`create-agent/compatibility.json`)
pins exactly what a generated project or the examples install or depend on:
Core, Harness, Agents, Admin, Runtime and CLI. Neither nylorun nor Studio is in
it: developers run nylorun with `npx`, and Studio ships only as its image,
which nylorun pins.

A release publishes two kinds of artifact:

- **npm packages** under `@nylorun`, plus the unscoped `nylorun` (the stack
  command, `npx nylorun up`). A package marked `"private": true` is not
  published to npm. Studio is one: it ships only as its image.
- **Container images** `ghcr.io/nylorun/runtime:<runtime version>` and
  `ghcr.io/nylorun/studio:<studio version>`, for `linux/amd64` and
  `linux/arm64`. `nylorun up` runs the images nylorun pins in
  `nylorun/package.json`: `nylorun.runtime` and `nylorun.studio`.

## Administrator setup

- Use the toolchain and setup in [CONTRIBUTING.md](./CONTRIBUTING.md).
- Confirm npm organization access for every public `@nylorun` package, and
  that the organization owns the unscoped `nylorun` package (npm trusted
  publishing and `NPM_BOOTSTRAP_TOKEN` must cover it too).
- Configure each package's npm trusted publisher for this repository,
  workflow `publish.yml`, and GitHub environment `npm`, allowing publication.
- Create the `release` environment with administrator reviewers. It is the
  only approval, and only a promotion to `latest` waits on it (the workflow's
  `promote` job). Store `NPM_LATEST_TOKEN` in it: a granular npm access
  token for the `@nylorun` scope and the `nylorun` package, with
  **Read and write (stage only)** access and **Bypass 2FA** enabled. Stage
  only lets it move dist-tags but not publish a version; Bypass 2FA lets CI
  move them without a one-time password. npm caps its expiry at 90 days:
  replace it before then. An expired token fails `promote` with the
  fallback command (see Recovery).
- Keep the `npm` environment (npm trusted publishing is bound to it, and it
  holds `NPM_BOOTSTRAP_TOKEN` when needed) without required reviewers. Beta
  releases publish through it with no approval.
- Restrict the deployment branch of both `release` and `npm` to `main`, and
  protect `main` with required CI/review checks.
- Ensure GitHub Actions can create package tags and GitHub releases.
- Container images: the `images` job pushes to `ghcr.io/nylorun` with the
  workflow's `GITHUB_TOKEN` (`packages: write`). The first push creates each
  package as private and linked to this repository (through the
  `org.opencontainers.image.source` label). Then, once per image, in the
  organization's package settings:
  - set the visibility to **public**, so `nylorun up` can pull it without
    logging in;
  - under **Manage Actions access**, confirm this repository has the **Write**
    role. A package created some other way needs this before the first push.
  The organization must allow members to create public packages.

These are external settings; checked-in workflow permissions do not configure
them. See [npm trusted publishing](https://docs.npmjs.com/trusted-publishers/).
If npm requires an initial authenticated publication before trust can be set up,
an administrator must bootstrap that package using the verified candidate
artifact, then configure trust. Never substitute an untested local build.

For that first publication, an administrator can temporarily set
`NPM_BOOTSTRAP_TOKEN` in the protected GitHub `npm` environment. Use a short-lived
token with only the package/scope permissions needed for this release and direct
publication enabled. The workflow exposes it only to the publishing step; npm
prefers configured OIDC trust and falls back to the token when needed. This keeps
bootstrap publication on the GitHub runner, with provenance and the exact
validated tarballs. Remove/revoke the token after bootstrap and configure trusted
publishing for the newly created packages before future releases.

## Prepare a release PR

Start from updated `main`, with the intended changesets already committed:

```sh
git switch -c release/next
npm run setup
npm run release:prepare -- --channel beta
```

Preparation requires a clean branch. It applies Changesets, ensures a creator
bump, updates the creator's compatibility pins, sets nylorun's image pins
(`nylorun/package.json` `nylorun.runtime` and `nylorun.studio`) to the Runtime and
Studio versions of this release, synchronizes examples, refreshes both
lockfiles, and writes `.release/plan.json`. It does not commit, push, or
publish.

Commit the versions, changelogs, compatibility, generated shell, lockfiles and
release plan together, and open a PR. Its CI runs `release:check` (see below),
because it changes the release plan; run it locally only to debug a failure.
Merging the PR publishes the release.
Changesets supplies release intent and changelog entries. Version strings and npm
dist-tags are separate:

- **Pre-1.0 branding:** every release keeps a `-beta` version suffix (`0.12.0-beta`)
  until the package reaches 1.0. That suffix is product naming, not “temporary.”
- **npm `beta` channel:** stage a candidate build (`npm publish --tag beta`).
- **npm `latest` channel:** make a version the default install target, by
  promoting a version already on `beta`. Before 1.0, `latest` points at
  `*-beta` version strings.

There is no numeric prerelease counter. Packages remain independently versioned.
Fixes bump patch, features bump minor, and breaking changes bump minor before 1.0
or major afterward. Every changed publication advances the numeric core; for
example, `0.11.0-beta` plus a patch becomes `0.11.1-beta`.

Historical numbered prereleases are accepted as inputs, but their numeric core
is bumped rather than stripping the counter and moving backward. Legacy Changesets
prerelease state is retired during preparation, without replaying consumed intent.
Use `release:prepare`, not `changeset version` or `changeset pre`, to apply versions.

Typical pre-1.0 flow:

1. `release:prepare -- --channel beta` — bump `*-beta` versions and publish to the
   `beta` dist-tag for soak testing.
2. `release:prepare -- --channel latest` with no pending changesets — keep the same
   `*-beta` versions and move the `latest` dist-tag onto them (tag promotion),
   after an administrator approves; see [Promote to latest](#promote-to-latest).

Every new version reaches npm on `beta` first. `--channel latest` refuses
pending changesets (release them on beta, then promote), and refuses a package
past 1.0: stripping `-beta` would publish a new version, which a promotion
cannot. Decide how stable versions ship before the first 1.0. Creator also
releases whenever its compatibility pins change. The release plan controls
publication.

`release:check` validates the exact creator combination, using candidate tarballs
for changed packages and registry versions for unchanged pins. It also exercises
CLI commands and production assets. An unavailable unchanged pin blocks release.
It requires both image pins to equal the Runtime and Studio versions the plan
publishes or keeps, and warns while `@nylorun/studio` is not yet private.
Artifacts are saved under `.tmp/release-artifacts/` for inspection; a private
package has no tarball there.

## Publish the reviewed commit

1. Merge the release PR after CI passes. The merge changes
   `.release/plan.json` on `main`, which starts **Publish reviewed release**
   for that commit. A beta release runs to the end with no approval.
2. To rerun or recover, open **Actions → Publish reviewed release → Run
   workflow** on `main` and enter a full 40-character SHA: the merge commit
   that changed the release plan, or a later main tip only when
   `.release/plan.json` is unchanged since then (for example a smoke/script
   fix finishing an interrupted publish).
3. For a promotion to `latest`, an administrator approves the `release`
   environment once, after the public smoke passed; see
   [Promote to latest](#promote-to-latest).
4. Check the workflow summary, the images on `ghcr.io/nylorun`, npm
   versions/dist-tags, and package GitHub releases. The Runtime's release carries
   its OpenAPI documents (`openapi.json`, `admin-openapi.json`), taken from the
   tarball npm published; a rerun or a channel promotion uploads only a missing one
   and never replaces one (`scripts/release/assets.mjs`).

The jobs run in this order:

1. **validate** verifies that the selected commit belongs to `main` and passed
   `ci`, runs `release:check` on the checkout, saves the verified tarballs, and
   reads the plan's channel.
2. **images** builds `runtime/Dockerfile` and `studio/Dockerfile` for
   `linux/amd64` and `linux/arm64` (QEMU and buildx, with a GitHub Actions
   layer cache) and pushes `ghcr.io/nylorun/runtime:<version>` and
   `ghcr.io/nylorun/studio:<version>`, labeled with the source repository,
   version and commit. `scripts/release/images.mjs` decides each push: an
   existing tag is never replaced, so that image is skipped; a version the
   release keeps rather than publishes must already have its image.
3. **publish** runs only after both images exist, because the nylorun it
   publishes pins them. For a beta plan it publishes the same tarballs on the
   `beta` tag: the engines first, then the creator. It never publishes on
   `latest`; for a latest plan it checks that every version is already on npm
   with the verified integrity. Then it smokes the public quickstart on the Docker stack
   (`scripts/release/smoke.mjs`): with no credentials and an empty npm config,
   `npm exec @nylorun/create-agent@<version>` creates a project; the published
   `nylorun up` pulls its pinned `ghcr.io/nylorun/runtime` and
   `ghcr.io/nylorun/studio` images, `nylo tenant create` links the project, and
   its `npm run dev` connects. The smoke checks that the stack runs exactly
   those images, that the Tenant is created and the starter's Action
   endpoint answers a ping, and that the Studio login works. It
   makes no model calls, and it resets the stack's containers and volumes.
4. **promote** runs for a latest plan only. It waits for an administrator to
   approve the `release` environment, then moves each package's `latest` tag
   with `NPM_LATEST_TOKEN`.

Tags use `@nylorun/<package>@<version>`, Studio's included, and
`nylorun@<version>` for nylorun. Images carry only
the version tag; there is no `latest` image.

## Promote to latest

A promotion moves the `latest` dist-tag onto versions already published on
`beta`. npm trusted publishing (OIDC) publishes versions but cannot edit tags,
so the `promote` job moves them with `NPM_LATEST_TOKEN`, which only the
approved `release` environment exposes.

1. Prepare and merge the promotion PR (`release:prepare -- --channel latest`
   with no pending changesets; it changes only `.release/plan.json`). The
   merge starts the workflow.
2. **publish** finds every package already on npm with matching integrity and
   runs the public quickstart smoke. **promote** then waits.
3. An administrator approves the `release` environment. This is the only
   human step of any release.
4. **promote** moves every `latest` tag and lists them in the summary.
5. Check `npm view <package> dist-tags` for each package, and that a plain
   `npx nylorun up` (no `@beta`) starts the promoted Runtime image.

Studio is image only and has no npm tag. Never move a tag backward: publish
refuses to, and a newer `latest` means a newer release is needed instead.

## Recovery

| Failure | Action |
|---|---|
| Preparation interrupted | Review retained changes; restore deliberately or finish the preparation before committing |
| Validation failed | Fix in a reviewed PR and prepare the corrected release |
| Missing npm trust/access | Correct the external setting, then rerun the same workflow |
| Image build or push failed | Rerun the same workflow. Images already pushed are skipped; nothing reached npm, because `publish` needs `images` |
| `denied` pushing to `ghcr.io/nylorun` | Grant this repository the Write role under the package's **Manage Actions access**, then rerun |
| `<image>:<version> does not exist, and this release keeps …` | The release keeps a Runtime or Studio version whose image was never pushed. Prepare a release that bumps that package, so this commit builds its image |
| A pushed image is wrong | Do not overwrite or delete the tag; prepare a new version |
| Partial publication/network failure | Rerun for the same release commit; matching artifact integrity allows completed packages to be skipped |
| npm accepted publication but is still processing it | Wait for the version and tag to appear in ordinary npm reads before retrying; preparation/publication must not assign a new artifact to that version |
| Published integrity differs | Stop; investigate the existing release and prepare a new version |
| `promote` could not move a `latest` tag | Usually an expired or missing `NPM_LATEST_TOKEN`: replace it in the `release` environment (see Administrator setup) and rerun the failed job. Otherwise an npm administrator runs the one `npm dist-tag add … && …` command the job printed, then reruns it |
| `publish` could not move a `beta` tag | An npm administrator runs the one `npm dist-tag add … && …` command the job printed, then reruns the failed job. OIDC alone cannot edit tags |
| `… is not on npm. A latest release only promotes versions already published on beta.` | Release those versions on beta first, then prepare the promotion again |
| A newer dist-tag exists | Do not move it backward; prepare a newer release |
| `Tag … points to a different commit` on a channel promotion | Expected when version tags already exist from an earlier publish of the same versions. Publish tooling allows this when the version is already on the registry; fix/rerun on a commit that updates `.release/plan.json` if an older publish script still rejects it |
| Public creator smoke cannot pull `ghcr.io/nylorun/…` (`denied`, `unauthorized`) | The smoke pulls without logging in, as developers do. Set that image's visibility to **public** (see Administrator setup), then rerun the same workflow |
| Public creator smoke or GitHub release creation failed | Inspect the already-published versions. If smoke needs a code fix, land it on main then rerun publish for that tip (plan unchanged; packages skip on matching integrity). Otherwise rerun the same prepare commit |

Publication cannot be treated as an atomic transaction. Do not delete/reuse a
published version to recover. Record the affected versions and ship a corrective
release. Keep credentials and access tokens out of release notes and logs.

After npm accepts a publication, the workflow polls visibility every five seconds
for up to ten minutes. A registry timeout does not mean the publication failed:
confirm the version's integrity before retrying the same reviewed release.

`release:check` smokes the packed starter on the local Docker stack, so it
needs Docker with Compose v2. It builds `nylorun-runtime:local` and
`nylorun-studio:local` from the checkout unless `NYLORUN_RUNTIME_IMAGE` and
`NYLORUN_STUDIO_IMAGE` name images that are already built. The workflow's
`validate` job builds both once with buildx and a GitHub Actions layer cache,
and passes them that way. No browser is needed.

## Images

Both Dockerfiles build from the repository root. To check a multi-arch build
locally without pushing:

```sh
docker buildx build --platform linux/amd64,linux/arm64 \
  --file runtime/Dockerfile --output type=cacheonly .
docker buildx build --platform linux/amd64,linux/arm64 \
  --file studio/Dockerfile --output type=cacheonly .
```

To run a local build under `nylorun up`, tag it with `docker build` and set
`NYLORUN_RUNTIME_IMAGE` or `NYLORUN_STUDIO_IMAGE` to that tag, as the CI
`stack` job does.

## Retire Hosted Studio (manual, once)

Studio no longer deploys to Firebase Hosting: it is built into the
`ghcr.io/nylorun/studio` image, and `nylorun studio` opens it. When the first
release with the Studio image is published, an administrator:

1. Replaces what `https://local.nylorun.studio` serves with one static page
   that tells developers to run `npx nylorun studio`.
   It loads no scripts and needs no API access.
2. Once that page is live, removes the Firebase Hosting site and project
   (`nylorun-oss-studio`), or keeps only that page on it.
3. Deletes the GitHub `studio` environment and its `FIREBASE_SERVICE_ACCOUNT`
   and `FIREBASE_TOKEN` secrets, and the `FIREBASE_PROJECT_ID` variable.
