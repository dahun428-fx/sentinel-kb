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
- [x] 임계값 미달 입력 → 생성 호출이 아예 발생하지 않음(스파이 검증)
- [x] 플래그된 청크가 컨텍스트에서 제외됨을 검증
- [x] 프롬프트 4개 필수 조항이 모두 포함되는 스냅샷 테스트
- [x] `pnpm verify` 그린

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

---

## 결정 (T-018에서 내림)

- **D-1. `maxVectorScore === null`이면 게이트를 통과시키되 판정 불가를 표시한다.**
  F-B의 미결 사항에 대한 답. 근거와 문면은 `specs/03 §4`에 "T-018 결정(인간 비준 대상)"으로
  옮겨 적었다. 구현은 `generator/gate.ts`이고, `GateDecision.thresholdEvaluated`와
  `outcome: "not-evaluable"`이 정상 통과와 이 케이스를 가른다.
  **T-013은 스윕 집계에서 이 두 갈래를 분리해야 한다.**

- **D-2. `packages/core/src/llm/`을 만들되 실 provider는 넣지 않았다.**
  CLAUDE.md가 "LLM 호출은 `packages/core/src/llm/` 경유만 허용"이라고 못박았는데 디렉터리가
  없었다. T-018이 §4 생성을 구현하는 첫 태스크이므로 여기서 만들지 않으면 그 규칙이 첫
  사용처에서 깨진다. 다만 담은 것은 `ChatModel` 인터페이스와 fake뿐이다 —
  실 provider는 **의존성 추가 결정**(`@anthropic-ai/sdk`)이 필요하고 그건 T-018 Scope 밖이다.
  근거 전문은 `packages/core/src/llm/types.ts` 헤더.

- **D-3. `ChatRequest`에 `temperature`를 두지 않았다.**
  현행 Claude 모델(Opus 5·Sonnet 5·4.7+)은 `temperature`/`top_p`/`top_k`를 받지 않고
  400으로 거절한다. 필드를 두면 provider 구현자가 "채워야 하는 값"으로 읽고 실어 보내
  요청이 죽는다. 생성의 결정론은 온도가 아니라 fake 주입으로 얻는다(specs/05).

## Findings (후속 태스크로 넘김)

- **⚠️ F-1 (T-019). 실 LLM provider가 아직 없다 — `@anthropic-ai/sdk`를 물릴지 결정해야 한다.**
  `generateAnswer`는 `ChatModel`을 주입받으므로 core는 완결돼 있지만, `/v1/answer`가
  실제로 답을 만들려면 컴포지션 루트가 진짜 구현체를 넘겨야 한다.
  **`embedder/voyage.ts`의 raw-fetch 패턴을 복사하지 마라.** 그 선례의 근거는 "provider
  교체(NFR-06)가 SDK 버전에 막히지 않게"이고 임베딩에는 타당하지만, Messages API는 공식 TS
  SDK가 있고 파라미터 계약이 세대마다 움직인다(thinking·effort·max_tokens 규칙). 손으로 만든
  fetch 클라이언트는 그 변화를 조용히 놓친다. 새 의존성이므로 lockfile 변경 승인이 필요하다.

- **⚠️ F-2 (T-019). SSE 스트리밍은 현재 `ChatModel` 계약에 없다.**
  `complete()`는 완성된 텍스트 하나를 돌려준다. T-019 Acceptance 1이 "스트리밍 응답이 청크
  단위로 도착"을 요구하므로 `ChatModel`에 스트리밍 메서드를 **추가**해야 한다.
  그때 **게이트를 스트림 시작 앞에 두는 것**이 계약이다 — 헤더를 먼저 흘려보낸 뒤 게이트에
  걸리면 `found:false`를 SSE 프레임으로 표현해야 하고, 그건 T-018이 지킨 "미달이면 호출
  자체가 없다"를 HTTP 표면에서 되돌리는 셈이다.

- **F-3 (T-019). `RetrievedChunk.text`를 HTTP 표면으로 내보내지 마라 (NFR-03, T-011 F-E).**
  `FoundResult`는 본문을 싣지 않는다(`citations`·`contextChunkIds`만). 그 경계를 유지하라.
  `excluded`도 `chunkId`·`recordId`·`flags`만 있고 본문이 없다 — 의도적이다.

- **F-4 (T-020). 인용 검증의 "유효한 ID 집합"은 `FoundResult.citations`다.**
  컨텍스트에 **실제로 들어간** 청크의 인용만 담겨 있고, `injection-suspect`로 제외된 것은
  빠져 있다. 제외된 레코드를 인용한 응답은 그러므로 자동으로 위반으로 잡힌다 — 이 성질에
  기대는 테스트를 하나 두면 F-5의 회귀도 같이 잡힌다.
  재생성 1회는 `generateAnswer`를 다시 부르면 되지만, **그때 게이트를 다시 평가하지 마라** —
  같은 `RetrievalResult`에 대한 두 번째 판정은 첫 번째와 같고, 호출만 한 번 더 든다.

- **F-5 (T-021). 오염 레코드는 `flags`에 `injection-suspect`가 실려야 제외된다.**
  제외 주체는 `buildGenerationContext`이고 판단 근거는 **오직 그 플래그**다. 즉 이 태스크의
  "생성 컨텍스트 미포함"은 실제로는 **T-004 새니타이저의 탐지율**을 재는 것이다. 탐지되지
  않은 오염은 그대로 컨텍스트에 들어간다(그때 방어선은 프롬프트 조항 3뿐이다).
  eval 진입 시 첫 확인 항목: 오염 레코드 10건이 **전부** `injection-suspect`로 플래그됐는가.
  플래그가 안 붙었는데 "10/10 방어 성공"이 나오면 그건 프롬프트가 막은 것이지 제외가 막은 게
  아니며, 두 방어선을 구별해 리포트해야 한다.
  (T-006 F-8이 경고한 fake 임베딩 문제도 그대로 유효하다 — 게다가 이제 `maxVectorScore`가
  `null`이 아니라 **0 근처 실수**로 오므로 D-1의 통과 경로를 타지 않고 정직하게 차단된다.)

- **F-6 (T-013). 게이트 로그 필드가 생겼다.** `buildGateLogFields`가
  `gateOutcome`/`gatePassed`/`gateThresholdEvaluated`/`gateMaxVectorScore`/`gateThreshold`를
  낸다. 스윕 집계는 `gateThresholdEvaluated === false`인 질의를 **별도 칸**으로 빼야 한다.
  아직 이 필드를 실제로 로깅하는 호출자는 없다 — 배선은 T-019의 몫이다.

- **F-7 (관측 없음). `injection-suspect` 제외가 로그로 나가지 않는다.**
  `GenerateResult.excluded`에 담기지만 `buildGateLogFields`에는 없고, 이걸 세는 지표도 없다.
  운영에서 "제외가 갑자기 늘었다"(= 새 오염 유입, 또는 새니타이저 오탐 증가)를 알아챌 방법이
  현재 없다. 필드 하나(`excludedChunkCount`)면 되지만 T-018 Scope 밖이라 넣지 않았다.
