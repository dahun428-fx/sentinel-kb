# T-019: /v1/answer (SSE) + suggest_resolution 연결
refs: specs/04-api.md, specs/07-mcp.md
M: M4 | deps: T-018, T-015

## Scope
- POST `/v1/answer` — 일반/SSE 스트리밍 응답
- MCP `suggest_resolution` 스텁을 실제 answer 호출로 교체
- found:false 경로에서 에이전트가 record_knowledge로 이어가도록 응답 문구 설계

## Out of scope
- 인용 검증(T-020)

## Acceptance
- [x] 통합 테스트: 스트리밍 응답이 청크 단위로 도착하고 완료 이벤트로 종료
- [x] 무관한 쿼리 5개 → 전부 found:false
- [x] MCP suggest_resolution 응답에 인용된 recordId 목록 포함
- [x] `pnpm verify` 그린

## Context budget
- 읽기: specs/04, specs/07, packages/api/**, packages/mcp/**

---

## 결정 (T-019에서 내림)

- **D-1. `@anthropic-ai/sdk`를 추가하지 않았다 — 실 LLM provider는 여전히 없다.** (T-018 F-1의 답)
  근거 넷: (a) 실 provider는 `packages/core/src/llm/`에 있어야 하는데(CLAUDE.md) 그건 이 태스크의
  Context budget(`packages/api/**`·`packages/mcp/**`) **밖**이고, budget 밖 파일 수정은 태스크 루프의
  중단 사유다. (b) 새 의존성은 lockfile 변경이라 인간 승인 사항이다(T-018 D-2). (c) T-019 Acceptance
  어디에도 실제 모델 호출이 필요 없다 — specs/05가 unit·integration은 fixture 목, 실 호출은 eval
  계층으로 갈라 놓았다. (d) provider에는 모델 ID·키·`.env.example` 결정이 딸려 오는데
  (CLAUDE.md의 "모델명 하드코딩 금지"가 임베딩과 같은 계열로 적용된다) 그 전부가 budget 밖이다.
  **붙일 때는 공식 SDK를 써라. `embedder/voyage.ts`의 raw-fetch를 복사하지 마라** — Messages API
  파라미터 계약은 세대마다 움직인다(`budget_tokens` 제거, prefill 400, `thinking:{type:"adaptive"}`).
  → 귀결: `chatModel`은 `AppOptions`의 **선택 의존**이고, `server.ts`는 아직 넘기지 못하므로
    **프로덕션에서 `/v1/answer`는 뜨지 않는다.** 스텁 모델을 넘겨 라우트를 띄우지 않았다 —
    그러면 "모델이 없다"가 `found:false`("유사 사례 없음")로 둔갑하고, 그건 거짓말이다.

- **D-2. SSE는 게이트 뒤에만 열린다.** `found:false`는 `stream:true` 요청에도 JSON으로 나간다.
  `found:false`를 SSE 프레임으로 표현하면 T-018이 지킨 "미달이면 호출 자체가 없다"가 HTTP
  표면에서 되돌려진다(클라이언트가 스트림 개시를 관측한다). 계약(`AnswerResponse`)이 두 갈래를
  모두 JSON으로 정의하므로 계약 위반이 아니다 — 오히려 SSE로 `found:false`를 내는 쪽이 계약에
  없는 표면을 만든다. `answer.int.spec.ts`가 **content-type + 모델 호출 수**로 함께 잠근다.

- **D-3. 게이트는 `generateAnswer` 한 곳뿐이다.** 라우트도 MCP 도구도 자체 판정을 갖지 않는다.
  MCP 쪽은 "core-api로 나가는 것은 `POST /v1/answer` 하나뿐"과 "인용 점수가 낮아도 found:true를
  뒤집지 않는다"로 잠갔다(T-015 F-4가 요구한 단일화).

## Findings (후속 태스크로 넘김)

- **⚠️ F-1 (T-020). 인용 **없는 문장**은 지금 그대로 통과한다 — 실측으로 확인했다.**
  `/v1/answer`가 잠그는 것은 응답 수준의 `citations.min(1)`뿐이고, 그 배열은 **검색 컨텍스트**에서
  만들어진다 — 답변 텍스트를 보고 만드는 것이 아니다. 프로브 결과:
  모델이 `"그냥 재시작하면 됩니다. 인용은 없습니다."`(인용 마커 0개)를 내놔도 응답은
  `found:true` + `citations:[{recordId:...}]`였다. 즉 **인용이 하나도 박히지 않은 답변에도
  인용 목록이 붙는다.** specs/03 §5(문장 분할 → 각 주장 문장의 인용 검증 → 1회 재생성 →
  `groundingViolation` 로깅)는 T-019 Out of scope라 손대지 않았다. T-020의 검증 대상 집합은
  `FoundResult.citations`이고(T-018 F-4), 라우트에서는 `toAnswerBody`가 그 자리다.

- **⚠️ F-2 (T-026). `/v1` 경로에 `proxy_buffering off`가 없다 — 시드 INC-06의 재현 조건이다.**
  specs/06의 nginx 블록은 `/mcp`에만 버퍼링 해제를 걸어 두었고 `/v1 → core-api:3001`에는 없다.
  방어선 하나는 코드에서 세웠다(`/v1/answer` SSE 응답에 `X-Accel-Buffering: no`, 테스트가 잠금).
  그러나 그것만으로는 부족하다 — `proxy_read_timeout`이 짧으면 긴 생성이 중간에 끊긴다.
  **T-026은 `/v1/answer`(또는 `/v1`)에 `proxy_buffering off` + read timeout 상향을 넣고,
  specs/06의 nginx 블록 문면도 함께 고쳐야 한다**(현재 문면은 `/mcp`만 언급한다 → 스펙 정정 대상).

- **⚠️ F-3 (G6, 인간 승인 대상). `suggest_resolution`의 description과 title이 바뀌었다.**
  인자 스키마(`errorText`·`project`)는 **그대로**다. 바뀐 것은 산문뿐이지만 specs/07이
  "description 변경은 계약 변경 → tool-selection eval 재실행 필수"로 못박았다(G6).
  스텁 시절 문장("현재 이 도구는 검색 기반이라 원인 가설과 해결 절차를 생성하지 않는다")은
  이제 **거짓**이라 남겨 둘 수 없었다 — 그대로 두면 에이전트가 답변을 무시하고 get_record부터 연다.
  **T-016 tool-selection eval 재실행이 머지 전 조건이다.**

- **F-4 (실 provider 태스크). 진짜 토큰 스트리밍이 아니다.**
  `ChatModel.complete()`가 완성된 텍스트를 돌려주므로 SSE는 **완성된 답변을 청크로 나눠
  프레이밍**한다. 지금은 관측 가능한 차이가 없다(모델이 fake다). `ChatModel`에 `stream()`을
  더하는 것은 `packages/core` 수정이라 budget 밖이라 하지 않았다. 붙일 때 바뀌는 곳은
  `answer.ts`의 `sendSse` 청크 공급원 한 군데이고, **게이트 순서는 그대로 두어야 한다** —
  `generateAnswer`가 첫 토큰을 내기 전에 게이트를 통과했음이 이미 확정돼 있어야 한다.

- **F-5 (T-013). 게이트 로그가 이제 실제로 나간다.** `event:"answer"` 한 줄에
  `gateOutcome`/`gatePassed`/`gateThresholdEvaluated`/`gateMaxVectorScore`/`gateThreshold`가
  실린다(T-018 F-6이 기다리던 배선). **스윕 집계는 `gateThresholdEvaluated === false`를
  별도 칸으로 빼라.** 같이 실리는 `skipReason`으로 `below-threshold`와 `no-usable-context`를
  가를 수 있다 — 후자는 임계값이 아니라 오염 제외가 원인이므로 스윕에 섞으면 안 된다.

- **F-6 (관측). `excludedChunkCount`를 로그에 실었다** (T-018 F-7이 요청한 지표).
  `injection-suspect` 제외가 갑자기 늘면(=새 오염 유입 또는 새니타이저 오탐 증가) 이 필드로 보인다.

- **F-7 (운영). `/v1/answer` 재시도는 토큰을 두 번 태운다.**
  MCP `suggest_resolution`은 `coreApi.read()`로 부르고, 그쪽은 전송 실패·타임아웃·5xx에 최대
  3회 시도한다(`DEFAULT_MAX_ATTEMPTS`). `/v1/answer`는 아무것도 저장하지 않으므로 멱등성
  자체는 맞지만, **생성은 비싸고 느리다** — 10초 타임아웃 × 3회면 NFR-01(MCP 도구 p95 < 2s)을
  구조적으로 넘긴다. 요청별 `maxAttempts`/`timeoutMs` 오버라이드가 필요하다(현재는 클라이언트
  단위 설정뿐이라 `core-api-client.ts` 수정이 필요하고 그건 이 태스크 범위 밖이었다).

- **F-8 (가드 간극). 드리프트 가드가 보는 표면과 운영 표면이 다르다.**
  `openapi.spec.ts`의 `makeApp()`은 `chatModel`을 주입해 `/v1/answer`를 띄우지만 `server.ts`는
  주입하지 못한다(D-1). 즉 **가드는 초록인데 프로덕션에는 그 라우트가 없다.**
  "`server.ts` 배선을 검증하는 테스트가 없다"는 T-012 G5 지적이 실제 간극으로 나타난 자리다.
  실 provider가 붙는 태스크가 이 간극을 닫아야 한다(그때 `server.ts`는 `retriever`처럼
  설정이 없으면 **부팅이 죽는** 쪽으로 둘 것).
