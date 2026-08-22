#!/usr/bin/env bash
# ---------------------------------------------------------------------------
# 정책: 앱 호스트 SG 에 22(SSH) 인바운드 규칙이 존재하면 안 된다.
# 근거: specs/06-deployment.md 네트워크 행 — "SG 443만 인바운드. SSH 포트 미개방,
#       접속은 SSM Session Manager". T-025 Acceptance 2.
#
# 두 가지 모드가 있다.
#
#   (A) HCL 정적 스캔  (기본)  — AWS 자격증명이 필요 없다. 어디서든 판정된다.
#       ./infra/policy/no-ssh-ingress.sh [경로...]
#
#   (B) plan JSON 검사 (--plan) — 자격증명이 있는 CI 에서만 돈다. 변수·모듈·for_each
#       가 실제로 어떤 포트를 만드는지를 본다. (A) 가 놓치는 간접 표현을 잡는다.
#       terraform show -json tfplan > plan.json
#       ./infra/policy/no-ssh-ingress.sh --plan plan.json
#
#   (C) --self-test — 일부러 22 를 여는 fixture 로 스캐너가 실제로 잡는지 검증한다.
#       잡지 못하는 정책 테스트는 그린을 위조할 뿐이라 이걸 CI 에 상주시킨다.
#
# 탐지 대상: aws_vpc_security_group_ingress_rule / aws_security_group_rule(type=ingress)
#           / aws_security_group 안의 ingress·dynamic "ingress" 블록.
# 판정: 포트 범위가 22 를 포함하거나, 프로토콜이 -1/all 이거나(전 포트),
#       포트를 정적으로 읽을 수 없으면(fail-closed) 위반.
# ---------------------------------------------------------------------------
set -euo pipefail

SCRIPT_DIR="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)"
INFRA_DIR="$(dirname -- "$SCRIPT_DIR")"

usage() {
  echo "usage: $0 [--plan <plan.json>] [--self-test] [path...]" >&2
  exit 2
}

# --- (A) HCL 정적 스캔 -----------------------------------------------------
scan_hcl() {
  awk '
    function report(reason) {
      printf "%s:%d: [%s] %s\n", FILENAME, startline, ctx, reason
      violations++
    }

    function evaluate(   f, t) {
      if (ctx == "aws_security_group_rule" && rtype != "ingress") return

      if (proto == "-1" || proto == "all") {
        report("protocol \"" proto "\" 는 전 포트를 열어 22 를 포함한다")
        return
      }
      f = fp; t = tp
      if (f == "" && t == "") {
        report("from_port/to_port 를 정적으로 읽을 수 없다 (fail-closed: 22 개방 여부 미확인)")
        return
      }
      if (f == "") f = t
      if (t == "") t = f
      if (f + 0 <= 22 && 22 <= t + 0) {
        report("포트 범위 " f "-" t " 이 22(SSH) 를 포함한다")
      }
    }

    function grab_num(s,   v) {
      sub(/.*=[ \t]*/, "", s); return s
    }

    {
      line = $0
      sub(/[ \t]*#.*$/, "", line)
      sub(/[ \t]*\/\/.*$/, "", line)

      if (!in_block) {
        ctx = ""
        if (line ~ /resource[ \t]+"aws_vpc_security_group_ingress_rule"/)      ctx = "aws_vpc_security_group_ingress_rule"
        else if (line ~ /resource[ \t]+"aws_security_group_rule"/)             ctx = "aws_security_group_rule"
        else if (line ~ /dynamic[ \t]+"ingress"[ \t]*\{/)                      ctx = "dynamic ingress"
        else if (line ~ /^[ \t]*ingress[ \t]*=?[ \t]*\{/)                      ctx = "inline ingress"
        if (ctx == "") next
        in_block = 1; depth = 0; startline = FNR
        fp = ""; tp = ""; proto = ""; rtype = ""
      }

      if (match(line, /from_port[ \t]*=[ \t]*-?[0-9]+/))
        fp = grab_num(substr(line, RSTART, RLENGTH))
      if (match(line, /to_port[ \t]*=[ \t]*-?[0-9]+/))
        tp = grab_num(substr(line, RSTART, RLENGTH))
      if (match(line, /(ip_)?protocol[ \t]*=[ \t]*"[^"]*"/)) {
        s = substr(line, RSTART, RLENGTH); sub(/.*"([^"]*)".*/, "", s)
        s = substr(line, RSTART, RLENGTH); gsub(/.*=[ \t]*"|".*/, "", s); proto = s
      }
      if (match(line, /^[ \t]*type[ \t]*=[ \t]*"[^"]*"/)) {
        s = substr(line, RSTART, RLENGTH); gsub(/.*=[ \t]*"|".*/, "", s); rtype = s
      }

      depth += gsub(/\{/, "{", line) - gsub(/\}/, "}", line)
      if (depth <= 0) { evaluate(); in_block = 0 }
    }

    END { exit (violations > 0 ? 1 : 0) }
  ' "$@"
}

# --- (B) plan JSON 검사 ----------------------------------------------------
scan_plan() {
  local plan="$1"
  command -v jq >/dev/null 2>&1 || { echo "jq 가 필요하다 (--plan 모드)" >&2; exit 2; }

  local out
  out="$(jq -r '
    def rules:
      (.resource_changes // [])[]
      | select(.change.after != null)
      | . as $rc | $rc.change.after as $a
      | if   $rc.type == "aws_vpc_security_group_ingress_rule" then
               [{addr: $rc.address, from: $a.from_port, to: $a.to_port, proto: $a.ip_protocol}]
        elif $rc.type == "aws_security_group_rule" and $a.type == "ingress" then
               [{addr: $rc.address, from: $a.from_port, to: $a.to_port, proto: $a.protocol}]
        elif $rc.type == "aws_security_group" then
               [ ($a.ingress // [])[]
                 | {addr: $rc.address, from: .from_port, to: .to_port, proto: .protocol} ]
        else [] end
      | .[];

    rules
    | select(
        (.proto == "-1" or .proto == "all")
        or (.from == null and .to == null)
        or ((((.from // .to) | tonumber) <= 22) and (((.to // .from) | tonumber) >= 22))
      )
    | "\(.addr): proto=\(.proto) ports=\(.from)-\(.to) 가 22(SSH) 를 포함한다"
  ' "$plan")"

  if [[ -n "$out" ]]; then
    echo "$out"
    return 1
  fi
  return 0
}

# --- (C) self-test ---------------------------------------------------------
self_test() {
  local fixtures="$SCRIPT_DIR/fixtures"
  local rc=0 f base

  echo "== self-test: 일부러 22 를 여는 fixture 를 스캐너가 잡는지 =="
  for f in "$fixtures"/bad-*.tf.fixture; do
    base="$(basename "$f")"
    if scan_hcl "$f" >/dev/null 2>&1; then
      echo "  FAIL  $base — 위반인데 스캐너가 통과시켰다"
      rc=1
    else
      echo "  ok    $base — 잡았다: $(scan_hcl "$f" 2>/dev/null | head -1 | sed 's|.*: \[|[|')"
    fi
  done
  for f in "$fixtures"/good-*.tf.fixture; do
    base="$(basename "$f")"
    if scan_hcl "$f" >/dev/null 2>&1; then
      echo "  ok    $base — 통과"
    else
      echo "  FAIL  $base — 정상 설정인데 스캐너가 막았다 (거짓 양성)"
      scan_hcl "$f" || true
      rc=1
    fi
  done
  return $rc
}

# --- main ------------------------------------------------------------------
PLAN=""
DO_SELF_TEST=0
PATHS=()

while [[ $# -gt 0 ]]; do
  case "$1" in
    --plan)      PLAN="${2:-}"; [[ -n "$PLAN" ]] || usage; shift 2 ;;
    --self-test) DO_SELF_TEST=1; shift ;;
    -h|--help)   usage ;;
    -*)          usage ;;
    *)           PATHS+=("$1"); shift ;;
  esac
done

status=0

if [[ $DO_SELF_TEST -eq 1 ]]; then
  self_test || status=1
  echo
fi

if [[ -n "$PLAN" ]]; then
  echo "== plan JSON 검사: $PLAN =="
  if scan_plan "$PLAN"; then
    echo "  ok — plan 에 22 인바운드 없음"
  else
    status=1
  fi
else
  if [[ ${#PATHS[@]} -eq 0 ]]; then
    # fixtures 는 의도적 위반이라 기본 스캔에서 뺀다 (self-test 전용).
    while IFS= read -r line; do PATHS+=("$line"); done < <(
      find "$INFRA_DIR" -name '*.tf' -not -path '*/.terraform/*' -not -path "$SCRIPT_DIR/fixtures/*" | sort
    )
  fi
  echo "== HCL 정적 스캔: ${#PATHS[@]} 파일 =="
  if scan_hcl "${PATHS[@]}"; then
    echo "  ok — 22(SSH) 인바운드 규칙 없음"
  else
    echo "  FAIL — 위 규칙들이 22 를 연다. specs/06 은 SSH 미개방 + SSM Session Manager 다." >&2
    status=1
  fi
fi

exit $status
