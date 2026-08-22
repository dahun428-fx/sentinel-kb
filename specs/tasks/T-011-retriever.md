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
> 판정 주체는 verifier다. 아래는 verifier가 컨테이너를 실기동해 독립 재현한 결과다(skip 0건).

- [x] RRF 유닛 테스트: 알려진 랭킹 2개 → 기대 융합 순서
      — 동일 입력에 `k=1 → [C,X,Y,A,D,E,B]`, `k=60 → [Y,C,X,A,D,E,B]`. **k에 따라 1위가 뒤집히는 쌍**이라
      `rrfK` 하드코딩이 자동으로 죽는다.
- [x] dedupe 테스트: 한 record의 4개 섹션이 상위일 때 2개만 남음 — 상한 1 대조군 포함.
- [x] 통합 테스트: 에러코드 키워드는 text 경로가, 서술형은 vector 경로가 기여
      — 한국어 서술형 질의는 `textCandidateCount === 0`인데도 결과가 나오고, 식별자 질의는
      `vectorRank === null, textRank === 1`인 청크를 벡터 2위 위로 올린다. **FakeEmbedder 미사용**(T-006 F-8).
- [x] 파라미터 하드코딩 없음(grep 테스트) — 소스를 fs로 읽고 대상 파일 목록까지 단언해 공허한 통과를 막는다.
      verifier가 비공허성 직접 확인: `config.rrfK → 60` 뮤테이션 시 실패한다.
- [x] `pnpm verify` 그린

## Context budget
- 읽기: specs/03 §2·§4, packages/core/src/retriever/**, .env.example,
  packages/contracts/src/{api,chunk,common}.ts, packages/core/src/db/search-indexes.int.spec.ts,
  packages/core/src/embedder/**

> **정정(인간 사후 비준 대상, R-5):** 원문 budget은 `specs/03 §2, retriever/**, .env.example`뿐이었다.
> 그런데 **같은 파일의 Findings가 그 밖을 지시한다** — F-3/F-10은 `db/search-indexes.int.spec.ts` 수정을,
> F-9는 `embedder`의 `readEmbeddingDim` 사용을, 감사 B-1은 `specs/03 §4`를 요구한다. 여기에
> CLAUDE.md "타입 재정의 금지"를 지키려면 `contracts/**` 확인이 불가피하다.
> **T-010에서 동일한 자기모순이 이미 한 번 올라갔다 — 재발이다.** 개별 태스크 정정으로 덮지 말고
> `.claude/skills/task-loop/SKILL.md` 규약을 손봐야 한다(아래 비준 R-5).

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
    **retriever가 반환하는 cosine 점수의 척도를 테스트로 단언하라.**
    그게 드리프트가 프로덕션에서 났을 때 유일하게 남는 방어선이다.
    > **이 문단의 "0–1 범위, 동일 벡터면 ≈1"은 착수 전 추정이었고 틀렸다** — 아래 F-1을 보라.
    > Atlas가 `(1+cos)/2`로 정규화하므로 원본은 직교에서 0.5다. 환산 후 실제 척도는
    > **−1..1**(동일 ≈1, 직교 ≈0, 정반대 ≈−1)이고, 그쪽이 드리프트 탐지력도 더 높다.

- **F-3/F-10: atlas-local은 mongod와 mongot 2프로세스이고 mongod가 먼저 뜬다.**
  `ping`이 통해도 검색은 `Error connecting to localhost:27027 ... Connection refused`로 죽는다.
  `search-indexes.int.spec.ts`에 2단계 부팅 게이트(컨테이너 healthcheck → 없는 인덱스 향한 `$search` 응답)가
  이미 있다. **T-011이 두 번째 사용처다 — 공용 테스트 헬퍼로 뽑아라.** 복붙하지 마라.
  (측정: 두 게이트 다 제거하면 4/4 실패, 1단계만 남기면 이 머신에서 6/6 통과. 1단계가 실제 일을 하고
   2단계는 느린 CI 러너용 보험이다.)

- **F-9: `EMBEDDING_DIM` 해석은 `readEmbeddingDim` 하나로 통일돼 있다.**
  인덱스 차원과 청크 벡터 차원이 갈리지 않도록 오형식 dim 6종에 대해 두 경로의 판정 일치를
  테스트가 잠근다. **retriever도 dim이 필요하면 `readEmbeddingDim`을 쓰고 새로 파싱하지 마라.**

## Findings (T-011 구현 중)

- **⚠️ F-1. Atlas `vectorSearchScore`는 원시 cosine이 아니라 `(1+cos)/2`다 — 이번 태스크 최대 발견.**
  구현자와 검증자가 각각 독립 실측했고, 검증자는 중간각까지 넣어 **7/7 일치**를 확인했다
  (동일 1.0 / 45° 0.8536 / 60° 0.75 / 직교 **0.5** / 120° 0.25 / 정반대 **0.0**).
  `specs/03:60`은 "**원시 cosine** 최고점(vectorSearchScore)"이라고 써서 **한 문장에서 두 척도를 등치**시킨다.
  그대로 두면 `SIMILARITY_THRESHOLD=0.62`가 원시 cosine **0.24** 게이트가 되어 의도보다 훨씬 헐거워진다.
  T-010의 통합 테스트가 이걸 못 잡은 이유도 확인됐다 — `score > 0.9` 단언은 동일 방향 벡터라
  **두 척도 모두에서 참**이었다.
  → **해소**: retriever가 `2s − 1`로 **원시 cosine으로 환산해서 반환**한다. 스펙을 바꾸는 대신
    코드를 스펙에 맞췄다. 근거: (a) 스펙 변경은 인간 승인 사항이고, (b) 0.62는 원시 cosine 전제로
    정해진 값으로 보이며(무관 문서 대개 0.3–0.6, 관련 0.7+), 정규화 척도로 재해석하면 누군가
    **근거 없는 새 숫자**를 골라야 한다. (c) 원시 cosine이면 "동일 ≈1, 직교 ≈0, 정반대 ≈−1"을
    단언할 수 있어 **T-010 F-7 인덱스 드리프트 탐지력이 올라간다**(euclidean으로 바뀌면 깨진다).
  **`maxVectorScore`는 이제 음수가 될 수 있다.** `null`(벡터 경로 0건)과 음수는 다른 것이다.

- **⚠️ F-2. `text_idx`에는 필터 필드가 없다 — 텍스트 경로 필터는 `$match`로 건다.**
  `text_idx.json`은 `dynamic:false`에 `text` 하나만 매핑한다(`specs/02:94`가 "path text"만 정했으므로
  정의 자체는 맞다). 따라서 `meta.type`·`meta.project`·`embeddingVersion`을 `$search`의
  `compound.filter.equals`로 **걸 수 없다.** `specs/03 §2`는 "filter 동일"이라고만 하고 방식을
  정하지 않았으므로 `$search → $match → $limit` 순서로 같은 결과를 낸다.
  **`$limit`이 `$match` 뒤여야** 필터로 잘린 만큼 재현율을 잃지 않는다 — 검증자 실측:
  ```
  $search → $match → $limit : 1건
  $search → $limit → $match : 0건   ← 필터 통과분이 $limit에 밀려 사라진다
  ```
  대가: `$search`에 자체 limit이 없어 **좁은 필터 × 흔한 토큰이면 mongot이 매칭 전체를 흘린다.**
  NFR-01 위험이며 T-012가 실측할 지점이다. 근본 해결은 `text_idx`에 filter 필드 추가(= `specs/02` 개정).

- **F-3. 검증자가 방어선의 공허함을 하나 잡았다 (수정함).** 위 `$limit` 순서 뮤테이션은 죽었지만
  **죽인 것은 스테이지 배열 모양 단언 하나뿐이었고 통합 테스트 13개는 전부 통과했다** —
  픽스처가 청크 13건, `$limit`이 16이라 두 순서가 **원리적으로 구별 불가**했기 때문이다.
  스테이지 배열을 리팩터링하는 순간 방어선이 사라지는 상태였다.
  → `$limit`이 실제로 바인딩되는 규모의 픽스처를 넣어 **결과 건수로** 잠갔다.

- **F-4. `RetrievedChunk`는 core 도메인 타입이지 contracts 재정의가 아니다** (G5 판정).
  `SearchHit`을 반환하지 않은 결정적 이유는 join 편의가 아니라 **T-018**이다 — `SearchHit`은
  `.strict()`이고 `summary`만 있어 **청크 본문이 없다.** 생성기가 답도 인용도 만들 수 없으므로,
  T-018이 같은 검색을 두 번 하거나 `SearchHit`을 넓혀 HTTP 응답에 본문을 실어 **NFR-03을 깨야** 한다.
  core는 도메인 타입을 돌려주고 **HTTP 투영은 경계(T-012)**가 한다. `ChunkSection`·`RecordType`·
  `SanitizeFlag`는 contracts에서 그대로 재사용하며 core에 다시 적은 열거형은 없다.
  드리프트 방어선: `SearchHit`이 `.strict()`라 T-012가 스프레드하면 검증에서 죽는다.

- **F-5. `maxVectorScore`는 결과당 1개이고 융합·상한·dedupe 이전 값이다** (감사 B-1 충족).
  검증자가 slice에 잘려나간 청크가 최고점을 갖는 상황을 실제로 만들어 확인했다:
  `hits`의 최고 vectorScore는 0.995인데 `maxVectorScore`는 **1**(잘려나간 청크의 값)이다.
  hit별로 두면 게이트가 스펙보다 엄격해져 조용히 `found:false`가 늘어난다.

- **F-6. `RetrievalDbLike`의 정당성이 문서화되지 않은 불변식에 걸려 있었다 (수정함).**
  `maxVectorScore`를 후보 상한 **전에** 계산하는 것이 옳은 이유는 "`$vectorSearch`가 점수
  내림차순을 보장한다"는 전제 때문인데, `RetrievalDbLike`는 구조적 타입이라 이를 강제하지 못한다.
  검증자가 비정렬 입력으로 값이 갈리는 것을 실측했다(뮤턴트 0.1 vs 원본 0.99).
  → `types.ts`에 불변식을 명시했다. 코드 동작은 그대로다.

- **F-7. `parseCandidate`가 일부 필드를 조용히 강등하고 있었다 (수정함).**
  `section`·`meta.type`은 시끄럽게 던지는데 `project`·`text`는 빈 문자열로 강등했다.
  `contracts/chunk.ts`는 둘 다 `.min(1)`을 요구한다. **빈 `text` 청크가 T-018 컨텍스트로 흘러가면
  인용은 만들어지는데 근거가 없는 상태**가 된다 — `CANDIDATE_INVALID`로 통일했다.

- **F-8. 컨테이너 부팅 헬퍼를 `packages/core/src/testing/atlas-local.ts`로 뽑았다** (T-010 F-3 지시 이행).
  T-011이 두 번째 사용처였다. 어느 배럴에도 export하지 않고 `*.spec.ts`가 아니라 vitest가 수집하지도
  않으며, `packages/core/package.json`의 `exports`가 `.`·`./db`만 노출해 패키지 밖에서 도달 불가하다.
  **T-010의 단언은 하나도 바뀌지 않았다** — 검증자가 `expect` 라인 수(23→23)와 `it` 블록 9개를
  기계 대조해 확인했다. 추출 과정에서 부팅 실패 시 컨테이너를 정리하는 try/catch가 붙어 오히려 강해졌다.

- **⚠️ F-9. atlas-local의 동점 벡터 점수는 순서 보장이 없다 — 내 테스트가 뮤테이션 3건을 가짜로 kill했다.**
  같은 cosine을 갖는 청크가 여럿이면 `$vectorSearch` 후보 순서가 실행마다 달라진다.
  "직교 벡터 점수" 테스트가 그런 동점 그룹의 특정 청크를 지목하고 있었고, 그 탓에 M10·M13·M14가
  **거짓으로 죽은 것처럼 보였다.** 지목을 걷어내고 직교 청크 전부 / 정반대 청크로 척도를 양 끝에서
  못박는 형태로 바꿨다. 검증자가 통합 스펙 2종을 **5회 반복**해 잔여 flaky 없음을 확인했다.
  **T-013 eval 픽스처가 같은 함정에 걸린다.**

- **F-10. 한쪽 경로가 *에러*를 던지면 전체가 던진다** (스코프 밖, 보고만).
  0건은 정상 경로로 처리하지만 예외는 전파한다. 인덱스 드리프트(T-010 F-7)는 반쪽 결과로 조용히
  퇴화하는 것보다 시끄럽게 죽는 편이 낫다고 판단했다. graceful degradation은 스펙 근거가 필요하다.

- **F-11. record `status`(draft/published) 필터가 없다** (스코프 밖, 보고만).
  `specs/03 §1`이 published일 때만 청크가 생긴다고 전제하므로 현재는 문제없다. 언퍼블리시 경로가
  생기면 청크 정리 주체가 필요하다. 고아 청크(record 삭제됨)는 인용할 수 없어 결과에서 빼는데,
  **조용히 빼므로 정합성 깨짐이 지표로 드러나지 않는다.** 백필/정리 도구가 생길 때 함께 볼 것.

## 인간 비준 대기 (G5 산출)

| # | 항목 | 결정 대상 |
|---|---|---|
| R-1 | `specs/03:60`이 "원시 cosine 최고점(**vectorSearchScore**)"으로 두 척도를 등치 | T-011은 **retriever가 환산**하는 쪽으로 해소했다. 스펙 문면에 "Atlas 원본은 `(1+cos)/2` 정규화 값이며 retriever가 원시 cosine으로 환산해 반환한다"를 명시할지 |
| R-2 | `specs/03 §2` 의사코드가 구현과 불일치 — 실제는 `limit = K × RETRIEVAL_CANDIDATE_OVERFETCH` → `capByRecordId` → K. `numCandidates=200`도 문면상 하드코딩 | §2에 후보 오버페치·후보 단계 상한 단계를 명시. T-005 F-3 해소 근거를 §2 본문으로 승격 |
| R-3 | `specs/03:38` `limit=RETRIEVAL_TEXT_K`가 "필터 전/후"를 정하지 않음 | **"필터 후 K개"로 확정 권고** — `$vectorSearch`의 filter는 pre-filter라 벡터 경로도 필연적으로 "필터 후 K개"다. 두 경로를 어긋나게 두는 편이 오히려 스펙 위반에 가깝다. 현 구현 그대로 비준 |
| R-4 | `text_idx`가 `dynamic:false`/`text` 단일 매핑이라 `$search` 필터 불가 → 좁은 필터에서 매칭 전체 스트리밍. **NFR-01 위험** | `specs/02:94`에 filter 필드를 추가할지. **T-012 레이턴시 실측 후 결정** |
| R-5 | **Context budget이 같은 파일의 Findings와 모순된다 — T-010에 이은 재발.** | 개별 태스크 정정이 아니라 `.claude/skills/task-loop/SKILL.md` 규약 수정 권고: "Findings가 지시하는 파일과 CLAUDE.md가 요구하는 계약 파일은 budget에 항상 포함"을 명문화하거나, 태스크 스펙 생성 시 Findings 인계와 budget을 함께 갱신하도록 강제. **구현자 귀책 아님** |
| R-6 | 인계 Findings 기록이 별도 `Chore` 커밋으로 분리되는 관행 | T-018처럼 Findings 절이 아예 없는 스펙이 남는다. 태스크 완료 정의(DoD)에 "다운스트림 Findings 기록"을 포함할지 |
| R-7 | **`maxVectorScore === null`일 때 게이트 동작을 `specs/03 §4`가 정하지 않았다** | **T-018 착수 전 필요.** 벡터 경로 0건인데 hits는 있는 상태가 실재한다(검증자 재현). `null < 0.62`는 false(생성 진행), `Number(null)=0`이면 true(`found:false`) |
| R-8 | `SIMILARITY_THRESHOLD=0.62` 자체에 실측 근거가 없다 | T-013이 스윕할 지점. 무관 질의가 전부 `found:false`가 되는 최소값과 Recall@5를 깎지 않는 최대값 사이 |
