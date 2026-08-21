# T-004: sanitizer (시크릿 마스킹 + 인젝션 플래그)
refs: specs/00-product.md FR-06, specs/03-rag-pipeline.md §4, specs/05 Eval4
M: M1 | deps: T-002

## Scope
- `core/src/sanitizer/`: 입력 텍스트 → `{text, flags[]}`
- 마스킹: AWS 액세스키/시크릿, Bearer 토큰, `sk-`류 API 키, mongodb+srv URI의 자격증명, 이메일(옵션), 사설 IP는 유지
- 인젝션 의심 패턴 플래그: "ignore previous/above instructions", "system prompt", "you are now", 역할 전환 지시, 과도한 제로폭 문자
- 플래그는 마스킹하지 않고 **표시만** 한다 (지식 자체는 보존)

## Out of scope
- 저장·API 연결 (T-007)

## Acceptance
- [ ] 마스킹 케이스 12개 유닛 테스트 통과 (각 시크릿 유형 + 오탐 방지 케이스 3개)
- [ ] 인젝션 패턴 8개 탐지 + 정상 문장 5개 미탐지
- [ ] 마스킹 결과에 원문 시크릿이 남지 않음을 검증하는 프로퍼티 테스트
- [ ] `pnpm verify` 그린

## Context budget
- 읽기: specs/00 FR-06, specs/03, packages/core/src/sanitizer/**
