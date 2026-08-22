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
