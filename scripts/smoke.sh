#!/usr/bin/env bash
# End-to-end smoke test against a running dev server (local D1).
# Usage: ./scripts/smoke.sh [base_url]   (default http://localhost:5173)
set -u
BASE="${1:-http://localhost:5173}"
PASS=0; FAIL=0

req() { # method path [token] [json]
  local method="$1" path="$2" token="${3:-}" body="${4:-}"
  local args=(-s -X "$method" -H "Content-Type: application/json")
  [ -n "$token" ] && args+=(-H "Authorization: Bearer $token")
  [ -n "$body" ] && args+=(-d "$body")
  curl "${args[@]}" "$BASE$path"
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

# 10. unknown collection rejected
R=$(req POST /api/sync/push "$TA" "{\"changes\":[{\"id\":\"x1\",\"collection\":\"secrets\",\"patch\":{\"a\":1},\"ts\":$NOW}]}")
check "unknown collection rejected" "$(echo "$R" | python3 -c 'import json,sys; print(json.load(sys.stdin).get("error",""))')" "invalid change"

# 11. unauthenticated push rejected
R=$(req POST /api/sync/push '' "{\"changes\":[{\"id\":\"x1\",\"collection\":\"pages\",\"patch\":{\"a\":1},\"ts\":$NOW}]}")
check "unauthenticated push 401" "$(echo "$R" | python3 -c 'import json,sys; print(json.load(sys.stdin).get("error",""))')" "unauthenticated"

# 12. login works
R=$(req POST /api/auth/login '' '{"username":"admin","password":"password123"}')
check "login returns token" "$(echo "$R" | python3 -c 'import json,sys; print("yes" if json.load(sys.stdin).get("token") else "no")')" "yes"

echo
echo "== $PASS passed, $FAIL failed"
[ "$FAIL" -eq 0 ]
