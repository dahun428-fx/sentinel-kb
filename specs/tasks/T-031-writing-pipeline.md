# T-031: 작문 파이프라인 + 문체 린터
refs: specs/08-publishing.md §4
M: M7 | deps: T-030

## Scope
- core/src/publisher/: 아웃라인 → 초안(facts + 스타일 few-shot 주입) → 린트 → 재작성 루프(최대 2회) → 팩트 대조
- 문체 린터: 금지 표현·구조 패턴·밀도 하한·어미 다양성·메타 서두 — 전부 규칙 기반, LLM 아님
- 유형별 템플릿 3종 로테이션
- 팩트 대조: 본문 수치가 facts에 실재하는지 검증, 위반 시 반려
- 스타일 few-shot은 prompts/style/ 디렉토리에서 로드 (사람이 자기 글을 넣는다)

## Out of scope
- 다이어그램 (T-032), UI (T-033)

## Acceptance
- [ ] 린터 유닛 테스트 15케이스 (금지 표현·대칭 구조·밀도 미달·어미 반복·메타 서두 각각 탐지 + 정상 통과 5)
- [ ] facts에 없는 수치를 심은 모의 초안이 반려됨
- [ ] draft 저장 시 lintReport가 함께 기록됨
- [ ] `pnpm verify` 그린

## Context budget
- 읽기: specs/08 §4, packages/core/src/publisher/**, prompts/style/**
