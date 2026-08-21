---
description: 태스크 스펙 하나를 루프로 완결한다. 사용법 /task T-005 또는 /task next
---

인자로 받은 태스크(`next`면 specs/tasks/README.md에서 deps 충족된 미완료 중 최상단)를 수행한다.

1. `.claude/skills/task-loop/SKILL.md`를 읽고 그대로 따른다
2. implementer 에이전트로 구현
3. verifier 에이전트로 검증
4. 실패 시 최대 3회 반복, 초과 시 BLOCKED 마킹 후 중단
5. spec-reviewer로 G5 확인
6. 통과 시 PR 생성 (제목 `T-xxx: 제목`, 본문에 Acceptance 근거·eval diff)
7. `eval/loop-log.jsonl`에 `{taskId, attempts, failedGate, turns, status}` 1줄 append
