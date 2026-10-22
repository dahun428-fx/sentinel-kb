# T-058: give_feedback이 도그푸딩 리포트에 집계되지 않는다
refs: docs/plan/UPLIFT-PLAN.md §4-2 (A2 (Major))
M: M5 | deps: T-022,T-024

## 배경

2026-10-22 P1 AI 리뷰(UPLIFT §4-2) 지적. 근거 위치는 리뷰가 코드에서 확인했고, 주요 건은 재확인했다.

`give_feedback`은 Mongo `feedbacks`·`eval_cases`에 쓴다(`packages/mcp/src/tools/give-feedback.ts:61-73`, `packages/api/src/feedback.ts`).
리포트(`tools/dogfood-report.ts:4,31,61-73`)는 손으로 append하는 `eval/dogfood-log.jsonl`의 `"event":"hit"`만 센다. mcp·api 어디에도
그 파일을 쓰는 코드가 없다. 4주 동안 매일 `give_feedback(helped:true)`를 불러도 `hits.total = 0`이라 P8 판정(도움됨 5건)에 실패한다.
다른 저장소에서 일하는 에이전트는 이 저장소의 파일에 쓸 수도 없다.

## Scope
- 리포트가 hit·record를 DB에서 읽는다: `feedbacks`의 `helped:true`를 `createdAt` 주 단위로, `records.createdAt`.
  jsonl은 DB가 볼 수 없는 `search` 이벤트에만 남긴다(또는 search도 API 로그에서 센다).
- `feedbacks`에는 `updatedAt`이 없고 재전송은 최초 `createdAt`을 유지한다는 점을 집계 정의에 적는다.

## Acceptance
1. `give_feedback(helped:true)` 1회 후 리포트의 hit이 1이다(파일 수동 기록 없이).
2. P8 판정 기준(UPLIFT §2 P8)과 리포트 필드가 같은 정의를 쓴다.
3. `pnpm verify` 그린.

## Context budget
- 읽기: `tools/dogfood-report.ts`, `tools/dogfood-report.cli.ts`, `packages/api/src/feedback.ts`, `docs/dogfooding.md`, `specs/00-product.md`(성공 지표)

## 처리 메모
- **P7 선행 조건으로 묶는다.** P7 계측 스모크(UPLIFT §2 P7)가 이 결함을 잡는다.

STATUS: TODO
