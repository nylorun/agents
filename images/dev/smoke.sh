#!/usr/bin/env bash
# smoke.sh IMAGE: the image as a Nylorun pod runs it (uid 1000, read-only root, no capabilities,
# HOME=/workspace), with no network: every tool /etc/nylorun/image.txt lists runs, installers
# point at the home, and the age gates are set. Exits non-zero on the first failure.
set -euo pipefail
image=$1
docker run --rm --network none --read-only --tmpfs /tmp --tmpfs /workspace:uid=1000,gid=1000,exec \
  --user 1000:1000 --cap-drop ALL --security-opt no-new-privileges -e HOME=/workspace "$image" bash -euo pipefail -c '
    test "$(id -un)" = ubuntu
    for t in git python3 pip3 uv node npm mise gcc make jq rg fd curl sqlite3; do
      "$t" --version >/dev/null 2>&1 || { echo "missing: $t"; exit 1; }
    done
    command -v pnpm yarn >/dev/null
    test "$(npm config get prefix)" = /workspace/.local
    test "$(npm config get min-release-age)" = 3
    test "$UV_EXCLUDE_NEWER" = "3 days"
    test "$pnpm_config_minimum_release_age" = 4320
    [[ ":$PATH:" == *":/workspace/.local/bin:"* ]]
    pip install --help >/dev/null
    touch /workspace/ok && ! touch /usr/local/bin/x 2>/dev/null
    cat /etc/nylorun/image.txt
  '
echo "smoke: $image passed"
