# T-005: 구조 인지 chunker
refs: specs/03-rag-pipeline.md §1
M: M1 | deps: T-002

## Scope
- `core/src/chunker/`: Record → `SectionChunk[]`
- 섹션별 독립 청크, 빈 섹션 스킵(에러 아님)
- 1200자 초과 시 문단 경계 분할, 각 조각에 `[title] (section)` prefix
- `seq` 부여, 결정론적 출력(같은 입력 → 같은 청크)

## Out of scope
- 임베딩 호출, DB 쓰기

## Acceptance
- [ ] 유닛 테스트 7케이스: 전 섹션 존재 / 일부 누락 / 초장문 분할 / 정확히 1200자 경계 / 빈 레코드 / divergence 타입 / 결정론성
- [ ] 분할 시 문장이 중간에서 잘리지 않음을 검증
- [ ] `pnpm verify` 그린

## Context budget
- 읽기: specs/03 §1, packages/core/src/chunker/**, packages/contracts/src/**
