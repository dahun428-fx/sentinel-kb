# T-000: 하네스 자체 검증 (더미 태스크)
refs: CLAUDE.md, .claude/skills/task-loop/SKILL.md
M: M0 | deps: -

## 목적
루프가 실제로 도는지 확인한다. 산출물의 가치보다 **프로토콜 준수 여부**가 검증 대상이다.

## Scope
- `packages/core/src/version.ts`에 `export const VERSION = "0.0.1"` 추가
- `packages/core/tests/version.spec.ts` 작성

## Out of scope
- 그 외 모든 것

## Acceptance
- [ ] `pnpm verify` 그린
- [ ] 에이전트가 PLAN을 3–7줄로 선언했고, Context budget 밖 파일을 읽지 않았다 (루프 로그로 확인)
- [ ] PR 본문에 태스크 ID와 변경 파일 목록이 있다

## Context budget
- 읽기: CLAUDE.md, packages/core/src/index.ts
