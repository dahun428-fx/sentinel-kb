# T-053: 임베딩 세대 혼입 차단과 재임베딩 경로
refs: docs/plan/UPLIFT-PLAN.md §4-2 (C1 (Critical), C6 (Minor), C8 (개선))
M: M2 | deps: T-008

## 배경

2026-10-22 P1 AI 리뷰(UPLIFT §4-2) 지적. 근거 위치는 리뷰가 코드에서 확인했고, 주요 건은 재확인했다.

fake 임베더와 Voyage가 같은 `EMBEDDING_VERSION` 공간을 쓴다. 청크에는 어떤 provider·모델이 만든 벡터인지 남지 않는다
(`packages/core/src/embedder/index.ts:39-44`, `config.ts:66-70`). UPLIFT P3(fake)에서 만든 레코드가 P4(Voyage)로
넘어가도 v1 그대로 남고, 평범한 `pnpm db:seed`는 기존 제목을 건너뛰어(`scripts/seed.ts:310`) 잡을 만들지 않는다.
Voyage 질의 벡터와 fake 문서 벡터의 cosine은 0 근처라 그 레코드는 정상 응답 모양으로 `found:false`가 된다.
버전을 2로 올리면 재임베딩 도구가 없어(specs/03 §1-4) 두 검색 경로가 `embeddingVersion` 필터로 0건을 낸다.
- C6: 영구 실패에도 `attempts`가 오른다(`packages/worker/src/jobs.ts:117-127`, specs/03 §1-4 위반).
- C8: Voyage에 `input_type`(query/document)을 보내지 않는다(`voyage.ts:131`). 실데이터 적재 뒤에 바꾸면 전부 재임베딩이다.

## Scope
- 청크(또는 별도 장부)에 임베딩 provider·모델을 기록하고, 다른 provider의 청크가 있으면 worker·api가 부팅을 거부한다.
  contracts `.strict()` 개정이 필요하면 G3(인간 승인).
- `embeddingVersion < N`인 published 레코드 전부에 잡을 넣는 재임베딩 CLI.
- C6: 영구 실패는 `attempts`를 올리지 않는다.
- C8: `embedQuery`/`embedDocuments` 분리, Voyage `input_type` 전송. P5 적재 전에 넣는다.

## Acceptance
1. fake로 만든 청크가 있는 DB에서 provider=voyage로 기동하면 이름을 대고 실패한다.
2. 재임베딩 CLI가 버전 미달 레코드 수만큼 잡을 만들고, 끝나면 버전 일치율 100%.
3. `pnpm verify` 그린.

## Context budget
- 읽기: `packages/core/src/embedder/{index.ts,config.ts,voyage.ts}`, `packages/worker/src/{ingest.ts,jobs.ts}`, `scripts/seed.ts`, `specs/02-data-model.md`, `specs/03-rag-pipeline.md` §1

## 처리 메모
- **임시 조치(코드 수정 전):** UPLIFT P4 선행 조건에 'P3에서 쓴 로컬 DB 볼륨 삭제'와 'P4 직후 시드 레코드 제목으로 검색해 maxVectorScore가 0.3 이상인지 확인'을 넣었다.

STATUS: TODO
