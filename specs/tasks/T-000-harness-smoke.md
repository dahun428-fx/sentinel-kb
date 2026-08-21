# T-000: 하네스 자체 검증 (더미 태스크)
refs: CLAUDE.md, .claude/skills/task-loop/SKILL.md
M: M0 | deps: T-001

> Acceptance의 `pnpm verify`는 T-001이 만드는 파이프라인이다. 따라서 T-001을 먼저 수행한다.
> (2026-08-21 인간 승인으로 deps 수정)

## 목적
루프가 실제로 도는지 확인한다. 산출물의 가치보다 **프로토콜 준수 여부**가 검증 대상이다.

## Scope
- `packages/core/src/version.ts`에 `export const VERSION = "0.0.1"` 추가
- `packages/core/src/version.spec.ts` 작성

## Out of scope
- 그 외 모든 것

## Acceptance
- [ ] `pnpm verify` 그린
- [ ] 에이전트가 PLAN을 3–7줄로 선언했고, Context budget 밖 파일을 읽지 않았다 (루프 로그로 확인)
- [ ] PR 본문에 태스크 ID와 변경 파일 목록이 있다

## Context budget
- 읽기: CLAUDE.md, packages/core/src/index.ts

## Findings

- **F-1 Scope 경로를 `tests/`→`src/`로 정정했다. 인간 승인 대기(사후 비준 필요).**
  T-001이 확립한 vitest include는 `packages/*/src/**/*.spec.ts`이고 core tsconfig의
  `rootDir`/`include`는 `src`다. verifier가 격리 재현으로 실증한 결과, `tests/` 아래 스펙 파일은
  (a) vitest가 **수집조차 하지 않고** (b) `tsc -b` 타입체크도 받지 않는다.
  즉 스펙 문구를 문자 그대로 따랐다면 **테스트가 한 번도 실행되지 않은 채 `pnpm verify`가 그린이 되는**
  착시가 발생한다. 반드시 실패하는 단언을 `tests/`에 심어도 런은 exit 0이었다.
  T-000의 목적("루프가 실제로 도는지 확인")을 문자적 준수가 파괴하므로 스펙을 고쳤다.

- **F-2 Acceptance 2번은 현재 구조에서 기계 판정이 불가능하다. 결정 필요.**
  "루프 로그로 확인"이라 적었으나 `eval/loop-log.jsonl` 스키마
  (`{taskId, attempts, failedGate, turns, status, ts}`)는 **읽은 파일 목록도 PLAN 텍스트도 담지 않는다.**
  근거원이 근거를 담지 못하는 상태다. T-000뿐 아니라 **모든 후속 태스크에서 동일하게 판정 불가**다.
  선택지: (1) loop-log 스키마에 `planLines`/`filesRead` 추가 (2) 이 항목을 인간 리뷰 전용으로 강등.
  본 태스크에서는 (1) 방향으로 엔트리에 필드를 선반영했고, SKILL.md 개정은 별도 처리한다.

- **F-3 `dist/`에 `*.spec.js`가 실린다.** spec 파일이 `src/`에 colocate돼 `tsc -b` 산출물에 포함된다.
  T-001 시점부터의 상태이며 본 태스크가 만든 문제가 아니다. `tsconfig.build.json` 분리 또는
  `exclude` 추가를 별도 태스크로 검토.

- **F-4 커밋 전 스코프 확인에 `git diff HEAD --stat`만 쓰면 안 된다.** 신규 파일이 untracked라
  집계에서 빠진다(본 태스크에서 3파일 중 1파일만 보고됐다). `git status --short` 또는
  `git add -N` 병행이 필요하다.
