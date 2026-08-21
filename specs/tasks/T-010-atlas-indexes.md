# T-010: Atlas 벡터·텍스트 인덱스 정의 스크립트
refs: specs/02-data-model.md (인덱스), specs/06
M: M2 | deps: T-003

## Scope
- `vec_idx` 정의 JSON (path embedding, cosine, dim from env, filter: meta.type/meta.project/embeddingVersion)
- `text_idx` 정의 JSON (lucene.standard on text)
- Atlas Admin API 또는 `createSearchIndex`로 적용하는 멱등 스크립트 `pnpm db:search-indexes`
- 인덱스 상태 대기(READY까지 폴링) 유틸

## Out of scope
- 검색 로직

## Acceptance
- [ ] 스크립트 2회 실행 시 에러 없이 동일 상태
- [ ] 인덱스 정의가 코드가 아닌 JSON 파일로 관리되고, dim이 env와 불일치하면 실패
- [ ] 통합 테스트: 인덱스 READY 후 간단 $vectorSearch 1건 성공
- [ ] `pnpm verify` 그린

## Context budget
- 읽기: specs/02, packages/core/src/db/**
