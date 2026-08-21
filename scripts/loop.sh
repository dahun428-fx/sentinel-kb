#!/usr/bin/env bash
# sentinel-kb 자동 구현 루프
# 한 태스크 = 한 세션(컨텍스트 리셋) = 한 PR. 드리프트 방지의 핵심은 이 리셋이다.
set -uo pipefail

MAX_TASKS="${MAX_TASKS:-5}"
MAX_TURNS="${MAX_TURNS:-40}"
LOG="eval/loop-log.jsonl"
mkdir -p "$(dirname "$LOG")"

task_done() { grep -q "\"taskId\":\"$1\".*\"status\":\"done\"" "$LOG" 2>/dev/null; }

deps_met() {
  # 태스크 파일의 "deps: T-xxx, T-yyy" 라인을 파싱해 전부 done인지 확인 (감사 A-3)
  local deps
  deps=$(grep -oE 'deps: [^|]*' "$1" | head -1 | grep -oE 'T-[0-9]+' || true)
  [ -z "$deps" ] && return 0
  for d in $deps; do task_done "$d" || return 1; done
  return 0
}

next_task() {
  # STATUS 미기재 + 미완료 + deps 충족 태스크 중 최상단 하나
  for f in $(ls specs/tasks/T-*.md | sort); do
    local id; id=$(basename "$f" .md | cut -d- -f1-2)
    grep -q '^STATUS:' "$f" && continue
    task_done "$id" && continue
    deps_met "$f" && { echo "$f"; return; }
  done
}

for i in $(seq 1 "$MAX_TASKS"); do
  TASK_FILE="$(next_task)"
  [ -z "$TASK_FILE" ] && { echo "[loop] 남은 태스크 없음"; break; }
  TASK_ID="$(basename "$TASK_FILE" .md | cut -d- -f1-2)"

  echo "=== [$i/$MAX_TASKS] $TASK_ID 시작 ($(date -Is)) ==="
  START=$(date +%s)

  claude -p "/task $TASK_ID" --max-turns "$MAX_TURNS" 2>&1 | tee "eval/logs/$TASK_ID.log"
  RC=${PIPESTATUS[0]}
  ELAPSED=$(( $(date +%s) - START ))

  if grep -q '^STATUS: BLOCKED' "$TASK_FILE"; then
    echo "{\"taskId\":\"$TASK_ID\",\"status\":\"blocked\",\"elapsed\":$ELAPSED,\"ts\":\"$(date -Is)\"}" >> "$LOG"
    echo "!!! $TASK_ID BLOCKED — 사람 판단 필요. 루프 중단."
    break
  fi

  if [ "$RC" -ne 0 ]; then
    echo "{\"taskId\":\"$TASK_ID\",\"status\":\"error\",\"rc\":$RC,\"elapsed\":$ELAPSED,\"ts\":\"$(date -Is)\"}" >> "$LOG"
    echo "!!! $TASK_ID 비정상 종료(rc=$RC). 루프 중단."
    break
  fi

  echo "{\"taskId\":\"$TASK_ID\",\"status\":\"done\",\"elapsed\":$ELAPSED,\"ts\":\"$(date -Is)\"}" >> "$LOG"
  echo "=== $TASK_ID 완료 (${ELAPSED}s) ==="
done

echo "[loop] 종료. 로그: $LOG"
