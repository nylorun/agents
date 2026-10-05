#!/usr/bin/env bash
# Walks the self-host example end to end (README.md): a running `nylorun start --tenant selfhost`
# Tenant with identity.yaml, plus this directory's Compose stack. Needs bash, curl and node.
#
#   1. Keycloak signs ben (a member) and ada (with the studio scope) in.
#   2. ben's token is a trusted issuer's: GET /v1/me renders its subject, scopes and sandbox grants.
#   3. A backend's operator key acts for any subject (Nylorun-Subject); browsers cannot use it.
#   4. ben's token sees only ben's sessions, and reaches no vault route.
#   5. ben's own MCP credential comes from OpenBao through the resolver, on the resolver contract.
#   6. Studio, through oauth2-proxy, admits ada (studio scope) and refuses ben.
#
# Environment (defaults match compose.yaml): NYLORUN_TENANT (selfhost), NYLORUN_CLI (npx --yes
# nylorun), RUNTIME_URL (from nylorun status), NYLORUN_KEY (else `nylorun key put smoke`, which
# rotates that key), KEYCLOAK_URL, PROXY_URL, RESOLVER_URL, NYLORUN_RESOLVER_TOKEN, BAO_ADDR,
# BAO_TOKEN.
set -euo pipefail

TENANT=${NYLORUN_TENANT:-selfhost}
NYLORUN=${NYLORUN_CLI:-npx --yes nylorun}
KEYCLOAK_URL=${KEYCLOAK_URL:-http://localhost:8180}
PROXY_URL=${PROXY_URL:-http://localhost:4180}
RESOLVER_URL=${RESOLVER_URL:-http://localhost:8090}
RESOLVER_TOKEN=${NYLORUN_RESOLVER_TOKEN:-selfhost-example-resolver-token}
BAO_ADDR=${BAO_ADDR:-http://localhost:8200}
BAO_TOKEN=${BAO_TOKEN:-selfhost-example-root-token}
PROTOCOL=8
RUN="$(date +%s)-$$"

work=$(mktemp -d)
trap 'rm -rf "$work"' EXIT
status=""

pass() { printf 'PASS %s\n' "$*"; }
die() {
  printf 'FAIL %s\n' "$*" >&2
  exit 1
}
# js <expression>: evaluates a JavaScript expression over the JSON on stdin (as `v`); strings print
# raw, anything else as JSON.
js() {
  node -e 'const v = JSON.parse(require("node:fs").readFileSync(0, "utf8"));
const r = new Function("v", `return (${process.argv[1]});`)(v);
process.stdout.write(typeof r === "string" ? r : JSON.stringify(r));' "$1"
}
# call METHOD URL [curl arguments]: the status in $status, the body in $work/body.
call() {
  local method=$1 url=$2
  shift 2
  status=$(curl -sS -o "$work/body" -w '%{http_code}' -X "$method" "$@" "$url") || die "$method $url: no answer"
}
body() { cat "$work/body"; }
expect() { [ "$status" = "$1" ] || die "$2: HTTP $status, expected $1: $(head -c 400 "$work/body")"; }
check() { [ "$(body | js "$1")" = "true" ] || die "$2: $(head -c 400 "$work/body")"; }
# rt METHOD PATH BEARER [curl arguments]: a Tenant API call.
rt() {
  local method=$1 path=$2 bearer=$3
  shift 3
  call "$method" "$RUNTIME_URL$path" -H "Authorization: Bearer $bearer" -H "Nylorun-Protocol: $PROTOCOL" "$@"
}
# json_of <expression> [values]: prints a JavaScript object expression as JSON; the values are a[0], a[1]…
json_of() {
  node -e 'const a = process.argv.slice(2);
process.stdout.write(JSON.stringify(new Function("a", `return (${process.argv[1]});`)(a)));' "$@"
}

RUNTIME_URL=${RUNTIME_URL:-$($NYLORUN status --tenant "$TENANT" --json | js 'v.runtime.url ?? ""')}
[ -n "$RUNTIME_URL" ] || die "Tenant $TENANT has no Runtime URL: run nylorun start --tenant $TENANT --no-link first"
call GET "$RUNTIME_URL/health"
expect 200 "the Runtime at $RUNTIME_URL"
echo "Runtime $RUNTIME_URL (Tenant $TENANT)"

# 1. Keycloak tokens: the password grant on the realm's smoke client (never in production).
token() {
  call POST "$KEYCLOAK_URL/realms/nylorun/protocol/openid-connect/token" \
    -d grant_type=password -d client_id=nylorun-smoke -d "username=$1" -d "password=$1"
  expect 200 "a Keycloak token for $1 (is the Compose stack up?)"
  body | js 'v.access_token'
}
BEN=$(token ben)
ADA=$(token ada)
pass "Keycloak signed ben and ada in"

# 2. ben's token, as the Runtime renders it (identity.yaml).
rt GET /v1/me "$BEN"
expect 200 "GET /v1/me with ben's token (is identity.yaml in the Host root, and the Tenant restarted?)"
check 'v.via === "issuer:keycloak"' "ben's token is issuer keycloak's"
check 'v.subject.startsWith("u:")' "ben's subject is u:<sub>"
check 'v.scopes.includes("sessions:own") && v.scopes.includes("agents:read") && !v.scopes.includes("studio")' \
  "ben holds sessions:own and agents:read, not studio"
check 'JSON.stringify(v.sandboxes) === JSON.stringify(["acme/*"])' "ben reaches only the sandboxes acme/*"
BEN_SUBJECT=$(body | js 'v.subject')
rt GET /v1/me "$ADA"
expect 200 "GET /v1/me with ada's token"
check 'v.scopes.includes("studio")' "ada holds studio"
pass "GET /v1/me: ben is $BEN_SUBJECT with sessions:own, agents:read and sandboxes acme/*; ada has studio"

rt GET /v1/me "$BEN" -H "Origin: http://localhost:5173"
expect 200 "ben's token from a browser (Origin)"
pass "a browser request with ben's token is served"

# 3. A backend's operator key acts for any subject.
KEY=${NYLORUN_KEY:-$($NYLORUN key put smoke --tenant "$TENANT")}
rt GET /v1/me "$KEY"
expect 200 "GET /v1/me with the operator key"
check 'v.via.startsWith("application:")' "the operator key is an application key"
rt GET /v1/me "$KEY" -H "Origin: http://localhost:5173"
expect 403 "the operator key from a browser"
check 'v.code === "origin_rejected"' "the operator key from a browser is origin_rejected"

AGENT=self-host-smoke
rt PUT "/v1/agents/$AGENT" "$KEY" -H "content-type: application/json" -d "$(json_of '{
  requestId: a[0], implementationVersion: "smoke",
  manifest: { id: a[1], name: "Self-host smoke", manifestSchemaVersion: 4, capabilities: [] } }' "agent-$RUN" "$AGENT")"
expect 200 "PUT /v1/agents/$AGENT with the operator key"

OWN="smoke-$RUN-ben"
OTHER="smoke-$RUN-other"
OTHER_SUBJECT="u:smoke-someone-else"
for pair in "$OWN|$BEN_SUBJECT" "$OTHER|$OTHER_SUBJECT"; do
  id=${pair%%|*}
  subject=${pair#*|}
  rt PUT "/v1/sessions/$id" "$KEY" -H "Nylorun-Subject: $subject" -H "Nylorun-Scopes: sessions:own" \
    -H "content-type: application/json" \
    -d "$(json_of '{ requestId: a[0], agentId: a[1], ownerUserId: a[2] }' "$id" "$AGENT" "$subject")"
  expect 200 "PUT /v1/sessions/$id for $subject with the operator key"
done
pass "the operator key created a session for $BEN_SUBJECT and one for $OTHER_SUBJECT"

# 4. ben sees only his own sessions.
rt GET /v1/sessions "$BEN"
expect 200 "GET /v1/sessions with ben's token"
check "v.sessions.some((s) => s.id === \"$OWN\")" "ben lists his session"
check "!v.sessions.some((s) => s.id === \"$OTHER\")" "ben does not list another person's session"
check "v.sessions.every((s) => s.ownerUserId === \"$BEN_SUBJECT\")" "ben lists only his own sessions"
rt GET "/v1/sessions/$OTHER" "$BEN"
expect 404 "another person's session with ben's token"
rt PUT "/v1/sessions/smoke-$RUN-steal" "$BEN" -H "content-type: application/json" \
  -d "$(json_of '{ requestId: a[0], agentId: a[1], ownerUserId: a[2] }' "steal-$RUN" "$AGENT" "$OTHER_SUBJECT")"
expect 403 "a session for another owner with ben's token"
rt GET /v1/tenant/vaults "$BEN"
expect 403 "GET /v1/tenant/vaults (the Management API) with ben's token"
pass "ben's token lists only his sessions, gets 404 for another's, and reaches no vault route"

# 5. ben's own MCP credential, from OpenBao through the resolver.
GITHUB_TOKEN="ghp_smoke_$RUN"
OWNER_PATH=$(node -p 'encodeURIComponent(process.argv[1])' "$BEN_SUBJECT")
call POST "$BAO_ADDR/v1/secret/data/nylorun/$OWNER_PATH/github" -H "X-Vault-Token: $BAO_TOKEN" \
  -H "content-type: application/json" -d "$(json_of '{ data: { token: a[0] } }' "$GITHUB_TOKEN")"
expect 200 "writing ben's GitHub token to OpenBao"
lookup() {
  call POST "$RESOLVER_URL/" -H "Authorization: Bearer $1" -H "content-type: application/json" \
    -d "$(json_of '{ owner: a[0], session: a[1], turn: null,
      target: { kind: "mcp", server: a[2], agent: a[3], url: "https://mcp.example.com/mcp" } }' "$2" "$OWN" "$3" "$AGENT")"
}
lookup "$RESOLVER_TOKEN" "$BEN_SUBJECT" github
expect 200 "the resolver for ben's github"
check "v.headers.authorization === \"Bearer $GITHUB_TOKEN\"" "the resolver answers ben's token as a bearer header"
lookup "$RESOLVER_TOKEN" "$OTHER_SUBJECT" github
expect 404 "the resolver for a person without a github token"
lookup "wrong-token" "$BEN_SUBJECT" github
expect 401 "the resolver with a wrong bearer"
if docker exec "nylorun-$TENANT-gateway" node -e '
  const url = process.env.NYLORUN_RESOLVER_URL;
  if (!url) { console.error("NYLORUN_RESOLVER_URL is not set on the gateway"); process.exit(1); }
  fetch(new URL("/healthz", url), { signal: AbortSignal.timeout(5000) })
    .then((r) => process.exit(r.ok ? 0 : 1), (e) => { console.error(String(e)); process.exit(1); });'; then
  pass "the resolver answers the contract (200 with headers, 404, 401), and the gateway reaches it"
else
  die "the gateway (nylorun-$TENANT-gateway) cannot reach its resolver: start the Tenant with NYLORUN_RESOLVER_URL=http://resolver:8090 and NYLORUN_RESOLVER_TOKEN set"
fi

# 6. Studio through oauth2-proxy (Studio verifies the forwarded token with GET /v1/me).
call GET "$PROXY_URL/_studio/hello"
[ "$status" != 200 ] || die "Studio through the proxy answered 200 without a credential"
call GET "$PROXY_URL/_studio/hello" -H "Authorization: Bearer $BEN"
expect 403 "Studio through the proxy with ben's token (no studio scope)"
call GET "$PROXY_URL/_studio/hello" -H "Authorization: Bearer $ADA"
expect 200 "Studio through the proxy with ada's token (is the Tenant started with NYLORUN_STUDIO_ALLOWED_HOSTS=localhost:4180?)"
check 'typeof v.version === "string"' "Studio answers ada with its hello"
pass "Studio through oauth2-proxy: no credential is refused, ben gets 403, ada is signed in"

echo "Self-host smoke passed."
