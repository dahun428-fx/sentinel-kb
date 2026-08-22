# T-039: 실 LLM provider 연결 (Anthropic) + tool-calling 경로
refs: specs/03-rag-pipeline.md §4, specs/05-test-strategy.md(결정론 원칙·Eval 3), specs/06-deployment.md(시크릿), specs/07-mcp.md:44(G6), NFR-01·NFR-02·NFR-06, CLAUDE.md
M: M4 | deps: T-018, T-019

## 배경 — 왜 이 태스크가 필요한가

`packages/core/src/llm/`에는 `ChatModel` 인터페이스와 fake만 있다(T-018 D-2). T-019는 실
provider를 붙이지 않았고 — budget 밖이라 정당한 판단이었다 — 그 귀결을 정직하게 적었다:

> `server.ts`가 `chatModel`을 못 넘기므로 **`/v1/answer`는 프로덕션에서 뜨지 않는다.**
> 임의의 스텁을 넘겨 라우트를 띄우지 않는다 — "모델 없음"이 `found:false`("유사 사례 없음")로
> 둔갑하면 거짓말이다. (T-019 F-8: **드리프트 가드는 초록인데 프로덕션엔 라우트가 없다.**)

두 번째 끊긴 사슬이 T-016에서 드러났다. specs/05 Eval 3의 판정 방식은 **"도구 목록만 주고
Claude에게 제시 → 올바른 도구 + 필수 인자 선택률"**인데, `ChatRequest`가
`{system, messages, maxTokens}`뿐이라 **도구를 실을 자리가 없다.** 그래서 T-016 Acceptance 1이
원리적으로 판정 불가이고, specs/07:44의 **"description 변경은 계약 변경 → tool-selection eval
재실행 필수(G6)"**는 이행 수단이 없는 조항으로 남아 있다. T-019 F-3이 실제로 G6를 걸었는데
그것을 해소할 방법이 없다.

두 사슬 모두 끊긴 고리가 `packages/core/src/llm/`에 있다 — CLAUDE.md가 "LLM 호출은 그 디렉터리
경유만 허용"으로 못박았으므로 다른 곳에서는 고칠 수 없다.

## Scope
- `packages/core/src/llm/anthropic.ts` — `@anthropic-ai/sdk`(0.120.0) 기반 provider.
  `ChatModel.complete()`와 `ToolChoiceModel.selectTool()`을 **한 구현이 둘 다** 제공한다.
- `packages/core/src/llm/tools.ts` — tool-selection 전용 타입(`ToolSpec`·`ToolUse`·
  `ToolSelectionRequest`·`ToolSelectionResponse`·`ToolChoiceModel`). `ChatRequest`에 합치지 않는다(D-7).
- `packages/core/src/llm/config.ts` — `ANTHROPIC_MODEL`·`ANTHROPIC_API_KEY`·
  `ANTHROPIC_TIMEOUT_MS`·`ANTHROPIC_MAX_RETRIES`. **모델 ID에 기본값 없음**(D-2).
- `packages/core/src/llm/fake.ts` — `createFakeToolChoiceModel` 추가(기존 `createFakeChatModel` 유지).
- `packages/core/src/llm/index.ts` — `createChatModel()` / `createToolChoiceModel()` env 팩토리.
- `packages/api/src/server.ts` — `chatModel` 배선. **설정이 없으면 부팅이 죽는다**(D-4).
- `.env.example` — 새 env 문서화.
- 가드 테스트 4종: 모델 ID 하드코딩 금지 / 샘플링 파라미터 금지 / 시크릿 비유출 / `server.ts` 배선.

## Out of scope
- **SSE 토큰 스트리밍 재배선**(`answer.ts`·`generate.ts`) — D-6, F-3.
- **T-016 러너 자체.** 다른 브랜치(`feat/T-016-tool-eval`)에 있고 이 워크트리에 없다.
- `output_config.effort`·`thinking` 튜닝 — D-8, F-5.
- 실제 모델 호출을 하는 테스트. specs/05가 "실제 모델 호출은 **eval 계층에서만**"으로 갈랐다.
- `packages/mcp`의 `core-api-client.ts` 요청별 타임아웃 오버라이드(T-019 F-7) — F-4.

## Acceptance
전부 명령어로 판정 가능하다. `CMD`는 판정 명령.

- [ ] **A1** `pnpm verify` 그린.
      `CMD: pnpm verify`
- [ ] **A2** `packages/core/src/llm/**` 구현 소스(주석 제외)에 구체 모델 ID 리터럴이 없다.
      `CMD: pnpm test -- packages/core/src/llm/no-hardcoded-model.spec.ts`
- [ ] **A3** 같은 소스에 `temperature`·`top_p`·`top_k`(및 camelCase 변형)가 없다.
      현행 Claude 모델은 그 파라미터를 400으로 거절한다(T-018 D-3).
      `CMD: pnpm test -- packages/core/src/llm/no-hardcoded-model.spec.ts`
- [ ] **A4** 401·429·연결 실패·응답 본문이 키를 되비추는 경우 **전부**에서, `ANTHROPIC_API_KEY`
      값이 `error.message`·`String(error)`·`JSON.stringify(error, 모든 열거 가능 필드)`
      어디에도 나타나지 않는다.
      `CMD: pnpm test -- packages/core/src/llm/anthropic.spec.ts`
- [ ] **A5** `ANTHROPIC_API_KEY` 또는 `ANTHROPIC_MODEL`이 없으면 `createChatModel()`·
      `createToolChoiceModel()`이 코드가 붙은 `LlmError`로 던진다(조용한 폴백 없음).
      `CMD: pnpm test -- packages/core/src/llm/config.spec.ts`
- [ ] **A6** `server.ts`가 `createChatModel()`을 부르고 그 값을 `createApp`에 넘긴다 —
      즉 프로덕션 부팅 경로에서 `/v1/answer`가 실재한다(T-019 F-8 간극 닫힘).
      `CMD: pnpm test -- packages/api/src/server-wiring.spec.ts`
- [ ] **A7** 재시도·타임아웃이 SDK 기본값이 아니라 **명시값**이다. 주입 `fetch`로 시도 횟수를
      실측해 `ANTHROPIC_MAX_RETRIES=0`이면 1회, `=1`이면 2회임을 단언한다.
      `CMD: pnpm test -- packages/core/src/llm/anthropic.spec.ts`
- [ ] **A8** `selectTool()`이 `tool_use` 블록을 `{name, input}` 배열로 돌려주고, 모델이 아무
      도구도 고르지 않으면 **빈 배열**이다(선택 안 함이 오답으로 접히지 않는다).
      `CMD: pnpm test -- packages/core/src/llm/anthropic.spec.ts`
- [ ] **A9** tool-selection 요청이 `tool_choice`로 도구를 강제하지 않는다. 주입 `fetch`가
      실제 전송 바디를 캡처해 `tool_choice` 부재를 단언한다. 강제하면 Eval 3의 정확도가
      무의미해진다(무엇을 주든 도구를 고른다).
      `CMD: pnpm test -- packages/core/src/llm/anthropic.spec.ts`
- [ ] **A10** `llm/**`의 어떤 테스트도 네트워크를 타지 않는다 — 모든 spec이 `fetch` 주입
      또는 fake만 쓴다(grep 기반 테스트).
      `CMD: pnpm test -- packages/core/src/llm/no-hardcoded-model.spec.ts`
- [ ] **A11** T-018의 "임계값 미달 → 모델 호출 0회" 스파이 단언이 여전히 그린.
      tool-calling 추가가 그 보장을 무력화하지 않았다.
      `CMD: pnpm test -- packages/core/src/generator/generate.spec.ts`

## Context budget
- **읽기**: `packages/core/src/llm/**`, `packages/core/src/embedder/{voyage.ts,config.ts,index.ts,no-hardcoded-model.spec.ts}`,
  `packages/core/src/generator/**`, `packages/api/src/{server.ts,app.ts,answer.ts}`,
  `specs/03-rag-pipeline.md` §4, `specs/05-test-strategy.md`, `specs/06-deployment.md`,
  `specs/00-product.md`(NFR), `specs/07-mcp.md`, `.env.example`, `CLAUDE.md`,
  `package.json`, `packages/core/package.json`, `vitest.config.ts`, `eslint.config.js`,
  `specs/tasks/{README.md,T-006-embedder.md,T-016-tool-selection-eval.md,T-018-*.md,T-019-answer-route.md}`
- **수정**: `packages/core/src/llm/**`, `packages/api/src/server.ts`,
  `packages/api/src/app.ts`(**주석만** — `chatModel?`의 "프로덕션 루트가 아직 이 값을 만들지
  못한다"는 문면이 이 태스크로 거짓이 된다. 인접한 거짓 주석을 남기는 것이 최소 diff가 아니다),
  `packages/api/src/server-wiring.spec.ts`(신규), `.env.example`,
  `packages/core/package.json`, `pnpm-lock.yaml`, `specs/tasks/{T-039-llm-provider.md,README.md}`

## 결정

### D-1 공식 SDK를 쓴다. `embedder/voyage.ts`의 raw-fetch 선례를 복사하지 않는다.
T-018 D-2가 이미 근거를 적어 뒀다. voyage가 raw fetch인 근거는 "provider 교체(NFR-06)가 SDK
버전에 막히지 않게"이고 임베딩에는 타당하다. Messages API는 파라미터 계약이 세대마다 움직여
(thinking·effort·max_tokens·샘플링 파라미터 제거) 손으로 만든 fetch 클라이언트는 그 변화를
**조용히** 놓친다. `@anthropic-ai/sdk@0.120.0`을 `packages/core`에 물린다.

### D-2 모델 ID를 하드코딩하지 않는다 — `EMBEDDING_MODEL`과 같은 규약.
`ANTHROPIC_MODEL`에 **기본값을 두지 않는다.** 없으면 `LlmError(MODEL_MISSING)`로 즉시 던진다.
`embedder/config.ts`가 `EMBEDDING_MODEL`에 대해 하는 것과 같다. `.env.example`에는 값을 적는다
(임베딩도 `EMBEDDING_MODEL=voyage-3`을 적어 두었다 — 가드는 **소스**만 본다).

가드는 `packages/core/src/llm/no-hardcoded-model.spec.ts`에 새로 만든다.
**`embedder/`에 파일을 추가하지 않는다** — 그쪽 `no-hardcoded-model.spec.ts`가 파일 목록을
리터럴로 단언하므로 파일이 하나 늘면 무관한 이유로 깨진다(T-010 F-1의 교훈).

### D-3 샘플링 파라미터를 보내지 않는다.
`temperature`·`top_p`·`top_k`는 현행 Claude 모델이 400으로 거절한다(T-018 D-3, `.env.example`
주석). `ChatRequest`에 필드가 없는 것이 누락이 아니듯, provider도 그것을 만들어 넣지 않는다.
A3의 grep 가드가 "쓸 자리가 아예 없다"를 잠근다.

### D-4 키가 없으면 **부팅을 거부한다** (명시적 503이 아니라).
`server.ts`가 `createChatModel()`을 부르고, 설정이 없으면 그 호출이 던져 프로세스가 죽는다.

근거 셋:
1. **레포에 선례가 있고 일관성이 근거다.** 같은 파일에서 `createRetriever({embedder: createEmbedder()})`가
   이미 그렇게 한다 — "없으면 라우트가 404가 되는 게 아니라 부팅이 실패한다"(T-006 인계 패턴).
   MCP stdio CLI도 같다(T-014).
2. **503은 비용을 먼저 태운다.** 라우트를 띄우고 503을 내려면 요청이 인증·검증·**검색**을
   지나 생성 직전에 죽는다. 임베딩 호출과 Atlas 왕복 두 번이 이미 나간 뒤다. 오설정 1건이
   요청마다 돈을 쓴다.
3. **오설정이 드러나는 시점이 배포냐 운영이냐의 차이다.** 부팅 거부는 `compose up -d`가
   즉시 실패하고 롤백이 자동이다(specs/06 CI/CD). 503은 헬스체크가 초록인 채로 뜨고
   `/v1/answer`만 죽는다 — T-019 F-8이 지적한 "가드는 초록인데 표면은 없다"의 재현이다.

**조용히 사라지는 것만은 안 된다**는 제약은 셋 다 만족하지만, 셋 중 가장 시끄러운 것이 부팅
거부다. `createApp`의 `chatModel?` 선택 의존은 **그대로 둔다** — 시드 스크립트·records
통합 테스트가 모델 없이 앱을 만드는 정당한 소비자이기 때문이다(`app.ts` 주석의 `retriever`와
같은 근거). 운영에서 조용히 빠질 위험은 컴포지션 루트가 닫고, A6가 그 배선을 잠근다.

### D-5 재시도·타임아웃을 NFR-01에서 역산한다. SDK 기본값을 그대로 두지 않는다.
SDK 기본은 `timeout` 10분, `maxRetries` 2(=3회 시도)다. **최악 30분**이고 NFR-01(MCP 도구
p95 < 2s)의 900배다. T-019 F-7이 지적한 대로 MCP 클라이언트가 이미 자기 층에서 3회 시도하므로
**층이 곱해진다: 3 × 3 = 사용자 요청 1건에 모델 호출 9회.**

역산:
- MCP 클라이언트의 시도당 타임아웃이 **10초**다(T-019 F-7). 그보다 오래 걸린 생성은
  **아무도 받지 못한다** — 토큰만 태우고 버려진다. 따라서 시도당 타임아웃 상한은 10초 미만.
  → `ANTHROPIC_TIMEOUT_MS` 기본 **8000**.
- 재시도는 **빠른 실패**(429 즉시 응답, 연결 거부)에 의미가 있다. **타임아웃 뒤의 재시도는
  거의 언제나 낭비다** — 호출자가 이미 포기했고 과금은 두 배가 된다.
  → `ANTHROPIC_MAX_RETRIES` 기본 **1**(=2회 시도). 층 곱은 3 × 2 = 6으로 내려간다.

**남는 간극을 숨기지 않는다**: 8초 × 2회 = 16초는 여전히 NFR-01의 2초가 아니다.
`ANSWER_MAX_TOKENS=2048`짜리 비스트리밍 생성이 2초 안에 끝나는 모델은 없다. 이 층이 할 수 있는
것은 **상한을 유한하고 명시적으로 만드는 것**까지다. 진짜 해소는 토큰 스트리밍(F-3) 또는
`suggest_resolution`에 한해 NFR-01을 완화하는 **스펙 결정**(F-4)이며 둘 다 이 태스크 밖이다.

### D-6 `ChatModel`에 스트리밍 메서드를 **더하지 않는다.**
T-019 F-4가 남긴 갭(SSE가 완성 답변을 청크로 쪼갠 것)은 실재한다. 그러나 그것을 닫으려면
`generate.ts`와 `answer.ts`를 함께 고쳐야 하고, 그 순간 **T-019가 세운 불변식 하나가 깨진다**:

> 응답 형상(`toAnswerBody`)이 **첫 바이트가 나가기 전에** 검증된다. `AnswerResponse`의
> found:true 갈래는 `citations.min(1)`이라 근거 없는 답변이 스키마에서 죽는다(FR-04·NFR-02).

토큰을 흘리면 답변 본문이 확정되기 전에 헤더가 나가므로 그 마지막 방어선을 **재설계**해야 한다.
게이트 순서(`generateAnswer` → 게이트 → 모델)는 그대로 지킬 수 있지만, 그것과 별개의 방어선이다.
설계 판단 + 뮤테이션 검증이 필요한 작업이라 **별 태스크가 맞다**(F-3).

**정정(설치된 SDK 소스 실측 후).** 처음에는 "provider 내부에서 `messages.stream()` +
`.finalMessage()`를 쓴다"로 정했다. 근거는 "`ANSWER_MAX_TOKENS`를 운영자가 128K로 올리면
비스트리밍 요청이 SDK의 가드에 걸린다"였다. **실측해 보니 그 가드는 우리에게 걸리지 않는다.**
`node_modules/@anthropic-ai/sdk/resources/messages/messages.js`의 조건이
`if (!body.stream && timeout == null)`이고, 우리는 타임아웃을 **명시**하므로(D-5)
`calculateNonstreamingTimeout`이 아예 불리지 않는다.

그렇다면 스트리밍으로 얻을 것이 없다 — `complete()`의 계약은 완성된 텍스트 1건이고 실제
구속 조건은 전송 방식이 아니라 **벽시계 상한**이다. 그래서 **두 경로 모두 비스트리밍
`messages.create()`**를 쓴다. 전송 모양이 하나면 요청 바디를 만드는 자리도 하나이고,
A3·A9의 가드가 볼 표면도 하나다.

### D-7 tool-calling을 더한다. 단, **별 메서드·별 타입**으로 나눈다.
더하는 이유: 안 더하면 T-016 Acceptance 1이 **영구히 판정 불가**이고 specs/07:44의 G6가
이행 수단 없는 조항으로 남는다. 그 고리는 `llm/`에만 있고 여기가 그 디렉터리다.

`ChatRequest`에 `tools?`를 붙이지 **않는** 이유 셋:
1. **T-018 Acceptance 1의 스파이 단언을 흐린다.** `generateAnswer`의 계약은 "게이트 미달이면
   `complete()` 호출이 0회"다. 같은 메서드가 두 용도를 지면 `calls` 기록이 무엇의 증거인지
   흐려지고, 생성 테스트마다 언제나 비어 있는 `tools` 필드를 지고 다니게 된다.
2. **응답 형상이 다르다.** 생성은 `text`가, 도구 선택은 `{name, input}[]`이 본체다. 하나의
   응답 타입으로 합치면 모든 소비자가 자기 경로에서 **올 수 없는 갈래**를 좁혀야 한다.
3. **specs/05가 층으로 갈라 뒀다.** 생성은 제품 경로(Eval 2), 도구 선택은 eval 전용(Eval 3)이다.
   제품 경로의 인터페이스에 eval 전용 파라미터를 심으면 그 경계가 코드에서 사라진다.

그래서 `ToolChoiceModel { selectTool(req): Promise<ToolSelectionResponse> }`를 따로 둔다.
`createAnthropicModel()` 하나가 두 인터페이스를 **모두** 구현한다(HTTP 클라이언트·자격증명·
재시도 정책이 같으므로 구현을 쪼갤 이유는 없다 — 나뉘는 것은 **호출 표면**이다).

`tool_choice`를 **보내지 않는다**(A9). 강제하면 모델이 언제나 도구를 고르므로 Eval 3의
정확도가 무의미해지고, "아무 도구도 고르지 않는 것이 정답"인 시나리오를 표현할 수 없다.
`strict: true`도 붙이지 않는다 — Eval 3은 **필수 인자를 모델이 채웠는지**를 재는데, 스키마
강제는 그 실패를 서버 측에서 가려 버린다.

### D-8 `thinking`·`output_config`를 보내지 않는다.
모델 ID가 env로 교체 가능해야 하는데(D-2) 그 두 파라미터는 **모델마다 수용 여부가 다르다**
(`effort`는 구세대 모델에서 400, `thinking`의 형태도 세대마다 다르다). 교체 가능성을 요구하는
설계에서 요청 표면은 **모든 세대가 받는 최소 집합**이어야 한다. 최신 모델은 `thinking`을
생략하면 적응형으로 돌므로 품질 손실도 없다. 튜닝은 모델이 고정된 뒤의 일이다(F-5).

### D-9 env 팩토리에 `fake` provider를 두지 않는다.
`EMBEDDING_PROVIDER=fake`는 실재하고 T-006 F-8이 그 위험을 기록했다 — 다만 fake 임베딩은
**시끄럽게** 실패한다(cosine ≈ 0 → 항상 `found:false`). fake **생성**은 반대다:
그럴듯한 문자열이 정상 응답으로 나가 아무도 눈치채지 못한다. NFR-02가 막으려는 것이 정확히
그것이다. 그래서 `LLM_PROVIDER` env를 만들지 않고, fake는 테스트가 `createFakeChatModel()`을
직접 부르는 방식으로만 쓴다(지금과 같다).

### D-10 시크릿은 **레이어를 나가지 않는다**.
provider가 만드는 에러 메시지는 `status`·`type`·`requestId`만 담는다. **SDK 에러의
`message`도 응답 본문도 옮기지 않고**, SDK 에러를 `cause`로 달지도 않는다(`cause` 체인이
`JSON.stringify`나 `console.error(error)`에 걸려 통째로 덤프되는 것이 `http.cli.ts`의 전례다).
그 위에 `redactSecret()`을 한 겹 더 씌운다. A4가 "응답 본문이 키를 되비추는" 최악의 경우까지
포함해 잠근다.

## Findings

### 이 태스크에서 실제로 잡은 것 — 유출 프로브가 부분 유출을 찾았다
에러를 **실제로 유발해** 에러 표면 전체(`message`·`stack`·`cause` 체인·
`JSON.stringify(e, getOwnPropertyNames(e))`)를 파일로 덤프하고 grep했다(5개 실패 갈래 × 2개
호출 경로). 첫 실행에서 **한 갈래가 키의 앞 10자를 흘렸다**: 200인데 본문이 JSON이 아니면
`JSON.parse`가 던지고 그 `SyntaxError` 메시지에 본문 스니펫이 실리는데, **V8이 그것을 10자
안팎으로 자른다.** 잘린 조각은 키 전체와 일치하지 않아 전체 일치 마스킹을 **통과했다.**

그 10자(`sk-ant-api`)는 공개된 키 형식 접두라 엔트로피가 없다. 그럼에도 고친 이유:
"지금 새는 조각이 마침 무해한가"로 판단하기 시작하면 자르는 길이나 본문 배치가 조금만 달라져도
판단이 뒤집힌다. `redactSecret`을 **조각 단위**(길이 8 이상의 모든 부분 문자열)로 바꿨고,
프로브 재실행에서 전체 키·10자 접두·8자 접두 **전부 0건**이다.

**이것이 "뮤테이션만으로는 안 되는" 사례다.** 뮤테이션 M11(마스킹 호출 제거)은 프로브 전에
**생존했다** — 그때는 그 갈래를 끝까지 태우는 테스트가 없었기 때문이다. 프로브가 갈래를
찾아내자 테스트가 생겼고, 그 테스트가 M11을 죽였다.

### 후속 태스크가 알아야 할 것

- **⚠️ F-1 (스펙 결정 필요, 인간 판단). NFR-01이 생성 경로에서 여전히 성립하지 않는다.**
  이 태스크는 상한을 **유한하고 명시적으로** 만들었을 뿐이다(8초 × 2회). NFR-01은 "MCP 도구
  p95 < 2s"인데 `ANSWER_MAX_TOKENS=2048`짜리 비스트리밍 생성이 2초 안에 끝나는 모델은 없다.
  `suggest_resolution`은 `/v1/answer`의 하류라 이 지연을 그대로 받는다.
  선택지는 셋이다: (a) 토큰 스트리밍으로 **첫 바이트까지의 시간**을 재도록 NFR-01의 판정
  대상을 바꾼다, (b) 생성 도구에 한해 별도 NFR을 둔다, (c) `ANSWER_MAX_TOKENS`를 낮춘다.
  **(a)가 유력하지만 어느 것도 구현자가 고를 수 있는 문제가 아니다** — NFR 문면을 바꾸는 일이다.

- **⚠️ F-2 (T-016). tool-calling 인터페이스는 생겼지만 러너와 아직 만나지 못했다.**
  `createToolChoiceModel()`·`ToolSpec`·`ToolSelectionResponse`가 `@sentinel/core`에서 나간다.
  그러나 T-016의 러너 코드(`eval/tools/**`, `pnpm eval:tools`)는 **이 워크트리에 없다**
  (`feat/T-016-tool-eval` 미머지). 따라서 **"T-016이 실제로 돈다"는 이 태스크에서 판정 불가다.**
  머지 후 러너가 `selectTool()`을 쓰도록 배선하는 것이 남은 일이고, 그때 exit 78의 원인이
  "인터페이스 없음"에서 "자격증명 없음"으로 바뀌었는지 확인해야 한다.
  **채점기에 넘길 때 주의**: `toolUses`가 **빈 배열일 수 있고 그것이 정상**이다. 그걸 에러로
  접으면 "아무 도구도 고르지 않는 것이 정답"인 시나리오를 쓸 수 없다.

- **F-3 (별 태스크). SSE는 여전히 토큰 스트리밍이 아니다** — T-019 F-4가 그대로 남아 있다.
  D-6에 근거를 적었다: 토큰을 흘리면 `toAnswerBody`가 **첫 바이트가 나가기 전에** 응답 형상을
  검증하는 불변식(`citations.min(1)`, FR-04·NFR-02의 마지막 방어선)을 재설계해야 한다.
  게이트 순서(게이트 → 모델)는 유지할 수 있지만 그것과 **별개의 방어선**이다.
  그 태스크가 할 일: `ChatModel`에 스트리밍 메서드를 더하고, `generateAnswer`가 인용을
  **생성 전에** 확정한다는 사실(컨텍스트에서 나오므로 이미 참이다)을 이용해 형상 검증을
  스트림 시작 앞으로 끌어올 수 있는지 판단할 것.

- **F-4 (T-026 / `packages/mcp`). 요청별 타임아웃 오버라이드가 여전히 없다** (T-019 F-7).
  이 태스크는 **provider 쪽 층**만 낮췄다(3회 → 2회). MCP 클라이언트의 3회 시도는 그대로라
  최악의 곱은 6이다. `core-api-client.ts`에 요청별 `maxAttempts`/`timeoutMs`가 필요하고
  그건 `packages/mcp` 수정이라 이 태스크 budget 밖이었다.

- **F-5 (모델 고정 후). `effort`·`thinking` 튜닝을 하지 않았다.**
  D-8의 근거는 "모델 ID가 env로 교체 가능해야 하므로 요청 표면은 모든 세대가 받는 최소
  집합이어야 한다"다. 운영에서 모델을 하나로 고정하기로 결정하면 `output_config.effort`를
  낮춰 지연과 비용을 함께 줄일 수 있다(F-1의 (c)에 준하는 지렛대). 그때는 `.env.example`에
  `ANTHROPIC_EFFORT` 같은 env를 더하고 **모델별 수용 여부를 문서화**할 것.

### 남은 것 / 관측된 한계

- **F-6 `server-wiring.spec.ts`는 소스를 읽지 런타임을 재지 않는다.** 잠그는 것은
  "컴포지션 루트가 `chatModel`을 만들어 넘기는가" 한 줄이다. `start()`를 부르면 Mongo와 포트에
  결합되고, 그게 T-012 G5가 지적한 간극이 여태 안 닫힌 이유였다. **소스 grep은 리팩터링에
  약하다** — 호출을 헬퍼로 빼면 정규식이 놓친다. 그 취약함을 알고 택했고(런타임 테스트가
  없는 것보다 낫다), 더 강한 가드는 `start()`를 주입 가능하게 쪼개는 별 작업이다.

- **F-7 부팅 거부는 `/v1/answer`뿐 아니라 서버 전체를 세운다.** D-4의 귀결이다. `ANTHROPIC_*`가
  없으면 `/v1/search`·`/v1/records`·`/health`까지 뜨지 않는다. `createEmbedder()`가 이미 같은
  성질이라(검색용 임베딩이 없으면 부팅 실패) 새로 생긴 결합은 아니지만, **"답변 기능만 끄고
  운영하고 싶다"는 요구가 생기면 이 결정을 다시 봐야 한다.** 그때의 답은 503이 아니라
  `ANSWER_ENABLED=false` 같은 **명시적** 스위치일 것이다 — 조용한 부재와 달리 의도가 기록된다.

- **F-8 `redactSecret`의 비용이 키 길이의 제곱에 비례한다.** 100자 키면 약 4천 번의 부분
  문자열 검사다. **에러 경로에서만** 돌고 대상 문자열이 짧아 실측 영향이 없었지만, 에러가
  폭주하는 상황(레이트리밋 지속)에서는 그 경로가 뜨거워진다. 조각 길이 하한을 올리면
  비용이 준다 — 다만 그러면 실측으로 잡은 10자 유출이 되살아난다.

- **F-9 `EMBEDDING_PROVIDER=fake`와 달리 LLM에는 fake 갈래를 두지 않았다**(D-9).
  로컬에서 Anthropic 키 없이 core-api를 띄울 수 없다는 뜻이다. 그 불편이 "fake 생성이 조용히
  프로덕션에 들어가는" 위험보다 싸다고 판단했다. 개발 편의가 실제로 문제가 되면 답은
  fake provider가 아니라 F-7의 명시적 스위치다.

### 뮤테이션 검증 결과 (직접 실행, 13종 중 12종 사망 / 생존 1종은 동등 뮤턴트)

| # | 뮤테이션 | 결과 | 죽인 관측 경로 |
|---|---|---|---|
| M1 | 모델 ID 하드코딩(`options.model \|\| "claude-opus-5"`) | 사망 | `llm/no-hardcoded-model.spec.ts` — "코드 어디에도 구체 모델 ID가 없다"(A2) |
| M2 | 에러 메시지에 SDK `error.message` 복사 | 사망 | `anthropic.spec.ts` — "응답 본문이 키를 되비추어도 키가 새지 않는다"(A4) |
| M3 | `server.ts`에서 `chatModel` 배선 제거 | 사망 | `server-wiring.spec.ts` — "createApp 호출에 chatModel을 넘긴다"(A6) |
| M3b | `createChatModel()`을 try/catch로 삼켜 조용히 뜨기 | 사망 | `server-wiring.spec.ts` — 위 + "try/catch로 삼키지 않는다"(A6, 2건) |
| M4 | `temperature: 0` 추가 | 사망 | 소스 가드(A3) + `complete()` "요청에 싣지 않는다" — **2개 경로** |
| M5 | `timeout`·`maxRetries` 미전달(SDK 기본값 = 3회 시도) | 사망 | `anthropic.spec.ts` A7 시도 횟수 실측 2건 |
| M6 | 테스트가 fixture 대신 `globalThis.fetch` 사용 | 사망 | `no-hardcoded-model.spec.ts` — "llm 테스트는 네트워크를 타지 않는다"(A10) |
| M7 | `tool_choice: {type:"any"}`로 도구 강제 | 사망 | `anthropic.spec.ts` — "tool_choice로 강제하지 않는다"(A9) |
| M8 | 도구 미선택을 `LlmError`로 접기 | 사망 | `anthropic.spec.ts` — "빈 배열이다(에러가 아니다)"(A8) 외 2건 |
| M9 | `ANTHROPIC_MODEL` 기본값 폴백 | 사망 | 소스 가드(A2) + `config.spec.ts` MODEL_MISSING 2건 — **2개 경로** |
| M10 | `ANTHROPIC_API_KEY` 없어도 통과 | 사망 | `config.spec.ts` — API_KEY_MISSING 2건(A5) |
| M11 | fallback 갈래의 `redactSecret` 호출 제거 | 사망* | `anthropic.spec.ts` — "잘린 조각조차 새지 않는다"(A4) |
| M12 | 조각 마스킹을 전체 일치 마스킹으로 되돌리기 | 사망 | `redactSecret` — "잘린 조각(앞 10자)도 지운다" 외 1건 |

\* **M11은 처음에 생존했다.** 그 생존이 유출 프로브를 부른 계기이고, 프로브가 실제 갈래를
찾아낸 뒤 테스트를 추가해 죽였다. 위 "이 태스크에서 실제로 잡은 것" 참조.

**생존 1종 — M2b: `APIError` 갈래의 `redactSecret` 호출 제거.**
**동등 뮤턴트다.** 그 갈래의 메시지는 `status`·`type`·`requestID` 세 값으로만 조립되고
셋 중 어느 것도 자격증명을 담을 수 없다(응답 상태·에러 타입·서버가 발급한 요청 ID).
마스킹은 그 자리에서 **관측 가능한 동작을 바꾸지 않는다.** 그럼에도 호출을 남긴 이유는
누군가 진단을 위해 본문을 한 줄 옮기는 순간 그 겹이 유일한 방어선이 되고, 그 변경은
리뷰에서 무해해 보이기 때문이다 — M2가 정확히 그 변경이었고 마스킹이 없었다면 통과했을 것이다.
