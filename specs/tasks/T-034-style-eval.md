# T-034: 스타일 eval (AI-티 판정)
refs: specs/08-publishing.md §6
M: M7 | deps: T-031

## Scope
- eval/style/: 생성 아티클 + 사람 글 3편 혼합 → judge가 "AI 작성 추정" 블라인드 판별
- 지표: 판별 정확도(낮을수록 좋음), 린트 통과율, 팩트 대조 위반 수, 발행률
- pnpm eval:style, baselines에 상한 추가 (판별 정확도 <= 0.7에서 시작해 하향 목표)

## Acceptance
- [ ] 리포트에 글별 판별 결과와 근거가 기록됨
- [ ] 의도적으로 상투 표현을 넣은 대조군이 높은 판별 정확도로 걸러짐 (러너 자체 검증)
- [ ] `pnpm verify` 그린

## Context budget
- 읽기: specs/08 §6, eval/style/**
