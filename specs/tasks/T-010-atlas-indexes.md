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

## Findings (T-006에서 미리 넘김)

- **`readEmbedderConfig`를 재사용하려면 마찰이 있다.** Acceptance 2("dim이 env와 불일치하면 실패")를
  위해 `EMBEDDING_DIM` 하나만 필요한데, 이 함수는 `EMBEDDING_PROVIDER`·`EMBEDDING_VERSION`까지
  유효해야 통과한다. **인덱스 스크립트가 임베딩 자격증명 없이 도는 환경이면 걸린다.**
  dim만 읽는 경로를 따로 두거나 config를 쪼갤 것.
- **`vec_idx`의 dim과 `EMBEDDING_DIM` 불일치는 지금 런타임에만 잡힌다**(T-006 F-4).
  embedder는 응답 차원이 env와 다르면 던지지만 인덱스 정의와의 일치는 검증하지 못한다.
  이 태스크가 그 대조를 맡는 유일한 지점이다.
