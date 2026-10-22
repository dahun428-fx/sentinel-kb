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

## 결과 (2026-10-22)

- **장부**: `packages/core/src/db/embedding-generations.ts` — `embedding_generations`에 버전별 임베더 식별자
  (`readEmbeddingIdentity()`: `fake/dim=N` 또는 `voyage/<model>/dim=N/input-type`). contracts는 바꾸지 않았다(G3 불필요).
  worker(`worker.cli.ts`)와 core-api(`server.ts`)가 기동 시 대조한다. 다르거나, 장부 없이 그 버전의 청크가 있으면 거부(worker 78).
- **재임베딩**: `pnpm --filter @sentinel/worker reembed` — 워터마크가 낮은 published 레코드에 잡 투입, 대기 중인 레코드는 건너뜀.
- **C6**: 영구 실패는 attempts를 올리지 않는다. `worker.int.spec.ts`의 기존 단언(attempts 1)은 테스트 이름("attempts를
  태우지 않고")과 specs/03:20에 어긋나 있었다. 스펙을 기준으로 0으로 고쳤다 — 통과시키려고 낮춘 것이 아니다.
- **C8**: `Embedder.embed(texts, { inputType })`, Voyage에 `input_type` 전송. 검색은 query, 인제스트는 document.
- 테스트: 통합 7건(`generations.int.spec.ts`), 인제스트 용도 1건, 단위 6건(식별자 3, input_type 2, 검색 용도 1).
- **실동작 (로컬 스택)**: P3에서 fake로 만든 v1 청크가 있는 DB에 새 이미지로 기동 → worker `Restarting (78)`,
  core-api도 같은 메시지로 거부. `EMBEDDING_VERSION=2` + `reembed` → 장부 `[2, fake/dim=1024]`, v2 청크 2, 검색 정상.

## Findings
- **F-1** 로컬에서 core-api만 다시 만들면 nginx가 옛 IP로 접속해 502가 난다(upstream 블록이 기동 시 한 번 해석). → T-064.
- **F-2** C7(인덱스 drift가 차원만 비교)은 이번 범위에 넣지 않았다. T-064와 같이 설정 정합성 묶음으로 남긴다.

STATUS: GREEN
