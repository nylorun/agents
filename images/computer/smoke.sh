#!/usr/bin/env bash
# smoke.sh IMAGE: the computer agent as a computer's template runs it: /computer taken out of IMAGE
# and mounted at /nylo/computer in a plain Debian image, with the variables the template sets. It
# checks /ready without a ticket, a refused ticket, /v1/info and a command with a ticket signed
# here (openssl, Ed25519), and that SIGTERM on Substrate leaves it serving.
# BINARY=path smoke.sh runs a built binary on this machine instead, without Docker.
# Needs openssl 3 and curl. Exits non-zero on the first failure.
set -euo pipefail
image=${1:-}
work=$(mktemp -d)
container=""
pid=""
cleanup() {
  [ -n "$container" ] && docker rm -f "$container" >/dev/null 2>&1 || true
  [ -n "$pid" ] && { kill -9 "$pid"; wait "$pid"; } 2>/dev/null || true
  rm -rf "$work"
}
trap cleanup EXIT

name=sbx-smokesmokesmoke0-g0
mkdir -p "$work/actor" "$work/workspace" "$work/harness"
printf '%s\n' "$name" >"$work/actor/actor-name"
openssl genpkey -algorithm ed25519 -out "$work/key.pem" 2>/dev/null
public=$(openssl pkey -in "$work/key.pem" -pubout)

b64url() { openssl base64 -A | tr '+/' '-_' | tr -d '='; }
ticket() { # ticket SUBJECT
  local header claims
  header=$(printf '{"alg":"EdDSA","typ":"JWT"}' | b64url)
  claims=$(printf '{"aud":"nylorun-computer","sub":"%s","exp":%d}' "$1" $(($(date +%s) + 600)) | b64url)
  printf '%s' "$header.$claims" >"$work/input"
  printf '%s.%s' "$header.$claims" "$(openssl pkeyutl -sign -inkey "$work/key.pem" -rawin -in "$work/input" | b64url)"
}

if [ -n "${BINARY:-}" ]; then
  port=$((20000 + RANDOM % 20000))
  NYLORUN_COMPUTER_PORT=$port NYLORUN_COMPUTER_TICKET_KEY=$public NYLORUN_COMPUTER_NAME_FILE=$work/actor/actor-name \
    NYLORUN_COMPUTER_WORKSPACE=$work/workspace NYLORUN_HARNESS_ROOT=$work/harness NYLORUN_SANDBOX_SUBSTRATE=1 \
    NYLORUN_COMPUTER_TRUST_FILE=$work/trust.pem "$BINARY" >"$work/log" 2>&1 &
  pid=$!
  workspace=$work/workspace
  stop() { kill -TERM "$pid"; }
  alive() { kill -0 "$pid"; }
else
  [ -n "$image" ] || { echo "usage: smoke.sh IMAGE (or BINARY=path smoke.sh)"; exit 2; }
  made=$(docker create "$image")
  docker cp "$made:/computer" "$work/computer"
  docker rm "$made" >/dev/null
  container=$(docker run -d -p 127.0.0.1::8080 \
    -v "$work/computer:/nylo/computer:ro" -v "$work/actor:/run/nylorun/actor:ro" \
    -e NYLORUN_COMPUTER_PORT=8080 -e NYLORUN_COMPUTER_TICKET_KEY="$public" \
    -e NYLORUN_COMPUTER_NAME_FILE=/run/nylorun/actor/actor-name -e NYLORUN_SANDBOX_SUBSTRATE=1 \
    -e HOME=/harness/home --entrypoint /nylo/computer debian:bookworm-slim)
  port=$(docker port "$container" 8080/tcp | head -1 | sed 's/.*://')
  workspace=/workspace
  stop() { docker kill -s TERM "$container" >/dev/null; }
  alive() { [ "$(docker inspect -f '{{.State.Running}}' "$container")" = true ]; }
fi
url=http://127.0.0.1:$port

for _ in $(seq 50); do curl -fsS "$url/ready" >/dev/null 2>&1 && break; sleep 0.2; done
curl -fsS "$url/ready" | grep -q '"status":"ok"'
good=$(ticket "$name")
test "$(curl -s -o /dev/null -w '%{http_code}' -H "x-nylorun-ticket: $(ticket sbx-other-g0)" "$url/v1/info")" = 401
curl -fsS -H "x-nylorun-ticket: $good" "$url/v1/info" | grep -q "\"workspace\":\"$workspace\""
answer=$(curl -fsS -H "x-nylorun-ticket: $good" -d '{"id":"smoke","command":"echo \"$HOME\"; test -n \"$SSL_CERT_FILE\" || echo no-trust","timeoutMs":10000,"waitMs":10000}' "$url/v1/exec")
echo "$answer" | grep -q "\"stdout\":\"$workspace\\\\nno-trust\\\\n\"" || { echo "exec: $answer"; exit 1; }
stop
sleep 1
alive
curl -fsS "$url/ready" >/dev/null
echo "smoke: ${image:-$BINARY} passed"
