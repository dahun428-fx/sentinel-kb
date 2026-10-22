# T-056: Recall@5 측정 창 정정
refs: docs/plan/UPLIFT-PLAN.md §4-2 (C5 (Major))
M: M2 | deps: T-013

## 배경

2026-10-22 P1 AI 리뷰(UPLIFT §4-2) 지적. 근거 위치는 리뷰가 코드에서 확인했고, 주요 건은 재확인했다.

eval은 `/v1/search`에 청크 5개를 요청한 뒤 레코드로 접는다(`eval/retrieval/args.ts:8`, `run.ts:65,68`, `metrics.ts:9-13,58-63`).
`maxChunksPerRecord=2`(`retriever/config.ts:25`)라 "상위 5개 레코드"가 3개뿐일 수 있다. 보고하는 Recall@5는 실제로는
Recall@3~5다. 실데이터가 3~7건뿐이면 상위 5개가 코퍼스 거의 전부라 그 부분집합의 Recall@5는 거의 자명하게 1.0이다.

## Scope
- 요청 limit을 `k × maxChunksPerRecord`(예: 10)로 하고 레코드 5개에서 자른다.
- 실데이터 부분집합과 시드 50건을 나눠 보고한다.
- 기준을 낮추는 변경이 아니라 측정 창을 지표 정의와 맞추는 변경이다(CLAUDE.md 원칙 4와 구별). 사용자 위임(2026-10-22)으로 진행했고 결과 절에 근거를 남긴다.

## Acceptance
1. 한 레코드가 청크 2개를 차지하는 픽스처에서 리포트의 top-5가 레코드 5개다.
2. 리포트에 부분집합별 Recall@5가 나뉘어 있다.
3. `pnpm verify` 그린.

## Context budget
- 읽기: `eval/retrieval/{args.ts,run.ts,metrics.ts,run.spec.ts}`, `packages/core/src/retriever/config.ts`, `specs/05-test-strategy.md` Eval 1

## 처리 메모
- P6 전에 처리한다. 처리 전 측정값은 'Recall@3~5'로 읽는다.

## 결과 (2026-10-22)

- 기본 `--limit`을 청크 5 → 10(`RECALL_K × maxChunksPerRecord`). `metrics.ts`가 이미 "랭킹 단위는 record, top-5 record"로
  정의해 두었으므로 **정의를 바꾼 것이 아니라 측정을 정의에 맞춘 것**이다. 기준 수치(0.80/0.85)는 그대로다.
  `args.spec.ts`의 리터럴 5는 이 요구사항 변경에 따라 10으로 고쳤다.
- 청크 창이 꽉 찼는데 record가 5개 미만으로 접히면 리포트에 경고. 테스트 1건(limit 5 경고, 10 무경고).
- **남은 것 (Findings F-1)**: 실데이터 부분집합 분리 보고와 방해 레코드는 골든셋 케이스에 데이터 출처 표시가 있어야 한다.
  골든셋을 작성하는 P6에서 `note`에 출처를 적고 분리 집계한다.

STATUS: GREEN
