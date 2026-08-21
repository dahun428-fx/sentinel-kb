# T-035: 관계 필드 + $graphLookup 확장 (경량 GraphRAG)
refs: docs/design/ADR-07-graph-db.md 단계 0, specs/02, specs/03 §2.5
M: M7 | deps: T-015, T-019

## Scope
- contracts: relations 스키마 (4개 타입), record_knowledge·CreateRecord 인자에 수용
- record_knowledge 응답에 "search 결과에서 관계 연결 권유" 문구 (도구 description 갱신 → G6 절차)
- retriever: $graphLookup 1홉 확장, RELATION_EXPANSION=on|off env 플래그, 인용에 관계 출처 표기
- 도그푸딩 지표에 관계 사용률 추가

## Out of scope
- 엔티티 정규화(단계 1), 전용 그래프 DB(단계 2)

## Acceptance
- [ ] recurrence_of 체인 fixture에서 1홉 확장 시 대상 resolution 청크가 컨텍스트에 포함됨
- [ ] 플래그 off 시 기존 동작과 완전 동일 (회귀 테스트)
- [ ] eval:retrieval·generation을 on/off 각각 실행한 비교 리포트 생성
- [ ] 순환 관계(A→B→A)에서 무한 순회 없음
- [ ] `pnpm verify` 그린

## Context budget
- 읽기: ADR-07, specs/02, specs/03 §2.5, packages/core/src/retriever/**
