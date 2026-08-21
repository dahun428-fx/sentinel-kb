# T-016: tool-selection eval 러너 + 시나리오 20
refs: specs/05-test-strategy.md (Eval 3)
M: M3 | deps: T-015

## Scope
- `eval/tools/scenarios.json`: 20개 시나리오 `{prompt, expectedTool, requiredArgs[]}`
- 러너: 도구 목록만 제시하고 모델이 고른 도구·인자 채점, 각 3회 반복해 안정성 측정
- `pnpm eval:tools`, 리포트 `eval/reports/{date}-tools.json`
- baselines.json에 tool-selection 기준선 추가

## Out of scope
- description 최적화 자체 (별도 태스크로 분리)

## Acceptance
- [ ] 정확도 >= 0.85 (M3 기준선, 최종 목표 0.9)
- [ ] 오답 케이스가 리포트에 어떤 도구를 잘못 골랐는지 함께 기록됨
- [ ] 기준선 하락 시 exit 1
- [ ] `pnpm verify` 그린

## Context budget
- 읽기: specs/05 Eval3, specs/07, eval/tools/**
