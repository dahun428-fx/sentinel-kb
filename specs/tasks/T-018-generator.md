# T-018: generator — 인용 강제 + 임계값 게이트
refs: specs/03-rag-pipeline.md §4
M: M4 | deps: T-011

## Scope
- `core/src/generator/`: 컨텍스트 조립 + 시스템 프롬프트(4개 필수 조항) + 호출
- 임계값 게이트: retriever가 반환한 **융합 전 cosine 최고점** < SIMILARITY_THRESHOLD → 생성 스킵, `{found:false, suggestRecord:true}` (RRF 점수와 비교 금지, 감사 B-1)
- injection-suspect 청크는 생성 컨텍스트에서 제외
- 프롬프트는 파일로 분리(`prompts/answer.md`)해 버전 관리

## Out of scope
- HTTP/SSE, 후처리 검증(T-020)

## Acceptance
- [ ] 임계값 미달 입력 → 생성 호출이 아예 발생하지 않음(스파이 검증)
- [ ] 플래그된 청크가 컨텍스트에서 제외됨을 검증
- [ ] 프롬프트 4개 필수 조항이 모두 포함되는 스냅샷 테스트
- [ ] `pnpm verify` 그린

## Context budget
- 읽기: specs/03 §4, packages/core/src/generator/**, packages/core/src/retriever/types.ts

## Findings (T-011에서 넘김 — 착수 전에 반드시 읽을 것)

- **⚠️ F-A. Atlas의 `vectorSearchScore`는 원시 cosine이 아니다 — `(1+cos)/2`로 정규화된 값이다.**
  T-011 구현자와 검증자가 각각 독립으로 atlas-local에서 실측했고, 검증자는 중간각까지 넣어
  **7개 픽스처 전부** 일치를 확인했다:

  | 각도 | raw cos | (1+cos)/2 | Atlas 실측 |
  |---|---|---|---|
  | 동일 | +1.0 | 1.00 | **1.000000** |
  | 45° | +0.707 | 0.854 | **0.853553** |
  | 60° | +0.5 | 0.75 | **0.750000** |
  | 직교 | 0.0 | 0.50 | **0.500000** |
  | 120° | −0.5 | 0.25 | **0.250000** |
  | 정반대 | −1.0 | 0.00 | **0.000000** |

  즉 정규화 값을 그대로 `SIMILARITY_THRESHOLD=0.62`와 비교하면 **원시 cosine 0.24 게이트**가 되어
  의도보다 훨씬 헐거워진다. `specs/03:60`이 "**원시 cosine** 최고점(vectorSearchScore)"이라고 쓴 것은
  **한 문장 안에서 두 척도를 등치**시킨 스펙 결함이다.
  → **해소 방식(T-011에서 결정·구현)**: retriever가 `2s − 1`로 **원시 cosine으로 환산해서 반환한다.**
    따라서 **T-018은 `maxVectorScore`를 `SIMILARITY_THRESHOLD`와 그대로 비교하면 된다.**
    스펙을 바꾸지 않고 코드를 스펙에 맞추는 쪽을 택했다(스펙 변경은 인간 승인 사항이고,
    0.62는 원시 cosine 전제로 정해진 값으로 보인다). **이중 환산하지 마라** — 이미 환산된 값이다.

- **⚠️ F-B. `maxVectorScore`가 `null`일 때의 게이트 동작을 스펙이 정하지 않았다.**
  벡터 경로가 0건이면(예: `embedding` 필드가 없는 청크만 매칭) 값은 `0`이 아니라 **`null`**이다 —
  "유사도 0"과 "판정 불가"는 다르고, 0으로 두면 T-018이 유사도 0으로 오판한다.
  검증자가 실제로 그 상태를 만들어냈다: `vectorCandidateCount=0`, `textCandidateCount=1`,
  `maxVectorScore=null`, **그런데 hits는 1건 있다.**
  `null < 0.62`는 JS에서 false(→생성 진행), `Number(null)=0`이면 true(→`found:false`).
  **`specs/03 §4`는 이 경우를 정하지 않았다 — 착수 전 결정이 필요하다.**
  (권고: 텍스트 경로 단독 hit은 인용 근거가 되므로 생성을 막을 이유가 약하다. 다만 "임계값을
   판정할 수 없었다"는 사실이 응답이나 로그에 남아야 튜닝이 가능하다.)

- **F-C. 이제 `maxVectorScore`는 음수가 될 수 있다.** 원시 cosine 환산의 당연한 귀결이다(범위 −1..1).
  `null` 체크와 음수 체크를 섞지 마라.

- **F-D. `injection-suspect` 제외는 전적으로 T-018의 몫이다.**
  `specs/03 §2`가 "생성 컨텍스트에서 제외(목록에는 경고와 함께 노출)"로 두 소비자를 갈라놨고,
  retriever는 후자를 담당해 **플래그를 실어 보내되 빼지 않는다.**
  T-018이 `RetrievedChunk.flags`를 보고 걸러야 하며, **안 하면 NFR-05 위반이 조용히 통과한다.**
  G5 확인: 이 의무는 T-018 Scope와 Acceptance 2에 이미 명시돼 있고 T-021이 겹쳐 검증한다.

- **F-E. `RetrievedChunk`는 청크 본문(`text`)을 갖는다 — 이것이 core가 `SearchHit`을 반환하지 않은 이유다.**
  `SearchHit`은 `.strict()`이고 `summary`(레코드 요약)만 있어 본문이 없다. 생성기가 답도
  인용(`[REC-id#section]`)도 만들 수 없으므로, `SearchHit`을 넓히면 HTTP 응답에 본문이 실려
  **NFR-03을 즉시 위반**한다. T-018은 core의 `RetrievedChunk`를 직접 쓰고,
  **HTTP 표면으로는 절대 `text`를 내보내지 마라.**
