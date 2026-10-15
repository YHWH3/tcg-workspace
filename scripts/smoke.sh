#!/usr/bin/env bash
# End-to-end smoke test against a running dev server (local D1).
# Usage: ./scripts/smoke.sh [base_url]   (default http://localhost:5173)
set -u
BASE="${1:-http://localhost:5173}"
node --input-type=module -e 'import {localOrigin} from "./scripts/certification/core.mjs";localOrigin(process.argv[1]);' "$BASE" || exit 2
SMOKE_TMP=$(mktemp -d "${TMPDIR:-/tmp}/tcg-smoke.XXXXXX") || exit 2
trap 'rm -rf "$SMOKE_TMP"' EXIT
PASS=0; FAIL=0

req() { # method path [token] [json]
  local method="$1" path="$2" token="${3:-}" body="${4:-}"
  local args=(-s -X "$method" -H "Content-Type: application/json")
  [ -n "$token" ] && args+=(-H "Authorization: Bearer $token")
  [ -n "$body" ] && args+=(-d "$body")
  curl --connect-timeout 5 --max-time 30 "${args[@]}" "$BASE$path"
}
jget() { python3 -c "import json,sys; d=json.load(sys.stdin); print($1)" 2>/dev/null; }

check() { # name condition
  if [ "$2" = "$3" ]; then PASS=$((PASS+1)); echo "  ✅ $1";
  else FAIL=$((FAIL+1)); echo "  ❌ $1 (want '$3', got '$2')"; fi
}

echo "== smoke: $BASE"

STATUS=$(req GET /api/auth/status)
check "needsBootstrap=true initially" "$(echo "$STATUS" | jget 'd["needsBootstrap"]')" "True"

# 1. bootstrap admin
R=$(req POST /api/auth/signup '' '{"username":"admin","name":"Admin","password":"password123"}')
TA=$(echo "$R" | jget 'd.get("token","")')
check "bootstrap signup returns token" "$([ -n "$TA" ] && echo yes)" "yes"
check "bootstrap user is admin" "$(echo "$R" | jget 'd["user"]["role"]')" "admin"

# 2. signup without invite rejected
R=$(req POST /api/auth/signup '' '{"username":"nope","name":"N","password":"password123"}')
check "signup without invite rejected" "$(echo "$R" | jget 'd.get("error","")')" "Invite code required"

# 3. admin creates invite
R=$(req POST /api/invites "$TA")
CODE=$(echo "$R" | jget 'd.get("code","")')
check "invite generated (8 chars)" "${#CODE}" "8"

# 4. signup with invite works
R=$(req POST /api/auth/signup '' "{\"username\":\"bob\",\"name\":\"Bob\",\"password\":\"password123\",\"inviteCode\":\"$CODE\"}")
TB=$(echo "$R" | jget 'd.get("token","")')
check "invite signup returns token" "$([ -n "$TB" ] && echo yes)" "yes"
check "invited user is member" "$(echo "$R" | jget 'd[\"user\"][\"role\"]' 2>/dev/null || echo "$R" | python3 -c 'import json,sys; print(json.load(sys.stdin)["user"]["role"])')" "member"

# 5. invite reuse rejected
R=$(req POST /api/auth/signup '' "{\"username\":\"carol\",\"name\":\"C\",\"password\":\"password123\",\"inviteCode\":\"$CODE\"}")
check "invite reuse rejected" "$(echo "$R" | jget 'd.get(\"error\",\"\")' 2>/dev/null || echo "$R" | python3 -c 'import json,sys; print(json.load(sys.stdin).get("error",""))')" "Invalid or used invite code"

# 6. fill to 7, then 8th rejected
for i in 3 4 5 6 7; do
  C=$(req POST /api/invites "$TA" | jget 'd["code"]')
  req POST /api/auth/signup '' "{\"username\":\"user$i\",\"name\":\"U$i\",\"password\":\"password123\",\"inviteCode\":\"$C\"}" >/dev/null
done
C8=$(req POST /api/invites "$TA" | jget 'd["code"]')
R=$(req POST /api/auth/signup '' "{\"username\":\"eight\",\"name\":\"E\",\"password\":\"password123\",\"inviteCode\":\"$C8\"}")
check "8th signup rejected (cap)" "$(echo "$R" | python3 -c 'import json,sys; print(json.load(sys.stdin).get("error",""))')" "Workspace is full (7 seats)"

SEATS=$(req GET /api/users "$TA" | python3 -c 'import json,sys; print(len(json.load(sys.stdin)["users"]))')
check "exactly 7 users" "$SEATS" "7"

# 7. member cannot create invite
R=$(req POST /api/invites "$TB")
check "member invite forbidden" "$(echo "$R" | python3 -c 'import json,sys; print(json.load(sys.stdin).get("error",""))')" "forbidden"

# 8. push from A, pull as B
NOW=$(python3 -c 'import time; print(int(time.time()*1000))')
req POST /api/sync/push "$TA" "{\"changes\":[{\"id\":\"page1\",\"collection\":\"pages\",\"patch\":{\"title\":\"Hello\",\"order\":\"a0\"},\"ts\":$NOW}]}" >/dev/null
R=$(req GET "/api/sync/pull?since=0" "$TB")
check "B sees A's pushed record" "$(echo "$R" | python3 -c 'import json,sys; d=json.load(sys.stdin); print(d["records"][0]["data"]["title"])')" "Hello"

# 9. conflicting pushes: different fields both survive; same field higher ts wins
req POST /api/sync/push "$TA" "{\"changes\":[{\"id\":\"page1\",\"collection\":\"pages\",\"patch\":{\"icon\":\"🚀\",\"title\":\"older\"},\"ts\":$((NOW+10))}]}" >/dev/null
req POST /api/sync/push "$TB" "{\"changes\":[{\"id\":\"page1\",\"collection\":\"pages\",\"patch\":{\"title\":\"newer\"},\"ts\":$((NOW+20))}]}" >/dev/null
R=$(req GET "/api/sync/pull?since=0" "$TA")
check "disjoint field merge" "$(echo "$R" | python3 -c 'import json,sys; d=json.load(sys.stdin); rec=[r for r in d["records"] if r["id"]=="page1"][0]; print(rec["data"]["icon"], rec["data"]["title"])')" "🚀 newer"
R=$(req GET "/api/sync/pull?since=0" "$TB" | python3 -c 'import json,sys; d=json.load(sys.stdin); print(d["cursor"], d["hasMore"])')
check "cursor advanced + hasMore false" "$R" "$(echo "$R" | awk '{print $1}') False"

# 10. unknown collection skipped, not stored, batch still ok
R=$(req POST /api/sync/push "$TA" "{\"changes\":[{\"id\":\"x1\",\"collection\":\"secrets\",\"patch\":{\"a\":1},\"ts\":$NOW},{\"id\":\"ok1\",\"collection\":\"pages\",\"patch\":{\"a\":1},\"ts\":$NOW}]}")
check "invalid change skipped, batch ok" "$(echo "$R" | python3 -c 'import json,sys; d=json.load(sys.stdin); print(d.get("ok"), d.get("rejected"))')" "True 1"
R=$(req GET "/api/sync/pull?since=0" "$TB")
check "rejected record not stored" "$(echo "$R" | python3 -c 'import json,sys; print(any(r["id"]=="x1" for r in json.load(sys.stdin)["records"]))')" "False"

# 11. unauthenticated push rejected
R=$(req POST /api/sync/push '' "{\"changes\":[{\"id\":\"x1\",\"collection\":\"pages\",\"patch\":{\"a\":1},\"ts\":$NOW}]}")
check "unauthenticated push 401" "$(echo "$R" | python3 -c 'import json,sys; print(json.load(sys.stdin).get("error",""))')" "unauthenticated"

# 12. concurrent disjoint pushes to same new record keep both fields (x20)
CONC_OK=0
for i in $(seq 1 20); do
  RID="conc_$i"
  T1=$((NOW + 100000 + i))
  T2=$((NOW + 100000 + i))
  req POST /api/sync/push "$TA" "{\"changes\":[{\"id\":\"$RID\",\"collection\":\"pages\",\"patch\":{\"fA\":\"v$i\"},\"ts\":$T1}]}" >/dev/null &
  req POST /api/sync/push "$TB" "{\"changes\":[{\"id\":\"$RID\",\"collection\":\"pages\",\"patch\":{\"fB\":\"w$i\"},\"ts\":$T2}]}" >/dev/null &
  wait
  GOT=$(req GET "/api/sync/pull?since=0" "$TA" | python3 -c "import json,sys; d=json.load(sys.stdin); r=[x for x in d['records'] if x['id']=='$RID']; print('ok' if r and r[0]['data'].get('fA')=='v$i' and r[0]['data'].get('fB')=='w$i' else 'bad')")
  [ "$GOT" = "ok" ] && CONC_OK=$((CONC_OK+1))
done
check "concurrent disjoint-field pushes (20 races)" "$CONC_OK" "20"

# 13. file storage: chunked upload, byte-identical download, limits
FID="smokefile_$$"
head -c 2621440 /dev/urandom > ${SMOKE_TMP}/smoke_file.bin   # 2.5 MiB → 3 chunks
SHA_IN=$(shasum -a 256 ${SMOKE_TMP}/smoke_file.bin | awk '{print $1}')

code() { curl --connect-timeout 5 --max-time 30 -s -o /dev/null -w '%{http_code}' "$@"; }

# unauthenticated chunk upload → 401
check "unauth chunk PUT 401" "$(code -X PUT --data-binary 'x' "$BASE/api/files/$FID/chunks/0")" "401"

# incomplete file → GET 404
split -b 1048576 ${SMOKE_TMP}/smoke_file.bin ${SMOKE_TMP}/smoke_chunk_
C=$(code -X PUT -H "Authorization: Bearer $TA" --data-binary @${SMOKE_TMP}/smoke_chunk_aa "$BASE/api/files/$FID/chunks/0")
check "chunk 0 PUT ok" "$C" "200"
check "incomplete file GET 404" "$(code -H "Authorization: Bearer $TA" "$BASE/api/files/$FID")" "404"

# remaining chunks, idempotent re-PUT of chunk 0
code -X PUT -H "Authorization: Bearer $TA" --data-binary @${SMOKE_TMP}/smoke_chunk_aa "$BASE/api/files/$FID/chunks/0" >/dev/null
code -X PUT -H "Authorization: Bearer $TA" --data-binary @${SMOKE_TMP}/smoke_chunk_ab "$BASE/api/files/$FID/chunks/1" >/dev/null
code -X PUT -H "Authorization: Bearer $TA" --data-binary @${SMOKE_TMP}/smoke_chunk_ac "$BASE/api/files/$FID/chunks/2" >/dev/null

R=$(req POST "/api/files/$FID/complete" "$TA" '{"mime":"application/octet-stream","size":2621440,"chunks":3}')
check "complete ok" "$(echo "$R" | python3 -c 'import json,sys; print(json.load(sys.stdin).get("ok"))')" "True"
# complete is idempotent
R=$(req POST "/api/files/$FID/complete" "$TA" '{"mime":"application/octet-stream","size":2621440,"chunks":3}')
check "complete idempotent" "$(echo "$R" | python3 -c 'import json,sys; print(json.load(sys.stdin).get("ok"))')" "True"

curl --connect-timeout 5 --max-time 30 -s -H "Authorization: Bearer $TA" -o ${SMOKE_TMP}/smoke_file.out "$BASE/api/files/$FID"
SHA_OUT=$(shasum -a 256 ${SMOKE_TMP}/smoke_file.out | awk '{print $1}')
check "GET byte-identical (sha256)" "$SHA_OUT" "$SHA_IN"
check "GET cache header" "$(curl --connect-timeout 5 --max-time 30 -s -D - -o /dev/null -H "Authorization: Bearer $TA" "$BASE/api/files/$FID" | grep -i 'cache-control' | tr -d '\r' | tr '[:upper:]' '[:lower:]')" "cache-control: private, no-store"

# usage endpoint reflects the upload
USED=$(req GET /api/files/usage "$TA" | python3 -c 'import json,sys; d=json.load(sys.stdin); print(d["used"] >= 2621440, d["limit"])')
check "usage reflects upload" "$USED" "True 471859200"

# >20 MB rejected at complete
FID2="toobig_$$"
code -X PUT -H "Authorization: Bearer $TA" --data-binary 'x' "$BASE/api/files/$FID2/chunks/0" >/dev/null
check "oversized file complete 413" "$(code -X POST -H "Authorization: Bearer $TA" -H 'Content-Type: application/json' -d '{"mime":"x","size":21943040,"chunks":1}' "$BASE/api/files/$FID2/complete")" "413"

# oversize chunk rejected
head -c 3145729 /dev/urandom > ${SMOKE_TMP}/smoke_big.bin   # > 2 MiB chunk cap
check "oversize chunk PUT 413" "$(code -X PUT -H "Authorization: Bearer $TA" --data-binary @${SMOKE_TMP}/smoke_big.bin "$BASE/api/files/bigchunk_$$/chunks/0")" "413"

# delete removes the file
check "DELETE ok" "$(code -X DELETE -H "Authorization: Bearer $TA" "$BASE/api/files/$FID")" "200"
check "deleted file GET 404" "$(code -H "Authorization: Bearer $TA" "$BASE/api/files/$FID")" "404"

rm -f ${SMOKE_TMP}/smoke_file.bin ${SMOKE_TMP}/smoke_file.out ${SMOKE_TMP}/smoke_big.bin ${SMOKE_TMP}/smoke_chunk_*

# 15. public share links + live socket auth
PID="share_root_$$"; CID="share_child_$$"; OID="share_other_$$"
NOW=$(python3 -c 'import time; print(int(time.time()*1000))')
# a referenced file + an unreferenced one
PUBFID="pubfile_$$"; UNREFFID="unref_$$"
echo -n 'public-bytes' > ${SMOKE_TMP}/smoke_pub.bin
code -X PUT -H "Authorization: Bearer $TA" --data-binary @${SMOKE_TMP}/smoke_pub.bin "$BASE/api/files/$PUBFID/chunks/0" >/dev/null
code -X POST -H "Authorization: Bearer $TA" -H 'Content-Type: application/json' -d '{"mime":"text/plain","size":12,"chunks":1}' "$BASE/api/files/$PUBFID/complete" >/dev/null
code -X PUT -H "Authorization: Bearer $TA" --data-binary @${SMOKE_TMP}/smoke_pub.bin "$BASE/api/files/$UNREFFID/chunks/0" >/dev/null
code -X POST -H "Authorization: Bearer $TA" -H 'Content-Type: application/json' -d '{"mime":"text/plain","size":12,"chunks":1}' "$BASE/api/files/$UNREFFID/complete" >/dev/null
# pages + a block referencing PUBFID inside the child
req POST /api/sync/push "$TA" "{\"changes\":[{\"id\":\"$PID\",\"collection\":\"pages\",\"patch\":{\"title\":\"Shared\",\"order\":\"aY\"},\"ts\":$NOW},{\"id\":\"$CID\",\"collection\":\"pages\",\"patch\":{\"title\":\"Child\",\"parentId\":\"$PID\",\"order\":\"aZ\"},\"ts\":$NOW},{\"id\":\"$OID\",\"collection\":\"pages\",\"patch\":{\"title\":\"Other\",\"order\":\"b0\"},\"ts\":$NOW},{\"id\":\"pb1_$$\",\"collection\":\"blocks\",\"patch\":{\"pageId\":\"$CID\",\"type\":\"image\",\"fileId\":\"$PUBFID\",\"order\":\"c0\",\"text\":\"\"},\"ts\":$NOW}]}" >/dev/null

R=$(req POST /api/shares "$TA" "{\"pageId\":\"$PID\"}")
TOKEN=$(echo "$R" | python3 -c 'import json,sys; print(json.load(sys.stdin).get("token",""))')
check "share token created" "${#TOKEN}" "43"
R=$(req POST /api/shares "$TA" "{\"pageId\":\"$PID\"}")
check "share create idempotent" "$(echo "$R" | python3 -c 'import json,sys; print(json.load(sys.stdin)["token"])')" "$TOKEN"
check "share listed" "$(req GET /api/shares "$TA" | python3 -c "import json,sys; print(any(s['page_id']=='$PID' for s in json.load(sys.stdin)))")" "True"

R=$(curl --connect-timeout 5 --max-time 30 -s "$BASE/api/public/$TOKEN")
check "public tree has child page" "$(echo "$R" | python3 -c "import json,sys; d=json.load(sys.stdin); print(any(n['id']=='$CID' for n in d['tree']), d['page']['title'])")" "True Shared"
check "public child page ok" "$(code "$BASE/api/public/$TOKEN/pages/$CID")" "200"
R=$(curl --connect-timeout 5 --max-time 30 -s "$BASE/api/public/$TOKEN/pages/$CID")
check "public page block has file" "$(echo "$R" | python3 -c "import json,sys; d=json.load(sys.stdin); print(d['blocks'][0]['fileId']=='$PUBFID')")" "True"
check "non-descendant page denied" "$(code "$BASE/api/public/$TOKEN/pages/$OID")" "404"
curl --connect-timeout 5 --max-time 30 -s -o ${SMOKE_TMP}/smoke_pubdl.out "$BASE/api/public/$TOKEN/files/$PUBFID"
check "public file allowed when referenced" "$(shasum -a 256 ${SMOKE_TMP}/smoke_pubdl.out | awk '{print $1}')" "$(shasum -a 256 ${SMOKE_TMP}/smoke_pub.bin | awk '{print $1}')"
check "public file denied when unreferenced" "$(code "$BASE/api/public/$TOKEN/files/$UNREFFID")" "404"

check "shares require auth" "$(code -X POST -H 'Content-Type: application/json' -d '{"pageId":"x"}' "$BASE/api/shares")" "401"

# live socket: upgrade without/with-bad subprotocol token must be rejected
# --http1.1: h2 strips hop-by-hop Upgrade headers, so the worker would see a plain GET.
WSCODE=$(curl --connect-timeout 5 --max-time 30 -s --http1.1 -o /dev/null -w '%{http_code}' -H 'Connection: Upgrade' -H 'Upgrade: websocket' -H 'Sec-WebSocket-Version: 13' -H 'Sec-WebSocket-Key: dGhlIHNhbXBsZSBub25jZQ==' "$BASE/api/live")
check "live upgrade without subprotocol rejected" "$([ "$WSCODE" = "401" ] || [ "$WSCODE" = "400" ] || [ "$WSCODE" = "426" ] && echo rejected)" "rejected"
WSCODE=$(curl --connect-timeout 5 --max-time 30 -s --http1.1 -o /dev/null -w '%{http_code}' -H 'Connection: Upgrade' -H 'Upgrade: websocket' -H 'Sec-WebSocket-Version: 13' -H 'Sec-WebSocket-Key: dGhlIHNhbXBsZSBub25jZQ==' -H 'Sec-WebSocket-Protocol: ws-auth, deadbeef' "$BASE/api/live")
check "live upgrade with bad token rejected" "$WSCODE" "401"

# revoke → public routes go dark
code -X DELETE -H "Authorization: Bearer $TA" "$BASE/api/shares/$PID" >/dev/null
check "public 404 after revoke" "$(code "$BASE/api/public/$TOKEN")" "404"
rm -f ${SMOKE_TMP}/smoke_pub.bin ${SMOKE_TMP}/smoke_pubdl.out

# 16. login works
R=$(req POST /api/auth/login '' '{"username":"admin","password":"password123"}')
check "login returns token" "$(echo "$R" | python3 -c 'import json,sys; print("yes" if json.load(sys.stdin).get("token") else "no")')" "yes"

echo
echo "== $PASS passed, $FAIL failed"
[ "$FAIL" -eq 0 ]
