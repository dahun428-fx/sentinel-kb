# T-013: retrieval eval 러너 + 골든셋 30
refs: specs/05-test-strategy.md (Eval 1)
M: M2 | deps: T-012, T-009

## Scope
- `eval/retrieval/`: 골든셋 로더(eval_cases) → /v1/search 호출 → Recall@5, MRR 계산
- 리포트 `eval/reports/{date}-retrieval.json` + 콘솔 요약
- `pnpm eval:retrieval`, 기준선 파일 `eval/baselines.json`과 비교해 하락 시 exit 1
- 골든셋 30건 작성 (시드에서 파생, 각 케이스 `approvedBy: "human"`)

## Out of scope
- generation eval

## Acceptance
- [ ] Recall@5 >= 0.8 (M2 기준선)
- [ ] 기준선보다 낮으면 exit 1 하는 회귀 가드 동작 테스트
- [ ] 리포트 JSON이 specs/05의 스키마와 일치
- [ ] `pnpm verify` 그린

## Context budget
- 읽기: specs/05, eval/**, packages/api/**
