# Releasing packages and images

Packages have independent versions. Core changes advance its pinned engine/SDK/host consumers; engine changes advance Runtime; SDK changes advance Studio and CLI; Runtime changes advance CLI. Every package release updates the creator compatibility combination. Internal dependencies use exact tested pins. Nothing publishes on merge or tag push.

A release publishes two kinds of artifact:

- **npm packages** under `@nylorun`. A package marked `"private": true` is not
  published to npm. Studio is one: it ships only as its image.
- **Container images** `ghcr.io/nylorun/runtime:<runtime version>` and
  `ghcr.io/nylorun/studio:<studio version>`, for `linux/amd64` and
  `linux/arm64`. `nylorun start` runs the images the CLI pins in
  `cli/package.json`: `nylorun.runtime` and `nylorun.studio`.

## Administrator setup

- Use the toolchain and setup in [CONTRIBUTING.md](./CONTRIBUTING.md).
- Confirm npm organization access for every public `@nylorun` package.
- Configure each package's npm trusted publisher for this repository,
  workflow `publish.yml`, and GitHub environment `npm`, allowing publication.
- Create the `release` environment with administrator reviewers. It is the
  only approval: the workflow's `approve` job waits on it, and nothing is
  pushed or published before it passes.
- Keep the `npm` environment (npm trusted publishing is bound to it, and it
  holds `NPM_BOOTSTRAP_TOKEN` when needed) without required reviewers.
- Restrict the deployment branch of both `release` and `npm` to `main`, and
  protect `main` with required CI/review checks.
- Ensure GitHub Actions can create package tags and GitHub releases.
- Container images: the `images` job pushes to `ghcr.io/nylorun` with the
  workflow's `GITHUB_TOKEN` (`packages: write`). The first push creates each
  package as private and linked to this repository (through the
  `org.opencontainers.image.source` label). Then, once per image, in the
  organization's package settings:
  - set the visibility to **public**, so `nylorun start` can pull it without
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
git switch -c codex/release-next
npm run setup
npm run release:prepare -- --channel beta
npm run release:check
```

Preparation requires a clean branch. It applies Changesets, ensures a creator
bump, updates compatibility pins, sets the CLI's image pins
(`cli/package.json` `nylorun.runtime` and `nylorun.studio`) to the Runtime and
Studio versions of this release, synchronizes examples, refreshes both
lockfiles, and writes `.release/plan.json`. It does not commit, push, or
publish.

Review and commit the versions, changelogs, compatibility, generated shell,
lockfiles and release plan together. Open a normal PR.
Changesets supplies release intent and changelog entries. Version strings and npm
dist-tags are separate:

- **Pre-1.0 branding:** every release keeps a `-beta` version suffix (`0.12.0-beta`)
  until the package reaches 1.0. That suffix is product naming, not “temporary.”
- **npm `beta` channel:** stage a candidate build (`npm publish --tag beta`).
- **npm `latest` channel:** make a version the default install target. Before 1.0,
  `latest` still points at `*-beta` version strings. After 1.0, `latest` uses plain
  `major.minor.patch` versions.

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
   `*-beta` versions and move the `latest` dist-tag onto them (tag promotion).
3. With pending changesets, `--channel latest` bumps the numeric core, keeps the
   pre-1.0 `-beta` suffix, and publishes directly to `latest`.

After 1.0, `--channel latest` with no pending changes strips `-beta`
(`1.2.0-beta` → `1.2.0`). Creator also releases whenever its compatibility pins
change. Review the complete resulting stack. The release plan controls publication.

`release:check` validates the exact creator combination, using candidate tarballs
for changed packages and registry versions for unchanged pins. It also exercises
CLI commands and production assets. An unavailable unchanged pin blocks release.
It requires both image pins to equal the Runtime and Studio versions the plan
publishes or keeps, and warns while `@nylorun/studio` is not yet private.
Artifacts are saved under `.tmp/release-artifacts/` for inspection; a private
package has no tarball there.

## Publish the reviewed commit

1. Merge the release PR after CI passes.
2. Open **Actions → Publish reviewed release → Run workflow** on `main`.
3. Enter the full 40-character SHA of the merge/squash commit that changed the
   release plan. Prefer that prepare commit. A later main tip is allowed only
   when `.release/plan.json` is unchanged since prepare (for example a
   smoke/script fix finishing an interrupted publish).
4. Review the validated candidate artifacts and approve the `release`
   environment once. Images and npm publication then run without further
   approval.
5. Check the workflow summary, the images on `ghcr.io/nylorun`, npm
   versions/dist-tags, and package GitHub releases.

The jobs run in this order:

1. **validate** verifies that the selected commit belongs to `main` and passed
   `ci`, runs `release:check` on the checkout, and saves the verified tarballs.
2. **approve** waits for an administrator to approve the `release` environment.
   Nothing is public before this step.
3. **images** builds `runtime/Dockerfile` and `studio/Dockerfile` for
   `linux/amd64` and `linux/arm64` (QEMU and buildx, with a GitHub Actions
   layer cache) and pushes `ghcr.io/nylorun/runtime:<version>` and
   `ghcr.io/nylorun/studio:<version>`, labeled with the source repository,
   version and commit. `scripts/release/images.mjs` decides each push: an
   existing tag is never replaced, so that image is skipped; a version the
   release keeps rather than publishes must already have its image.
4. **publish** runs only after both images exist, because the CLI it publishes
   pins them. It publishes the same tarballs: the engines first, then the
   creator. It verifies registry availability and installation through the
   public creator command without making model calls.

Tags use `@nylorun/<package>@<version>`, Studio's included. Images carry only
the version tag; there is no `latest` image.

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
| Missing/older dist-tag after publication | Prefer rerunning the same commit so publish can retry `npm dist-tag add` (needs a classic token such as `NPM_BOOTSTRAP_TOKEN`). Otherwise an npm administrator must run `npm dist-tag add @nylorun/<pkg>@<version> <channel>`; OIDC alone does not authenticate standalone tag edits |
| A newer dist-tag exists | Do not move it backward; prepare a newer release |
| `Tag … points to a different commit` on a channel promotion | Expected when version tags already exist from an earlier publish of the same versions. Publish tooling allows this when the version is already on the registry; fix/rerun on a commit that updates `.release/plan.json` if an older publish script still rejects it |
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
`NYLORUN_STUDIO_IMAGE` name images that are already built. No browser is
needed.

## Images

Both Dockerfiles build from the repository root. To check a multi-arch build
locally without pushing:

```sh
docker buildx build --platform linux/amd64,linux/arm64 \
  --file runtime/Dockerfile --output type=cacheonly .
docker buildx build --platform linux/amd64,linux/arm64 \
  --file studio/Dockerfile --output type=cacheonly .
```

To run a local build under `nylorun start`, tag it with `docker build` and set
`NYLORUN_RUNTIME_IMAGE` or `NYLORUN_STUDIO_IMAGE` to that tag, as the CI
`stack` job does.

## Retire Hosted Studio (manual, once)

Studio no longer deploys to Firebase Hosting: it is built into the
`ghcr.io/nylorun/studio` image, and `nylorun studio` opens it. When the first
release with the Studio image is published, an administrator:

1. Replaces what `https://local.nylorun.studio` serves with one static page
   that tells developers to upgrade `@nylorun/cli` and run `nylorun studio`.
   It loads no scripts and needs no API access.
2. Once that page is live, removes the Firebase Hosting site and project
   (`nylorun-oss-studio`), or keeps only that page on it.
3. Deletes the GitHub `studio` environment and its `FIREBASE_SERVICE_ACCOUNT`
   and `FIREBASE_TOKEN` secrets, and the `FIREBASE_PROJECT_ID` variable.
