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

## Findings (T-005·T-006·T-009에서 미리 넘김)

- **⚠️ T-005 F-3: 레코드 1건이 청크 28개까지 간다 — 재현율 붕괴 경로.**
  specs/03 §2의 `dedupeByRecordId`(record당 최대 2청크)는 **융합 후**에 걸린다.
  그런데 `$vectorSearch(limit=RETRIEVAL_VECTOR_K=20)`·`$search(limit=20)` 후보 리스트는
  **dedupe 이전**이다. 28청크짜리 레코드 하나가 20슬롯을 통째로 점유하면
  **dedupe 후 최종 결과에 레코드가 사실상 1건만 남는다.**
  chunker에 청크 수 상한을 두는 건 답이 아니다 — 스펙 근거가 없고 지식을 조용히 버린다.
  **이 태스크가 해소할 위치다.** 후보 K를 dedupe 손실분만큼 키우거나,
  후보 단계에서 섹션 다양성을 확보하거나(`$group` by recordId), 둘 다.
  **어느 쪽이든 통합 테스트로 증명하라** — 장문 레코드 1건 + 짧은 레코드 여러 건을 넣고
  장문이 슬롯을 독점하지 않는지 본다.
- **T-006 F-8: `FakeEmbedder`로는 벡터 경로가 의미를 갖지 않는다.**
  해시 기반이라 서로 다른 텍스트 간 cosine ≈ 0이다(실측 mean −0.00007, sd 0.031).
  Acceptance 3("서술형 쿼리는 vector 경로가 기여")을 fake로 검증하면 **공허한 그린**이 난다.
  → 통합 테스트에서 벡터 경로를 검증할 때는 **벡터를 직접 심어라**
    (쿼리 벡터와 가까운 값을 특정 청크에 넣고 그게 올라오는지 확인).
    임베딩 provider에 의존하지 않고 `$vectorSearch` 동작 자체를 검증하는 방법이다.
- **T-006 F-4 / T-010: `vec_idx`의 filter 필드는 `meta.type`·`meta.project`·`embeddingVersion` 셋이다.**
  `specs/02:93`이 그 **목록**을 정한다. 실패 양상("빠뜨리면 필터가 무시되는 게 아니라 쿼리가 실패한다")의
  출처는 `.claude/skills/mongo-vector-ops/SKILL.md:19`다 — 인용 출처를 헷갈리지 마라.
  T-010이 실측으로 잠갔다: 선언되지 않은 `meta.severity`로 필터하면
  `Path 'meta.severity' needs to be indexed as filter`로 **쿼리 자체가 죽는다.**
  `ChunkMeta`에는 `severity`·`tags`도 있지만 **필터로 쓸 수 없다.**
- **`mongodb-atlas-local` 컨테이너로 로컬 검증이 가능하다**(specs/05 정정).
  `mongodb-memory-server`는 `$vectorSearch`를 지원하지 않는다.
- **감사 B-1(specs/03 §4): 융합 전 cosine 최고점을 반환값에 포함해야 한다.**
  RRF 융합 점수는 `Σ 1/(k+rank)` 척도라 k=60이면 최대 약 0.033이고,
  `SIMILARITY_THRESHOLD=0.62`(cosine 기준)와 **비교할 수 없다.**
  RRF는 순위 결정에만 쓰고 게이트 판정은 융합 전 cosine으로 한다. T-018이 이 값을 쓴다.
  **이걸 빠뜨리면 T-018이 모든 질의에 `found:false`를 낸다** — 시드 SELF-01이 그 사건이다.

## Findings (T-010에서 넘김 — 착수 전에 읽을 것)

- **⚠️ F-6: `lucene.standard`는 한국어 형태소 분석을 하지 않는다.** "스트리밍이"가 한 토큰이라
  질의 "스트리밍"으로 매칭되지 않는다. 영문·식별자(`nginx`, `proxy_buffering`, 스택트레이스)는 잘 걸린다.
  **결정(인간 비준 대기, T-011은 이 전제로 진행한다):** `specs/02`의 `lucene.standard`를 **그대로 둔다.**
  근거 — (a) 하이브리드 검색이라 한국어 서술형 질의의 의미 매칭은 **벡터 경로가 담당**하고,
  텍스트 경로의 본래 역할은 에러코드·식별자·스택트레이스처럼 임베딩이 약한 리터럴이다.
  (b) 분석기 교체는 `specs/02` 수정(인간 승인)이 선행이고, 근거 없이 바꾸면 되돌릴 지표가 없다.
  (c) **T-013 retrieval eval이 한국어 recall 손실을 실제로 측정하는 첫 지점**이므로,
  거기서 나온 수치를 근거로 `lucene.cjk`/nori 전환을 결정하는 편이 옳다.
  → **T-011은 텍스트 경로가 한국어 서술형에 약하다는 것을 전제로 설계하라.**
    RRF가 두 경로를 융합하므로 한쪽이 0건이어도 결과가 나와야 한다 — 그 경우를 테스트로 잠글 것.

- **⚠️ F-7: 인덱스 정의 드리프트가 조용히 통과한다.** `pnpm db:search-indexes`는 **dim만** 대조한다.
  이미 있는 인덱스의 `similarity`가 `euclidean`이거나 filter 목록이 모자라도 `existing` / `READY` / **exit 0**을
  보고한다. 그 직후 실제 쿼리는 `Path 'meta.project' needs to be indexed as filter`로 죽고,
  `similarity`가 euclidean이면 **점수가 0–1 cosine 척도가 아니게 되어 `SIMILARITY_THRESHOLD` 게이트가
  조용히 오작동한다**(감사 B-1이 요구하는 그 값이다).
  → 통합 테스트는 인덱스를 **깨끗한 상태에서 만들어** 이 문제를 우회하지만,
    **retriever가 반환하는 cosine 점수의 척도를 테스트로 단언하라**(0–1 범위, 동일 벡터면 ≈1).
    그게 드리프트가 프로덕션에서 났을 때 유일하게 남는 방어선이다.

- **F-3/F-10: atlas-local은 mongod와 mongot 2프로세스이고 mongod가 먼저 뜬다.**
  `ping`이 통해도 검색은 `Error connecting to localhost:27027 ... Connection refused`로 죽는다.
  `search-indexes.int.spec.ts`에 2단계 부팅 게이트(컨테이너 healthcheck → 없는 인덱스 향한 `$search` 응답)가
  이미 있다. **T-011이 두 번째 사용처다 — 공용 테스트 헬퍼로 뽑아라.** 복붙하지 마라.
  (측정: 두 게이트 다 제거하면 4/4 실패, 1단계만 남기면 이 머신에서 6/6 통과. 1단계가 실제 일을 하고
   2단계는 느린 CI 러너용 보험이다.)

- **F-9: `EMBEDDING_DIM` 해석은 `readEmbeddingDim` 하나로 통일돼 있다.**
  인덱스 차원과 청크 벡터 차원이 갈리지 않도록 오형식 dim 6종에 대해 두 경로의 판정 일치를
  테스트가 잠근다. **retriever도 dim이 필요하면 `readEmbeddingDim`을 쓰고 새로 파싱하지 마라.**
