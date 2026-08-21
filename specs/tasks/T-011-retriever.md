# T-011: retriever — 하이브리드 + RRF
refs: specs/03-rag-pipeline.md §2
M: M2 | deps: T-010

## Scope
- `core/src/retriever/`: 쿼리 임베딩 → $vectorSearch(K1) + $search(K2) → RRF 융합 → dedupeByRecordId(record당 최대 2) → Top-N
- 필터: type, project, embeddingVersion
- `injection-suspect` 청크는 결과에 남기되 `flags`로 표시
- 모든 파라미터 env 주입, 하드코딩 금지
- 융합 결과와 별도로 **융합 전 cosine 최고점**을 반환값에 포함한다 (임계값 게이트용, 감사 B-1)

## Out of scope
- HTTP 라우트, rerank(P1)

## Acceptance
- [ ] RRF 유닛 테스트: 알려진 랭킹 2개 → 기대 융합 순서
- [ ] dedupe 테스트: 한 record의 4개 섹션이 상위일 때 2개만 남음
- [ ] 통합 테스트: 시드에서 에러코드 키워드 쿼리는 text 경로가, 서술형 쿼리는 vector 경로가 기여함을 확인
- [ ] 파라미터 하드코딩 없음(grep 테스트)
- [ ] `pnpm verify` 그린

## Context budget
- 읽기: specs/03 §2, packages/core/src/retriever/**, .env.example
