#!/usr/bin/env bash
# 스펙-코드·문서 간 드리프트 검사. 감사위원 A 승인 조건: RTM↔TEST-PLAN ID 대조 포함.
set -uo pipefail
FAIL=0

echo "[1] RTM이 참조하는 TC가 TEST-PLAN에 실재하는가"
grep -oE '(UT|IT|ET)-[0-9]+[a-z]?' docs/analysis/RTM.md | sort -u > /tmp/_rtm.txt
grep -oE '(UT|IT|ET)-[0-9]+[a-z]?' docs/test/TEST-PLAN.md | sort -u > /tmp/_stp.txt
MISS=$(comm -23 /tmp/_rtm.txt /tmp/_stp.txt)
[ -n "$MISS" ] && { echo "  누락 TC: $MISS"; FAIL=1; }

echo "[2] RTM이 참조하는 태스크가 실재하는가"
for t in $(grep -oE 'T-[0-9]{3}' docs/analysis/RTM.md | sort -u); do
  ls specs/tasks/${t}-*.md >/dev/null 2>&1 || { echo "  누락 태스크: $t"; FAIL=1; }
done

echo "[3] MCP 도구 개수 = 5 (specs/07)"
N=$(grep -cE '^### [0-9]+\. ' specs/07-mcp.md)
[ "$N" -ne 5 ] && { echo "  도구 명세 ${N}개"; FAIL=1; }

exit $FAIL
