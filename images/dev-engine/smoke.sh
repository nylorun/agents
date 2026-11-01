#!/usr/bin/env bash
# smoke.sh IMAGE: a dev image with the engine built in, as a Nylorun pod runs it (uid 1000, read-only root, no capabilities, no
# network): the engine under /opt/nylorun is the version the image's label names, and it starts and
# reads its pod settings before it tries to join. Exits non-zero on the first failure.
set -euo pipefail
image=$1
version="$(docker image inspect "$image" --format '{{ index .Config.Labels "dev.nylorun.engine.version" }}')"
[[ "$version" =~ ^[0-9A-Za-z.+-]+$ ]] || { echo "no engine version label on $image"; exit 1; }
out="$(docker run --rm --network none --read-only --tmpfs /tmp --tmpfs /harness:uid=1000,gid=1000 \
  --user 1000:1000 --cap-drop ALL --security-opt no-new-privileges \
  -e HOME=/harness/home -e NYLORUN_SANDBOX_KIND=pod -e NYLORUN_SANDBOX_ID=smoke -e NYLORUN_POD_UID=smoke \
  -e NYLORUN_SANDBOX_JOIN_FILE=/run/nylorun/join/token -e NYLORUN_HARNESS_URL=http://192.0.2.1:41001 \
  -e NYLORUN_GATES_URL=http://192.0.2.1:41002 -e NYLORUN_EGRESS_PROXY=http://192.0.2.1:41003 \
  --entrypoint /bin/bash "$image" -euo pipefail -c '
    test "$(cat /opt/nylorun/VERSION)" = "'"$version"'"
    test -x /opt/nylorun/bin/tini && test -f /opt/nylorun/engine/harness.mjs
    /opt/nylorun/bin/node --version
    ! touch /opt/nylorun/x 2>/dev/null
    # The engine reads its settings, then waits for the join token no smoke test has.
    timeout 10 /opt/nylorun/bin/tini -s -g -- /opt/nylorun/bin/node /opt/nylorun/engine/harness.mjs --service harness 2>&1 || true
  ')"
echo "$out" | tail -5
grep -q '"message":"host_stack_config"' <<<"$out" || { echo "the engine did not start"; exit 1; }
echo "smoke: $image passed (engine $version)"
