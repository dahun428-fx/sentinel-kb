# T-012: /v1/search 라우트
refs: specs/04-api.md
M: M2 | deps: T-011

## Scope
- POST `/v1/search` — contracts 스키마 검증, retriever 호출, `summary` 포함 응답
- 응답에 본문 미포함(NFR-03 기반), flags 노출
- 레이턴시 로깅(pino) — p95 측정 가능한 필드

## Out of scope
- 생성(answer)

## Acceptance
- [ ] 통합 테스트: 시드 기준 알려진 쿼리 3개가 기대 record를 Top-5에 포함
- [ ] 잘못된 limit(>20) → 400
- [ ] 응답 어디에도 record 본문 전체가 없음을 검증
- [ ] `pnpm verify` 그린

## Context budget
- 읽기: specs/04, packages/api/**, packages/core/src/retriever/**

## Findings (T-002·T-004·T-007·T-011에서 미리 넘김)

- **응답 형상은 contracts의 `SearchResponse`·`SearchHit`가 단일 소스다.**
  `SearchHit`은 `{recordId, title, summary, section, score, type, project, flags}`이고
  **`section`은 `ChunkSection` enum, `flags`는 `SanitizeFlag` enum으로 좁혀져 있다**(T-002 F-6).
  core/api가 임의 문자열을 넣으려 하면 여기서 걸린다.
- **`summary`는 레코드에서 온다**(서버 생성 필드, T-007이 첫 2문장으로 만든다).
  청크에서 뽑지 마라 — 청크 텍스트는 `"[{title}] ({section}) {body}"` prefix가 붙어 있다.
- **⚠️ T-007 R-5: `summary` 길이가 NFR-03을 초과할 소지가 있다.**
  현 구현 상한 400자는 스펙 근거가 없고, `limit=5` 기준 한국어 400자 ≈ 1250–2000 토큰으로
  **NFR-03(≈800 토큰)을 2배 초과한다.** 이 태스크가 그 예산을 처음 실제로 쓰는 지점이다.
  **응답 토큰을 실측해 R-5 결정에 근거를 대라.**
- **T-007 R-2: 길이 상한 초과는 413 `SANITIZE_INPUT_TOO_LARGE`다.** openapi에 미등록.
  검색 쿼리도 새니타이즈한다면 같은 경로를 탄다 — 할지 말지 결정하고 근거를 남겨라.
- **미배정 갭(T-007 R-7): `/v1/openapi.json` 서빙이 어느 태스크에도 없다.**
  `openapi.ts`에는 8개 오퍼레이션이 이미 등록돼 있는데 라우트가 없어
  **문서와 구현이 어긋난 창이 열려 있다.** 이 태스크에서 함께 닫을지 판단하라.
- **T-011 감사 B-1: retriever가 융합 전 cosine 최고점을 반환한다.**
  이 라우트는 그 값을 응답에 싣지 않는다(SearchHit에 자리가 없다) — T-018/T-019가 쓴다.
  다만 **레이턴시 로깅(Scope)에 함께 남기면 임계값 튜닝의 근거가 된다.**
- **`mongodb-atlas-local` 컨테이너로 통합 테스트가 가능하다**(specs/05 정정).

## Findings (T-011에서 넘김)

- **`retrieve()`는 core 도메인 타입 `RetrievedChunk`를 돌려준다 — `SearchHit`이 아니다.**
  투영은 **이 태스크의 몫**이다. 매핑:
  `{recordId, title, summary, section, score: fusedScore, type, project, flags}`.
  **`text`(청크 본문)를 응답에 실으면 NFR-03 즉시 위반이다.** `SearchHit`이 `.strict()`라
  스프레드하면 검증에서 죽는다 — 그게 방어선이니 우회하지 마라.
  **Acceptance에 `SearchHit.parse()` 왕복을 넣어라**(G5 권고). 그러면 손으로 대조할 필요가 없다.

- **⚠️ `SearchHit.score`에 무엇을 넣을지 스펙이 정하지 않았다.**
  `RetrievedChunk`는 점수를 셋으로 쪼갠다 — `fusedScore`(RRF, **순위 결정 전용**),
  `vectorScore`(원시 cosine, −1..1), `textScore`(BM25, 무제한).
  `packages/contracts/src/api.ts`의 `SearchHit.score`는 `z.number()`뿐이라 척도 정의가 없다.
  임의로 고르면 클라이언트에 **RRF 척도(k=60에서 최대 ≈0.033)**가 노출되거나 cosine이 노출되거나 갈린다.
  **무엇을 싣든 그 척도를 openapi 설명에 명시하라.** MCP 도구(T-015)가 이 값을 그대로 보여준다.

- **`retriever`는 `request.limit`을 클램프하지 않는다.** `SearchRequest.limit`(1–20)이 이미
  계약으로 상한을 강제하므로 그대로 넘기면 된다. 다만 `RETRIEVAL_FINAL_K=8`이 기본값이고
  `SearchRequest.limit`의 기본은 **5**다 — 둘 중 무엇이 이기는지 결정하고 근거를 남겨라.

- **⚠️ 텍스트 경로가 `$search`에 자체 `limit`을 못 건다 — NFR-01 위험 (T-011 F-1, G5 R-4).**
  `text_idx`는 `dynamic:false`에 `text` 단일 매핑이라(`specs/02:94`가 "path text"만 정했다)
  `meta.type`·`meta.project`·`embeddingVersion`을 `$search`의 `compound.filter`로 걸 수 없다.
  그래서 `$search → $match → $limit` 순서로 우회한다. 대가: **좁은 필터(작은 project) × 흔한 토큰이면
  mongot이 매칭 전체를 mongod로 흘린다.** 도큐먼트 12건짜리 통합 테스트로는 절대 안 잡힌다.
  **이 태스크의 Scope에 레이턴시 로깅이 있으므로, 여기가 실측할 지점이다** —
  `NFR-01(검색 API p95 < 1.5s)`에 대해 재라. 근본 해결은 `text_idx`에 filter 필드 추가이고
  그건 `specs/02` 개정(인간 승인)이 선행이다.

- **`maxVectorScore`는 응답에 자리가 없다(SearchHit에 없다) — T-018/T-019가 쓴다.**
  다만 **레이턴시 로깅에 함께 남기면 임계값 튜닝의 근거가 된다**(T-013이 이 값을 스윕한다).
  원시 cosine 척도(−1..1)이고, 벡터 경로 0건이면 `null`이다.
