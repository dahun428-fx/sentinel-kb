# T-020: 인용 후처리 검증 + generation eval
refs: specs/03-rag-pipeline.md §5, specs/05 (Eval 2)
M: M4 | deps: T-019

## Scope
- 응답 문장 분할 → 주장 문장의 `[REC-{id}#{section}]` 유효성 검증(컨텍스트에 실재하는 ID인지)
- 위반 시 1회 재생성, 재차 위반이면 무인용 문장 제거 + `groundingViolation: true` 로깅
- `eval/generation/`: 인용 룰체크(자동 100%) + LLM-as-judge(faithfulness/usefulness) + 임계값 시나리오
- `pnpm eval:generation`

## Out of scope
- 인젝션 레드팀(T-021)

## Acceptance
- [ ] 존재하지 않는 ID를 인용한 모의 응답이 위반으로 탐지됨
- [ ] 인용 룰체크 통과율 100% (골든셋 기준)
- [ ] judge 점수와 리포트가 baselines.json에 기록되고 하락 시 exit 1
- [ ] `pnpm verify` 그린

## Context budget
- 읽기: specs/03 §5, specs/05, eval/generation/**, packages/core/src/generator/**
