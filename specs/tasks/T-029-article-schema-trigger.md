# T-029: 아티클 스키마 + 트리거 판정 배치
refs: specs/08-publishing.md §1–2
M: M7 | deps: T-022, T-024

## Scope
- contracts: ArticleSchema, ChartSpecSchema
- worker에 야간 트리거 배치: 4개 유형 조건 판정 → candidate 적재 (중복 방지: 동일 소스 집합 해시)
- 후보 목록 조회 API GET /v1/articles?status=candidate

## Out of scope
- 본문 생성 (T-031)

## Acceptance
- [ ] 시드 데이터에서 패턴(>=3건 클러스터) 후보가 최소 1건 생성됨
- [ ] 같은 소스 집합으로 재실행 시 후보 중복 생성 안 됨
- [ ] 유형별 트리거 조건 유닛 테스트 8케이스
- [ ] `pnpm verify` 그린

## Context budget
- 읽기: specs/08 §1–2, packages/contracts/**, packages/worker/**
