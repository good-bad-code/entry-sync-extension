#!/usr/bin/env bash
# ================================================================
# RLS Expected Behavior Tests (TDD - RED/GREEN phase)
#
# Encodes the EXPECTED behavior AFTER the RLS migration (T5).
# These tests FAIL before the RLS migration and PASS after it.
#
# RLS policy (from supabase/rls-migration.sql):
#   USING (project_id = COALESCE(
#     current_setting('request.headers', true)::json->>'x-project-id', ''
#   ))
#   WITH CHECK (project_id = COALESCE(
#     current_setting('request.headers', true)::json->>'x-project-id', ''
#   ))
#
# Test breakdown:
#   Before migration → FAIL: 1, 3, 5, 6   PASS: 2, 4, 7, 8
#   After migration  → ALL PASS
# ================================================================
set -euo pipefail

# --- Source config from src/config.ts ---
SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
PROJECT_DIR="$(cd "$SCRIPT_DIR/.." && pwd)"
CONFIG_FILE="$PROJECT_DIR/src/config.ts"

SUPABASE_URL=$(python3 -c "
import re
with open('$CONFIG_FILE') as f:
    text = f.read()
m = re.search(r\"SUPABASE_URL\s*=\s*'([^']+)'\", text)
if m: print(m.group(1))
")
SUPABASE_ANON_KEY=$(python3 -c "
import re
with open('$CONFIG_FILE') as f:
    text = f.read()
text_flat = re.sub(r'\s+', ' ', text)
text_flat = re.sub(r\"'\s*\+\s*'\", '', text_flat)
m = re.search(r\"SUPABASE_ANON_KEY\s*=\s*'([^']+)'\", text_flat)
if m: print(m.group(1))
")

if [[ -z "$SUPABASE_URL" || -z "$SUPABASE_ANON_KEY" ]]; then
  echo "ERROR: Failed to parse SUPABASE_URL or SUPABASE_ANON_KEY from $CONFIG_FILE"
  exit 2
fi

REST_URL="${SUPABASE_URL}/rest/v1"

# --- Test identifiers ---
TEST_TS=$(date +%s)
TEST_PROJECT_ID="test-rls-expected-${TEST_TS}"
WRONG_PROJECT_ID="test-rls-expected-wrong-${TEST_TS}"
MISMATCH_PROJECT_ID="test-rls-expected-mismatch-${TEST_TS}"

PASS_COUNT=0
FAIL_COUNT=0
TOTAL=8

echo "======================================"
echo " RLS Expected Behavior Tests"
echo " (TDD — fail before migration)"
echo "======================================"
echo "Project:        $PROJECT_DIR"
echo "Supabase:       $SUPABASE_URL"
echo "Test project:   $TEST_PROJECT_ID"
echo "======================================"
echo ""

# --- Headers ---
BASE_HEADERS=(
  -H "apikey: ${SUPABASE_ANON_KEY}"
  -H "Authorization: Bearer ${SUPABASE_ANON_KEY}"
  -H "Content-Type: application/json"
  -H "Prefer: resolution=merge-duplicates"
)

# --------------------------------------------------
# Helper functions
# --------------------------------------------------
do_get() {
  local url="$1"
  shift 1
  local http_code out_file
  out_file=$(mktemp)
  http_code=$(curl -s -o "$out_file" -w "%{http_code}" \
    "${BASE_HEADERS[@]}" "$@" "$url" 2>/dev/null || echo "000")
  echo "$http_code|$(cat "$out_file")"
  rm -f "$out_file"
}

do_post() {
  local url="$1" data="$2"
  shift 2
  local http_code out_file
  out_file=$(mktemp)
  http_code=$(curl -s -o "$out_file" -w "%{http_code}" -X POST \
    "${BASE_HEADERS[@]}" "$@" -d "$data" "$url" 2>/dev/null || echo "000")
  echo "$http_code|$(cat "$out_file")"
  rm -f "$out_file"
}

# Check: pass list of acceptable codes as space-separated string
# Optional 5th arg "true" = also expect empty JSON array body
check() {
  local test_num="$1" desc="$2" expected_codes_str="$3" result="$4"
  local expect_empty="${5:-false}"
  local actual_code="${result%%|*}"
  local body="${result#*|}"

  local code_matched=false
  for ec in $expected_codes_str; do
    if [[ "$actual_code" == "$ec" ]]; then
      code_matched=true
      break
    fi
  done

  if ! $code_matched; then
    echo "  FAIL [Test $test_num] $desc (expected HTTP $expected_codes_str, got HTTP $actual_code)"
    echo "       Body: $body"
    FAIL_COUNT=$((FAIL_COUNT + 1))
    return
  fi

  if [[ "$expect_empty" == "true" ]]; then
    local row_count
    row_count=$(echo "$body" | python3 -c "
import sys, json
try:
    data = json.load(sys.stdin)
    if isinstance(data, list):
        print(len(data))
    else:
        print('not_array')
except Exception:
    print('error')
" 2>/dev/null || echo "error")
    if [[ "$row_count" != "0" ]]; then
      echo "  FAIL [Test $test_num] $desc (expected empty array, got $row_count rows)"
      [ -n "$body" ] && echo "       Body: $body"
      FAIL_COUNT=$((FAIL_COUNT + 1))
      return
    fi
  fi

  echo "  PASS [Test $test_num] $desc (HTTP $actual_code)"
  PASS_COUNT=$((PASS_COUNT + 1))
}

NOW=$(date -u +%Y-%m-%dT%H:%M:%SZ)

# ==============================================================
# TEST 1: GET sync_variables WITHOUT x-project-id
#         → expect 200 + empty array
# After RLS:  project_id = COALESCE(NULL, '') = '' → no rows match
# Before RLS: RLS is true → returns ALL rows (body not empty → FAIL)
# ==============================================================
echo "[Test 1/$TOTAL] GET sync_variables (no x-project-id) — expect 200 + empty array"
result1=$(do_get "${REST_URL}/sync_variables?select=*")
check 1 "GET sync_variables (no x-project-id)" "200" "$result1" "true"
echo ""

# ==============================================================
# TEST 2: GET sync_variables WITH valid x-project-id
#         → expect 200 (rows may or may not exist for this project)
# After RLS:  project_id = '<TEST_PROJECT_ID>' → matching rows
# Before RLS: RLS is true → returns all rows (still 200 → PASS)
# ==============================================================
echo "[Test 2/$TOTAL] GET sync_variables (valid x-project-id) — expect 200"
result2=$(do_get "${REST_URL}/sync_variables?select=*" \
  -H "x-project-id: ${TEST_PROJECT_ID}")
check 2 "GET sync_variables (valid x-project-id)" "200" "$result2"
echo ""

# ==============================================================
# TEST 3: GET sync_variables WITH wrong x-project-id
#         → expect 200 + empty array
# After RLS:  project_id = '<WRONG>' → no rows match
# Before RLS: RLS is true → returns all rows (body not empty → FAIL)
# ==============================================================
echo "[Test 3/$TOTAL] GET sync_variables (wrong x-project-id) — expect 200 + empty array"
result3=$(do_get "${REST_URL}/sync_variables?select=*" \
  -H "x-project-id: ${WRONG_PROJECT_ID}")
check 3 "GET sync_variables (wrong x-project-id)" "200" "$result3" "true"
echo ""

# ==============================================================
# TEST 4: POST sync_variables WITH matching x-project-id + matching body project_id
#         → expect 201
# After RLS:  WITH CHECK: project_id matches header → allowed
# Before RLS: no restriction → allowed (still 201 → PASS)
# ==============================================================
echo "[Test 4/$TOTAL] POST sync_variables (matching project_id) — expect 201"
insert_body="{\"project_id\":\"${TEST_PROJECT_ID}\",\"project_url\":\"https://playentry.org/ws/${TEST_PROJECT_ID}\",\"name\":\"expected_test_var\",\"value\":\"hello_rls_expected\",\"updated_at\":\"${NOW}\"}"
result4=$(do_post "${REST_URL}/sync_variables?on_conflict=project_url,name" "$insert_body" \
  -H "x-project-id: ${TEST_PROJECT_ID}")
check 4 "POST sync_variables (matching project_id)" "201" "$result4"
echo ""

# ==============================================================
# TEST 5: POST sync_variables WITH mismatched body project_id (different from x-project-id)
#         → expect 403 or 401
# After RLS:  WITH CHECK: body.project_id ≠ header → REJECTED (403)
# Before RLS: no restriction → allowed (201 → FAIL)
# ==============================================================
echo "[Test 5/$TOTAL] POST sync_variables (mismatched project_id) — expect 403/401"
mismatch_body="{\"project_id\":\"${MISMATCH_PROJECT_ID}\",\"project_url\":\"https://playentry.org/ws/${MISMATCH_PROJECT_ID}\",\"name\":\"expected_test_mismatch\",\"value\":\"should_be_rejected\",\"updated_at\":\"${NOW}\"}"
result5=$(do_post "${REST_URL}/sync_variables" "$mismatch_body" \
  -H "x-project-id: ${TEST_PROJECT_ID}")
check 5 "POST sync_variables (mismatched project_id)" "401 403" "$result5"
echo ""

# ==============================================================
# TEST 6: POST sync_variables WITHOUT x-project-id
#         → expect 403 or 401
# After RLS:  WITH CHECK: project_id = '' → body.project_id ≠ '' → REJECTED (403)
# Before RLS: no restriction → allowed (201 → FAIL)
# ==============================================================
echo "[Test 6/$TOTAL] POST sync_variables (no x-project-id) — expect 403/401"
no_header_body="{\"project_id\":\"${TEST_PROJECT_ID}\",\"project_url\":\"https://playentry.org/ws/${TEST_PROJECT_ID}\",\"name\":\"expected_test_no_header\",\"value\":\"should_be_rejected\",\"updated_at\":\"${NOW}\"}"
result6=$(do_post "${REST_URL}/sync_variables" "$no_header_body")
check 6 "POST sync_variables (no x-project-id)" "401 403" "$result6"
echo ""

# ==============================================================
# TEST 7: GET sync_lists WITHOUT x-project-id
#         → expect 200 + empty array
# After RLS:  project_id = '' → no rows match → []
# Before RLS: returns all rows (may have data, but still 200 → PASS
#            on HTTP code; body-not-empty would FAIL if checked)
# ==============================================================
echo "[Test 7/$TOTAL] GET sync_lists (no x-project-id) — expect 200 + empty array"
result7=$(do_get "${REST_URL}/sync_lists?select=*")
check 7 "GET sync_lists (no x-project-id)" "200" "$result7" "true"
echo ""

# ==============================================================
# TEST 8: GET sync_lists WITH valid x-project-id — expect 200
# After RLS:  project_id = '<TEST_PROJECT_ID>' → matching rows
# Before RLS: returns all rows (still 200 → PASS)
# ==============================================================
echo "[Test 8/$TOTAL] GET sync_lists (valid x-project-id) — expect 200"
result8=$(do_get "${REST_URL}/sync_lists?select=*" \
  -H "x-project-id: ${TEST_PROJECT_ID}")
check 8 "GET sync_lists (valid x-project-id)" "200" "$result8"
echo ""

# ==============================================================
# Summary
# ==============================================================
echo "======================================"
echo " RESULTS: $PASS_COUNT / $TOTAL passed, $FAIL_COUNT failed"
echo "======================================"

# --- Cleanup: remove test data ---
echo ""
echo "--- Cleanup: removing test data ---"

# Test 4 row (always created)
curl -s -o /dev/null -w "  DELETE sync_variables (test row): HTTP %{http_code}\n" -X DELETE \
  "${BASE_HEADERS[@]}" \
  -H "x-project-id: ${TEST_PROJECT_ID}" \
  "${REST_URL}/sync_variables?project_id=eq.${TEST_PROJECT_ID}"

# Test 5 row (created only before migration, when RLS was open)
curl -s -o /dev/null -w "  DELETE sync_variables (mismatch row): HTTP %{http_code}\n" -X DELETE \
  "${BASE_HEADERS[@]}" \
  -H "x-project-id: ${MISMATCH_PROJECT_ID}" \
  "${REST_URL}/sync_variables?project_id=eq.${MISMATCH_PROJECT_ID}"

# Test 6 row (created only before migration, when RLS was open)
curl -s -o /dev/null -w "  DELETE sync_variables (no-header row): HTTP %{http_code}\n" -X DELETE \
  "${BASE_HEADERS[@]}" \
  -H "x-project-id: ${TEST_PROJECT_ID}" \
  "${REST_URL}/sync_variables?project_id=eq.${TEST_PROJECT_ID}"

echo ""

if [[ "$FAIL_COUNT" -gt 0 ]]; then
  echo "SOME TESTS FAILED — expected before RLS migration."
  echo "Re-run after applying supabase/rls-migration.sql to verify ALL PASS."
  exit 1
fi

echo "All tests PASS — RLS is correctly enforcing project isolation."
exit 0
