# T-016: tool-selection eval 러너 + 시나리오 20
refs: specs/05-test-strategy.md (Eval 3)
M: M3 | deps: T-015

STATUS: BLOCKED (사유 축소됨 — 자격증명 대기)
사유: **Acceptance 1(정확도 >= 0.85)은 아직 측정되지 않았다.** 다만 이유가 바뀌었다:
  이제는 **자격증명이 없어서** 못 잰다. 키를 넣으면 잰다.
필요한 결정: **`ANTHROPIC_API_KEY`·`ANTHROPIC_MODEL` 주입**(사람). 그리고 그 전에
  **G6 비준 4건**(아래 F-1)이 먼저다 — 비준 결과가 description을 바꾸면 그때 잰 수치는
  기준선이 될 수 없다. `eval/baselines.json`은 여전히 손대지 않았다.

### 배선 완료 (2026-08-23, `feat/A-1-tool-eval-wiring`)
**위 STATUS의 옛 문장 — "자격증명 문제가 아니라 레포에 도구 선택을 물어볼 수 있는 모델
클라이언트가 없다 — 키를 넣어도 오늘은 못 잰다" — 은 이제 거짓이다.** T-039가
`ToolChoiceModel.selectTool()`과 `createToolChoiceModel()`을 세웠고(D-7), A-1이 러너를 거기에
물렸다. 두 태스크가 다른 브랜치에서 만들어져 연결만 빠져 있었다(T-039 F-2가 지목한 그 간극).

78의 사유가 실제로 바뀐 것을 명령으로 확인했다:

| | 배선 전 | 배선 후 |
|---|---|---|
| 자격증명 없음 | 78 — "tool-calling 가능한 ChatModel이 없다 / 실 provider 구현이 없다 … 키를 넣어도 잴 수 없다" | 78 — "**자격증명·모델 설정이 없다.** 사유: ANTHROPIC_MODEL이 설정되지 않았다 … 채우면 잰다" |
| 가짜 키 주입 | 78 (모델을 부르는 코드가 없으므로 같은 자리에서 죽는다) | **69** — `SELECTOR_CALL_FAILED: … Anthropic 요청이 실패했다(status=401, type=authentication_error)` — **실제로 호출이 나갔다** |

69는 "선택률이 떨어졌다"가 아니라 "재지 못했다"이므로 리포트를 쓰지 않는다(T-013 규약).
401 메시지에 키가 실리지 않는 것도 그 자리에서 확인된다(T-039 D-10).

옛 사유를 잠그고 있던 두 단언을 **새 사실로 갱신**했다(코드 78은 그대로 둔 채 사유만):
`run.cli.spec.ts`의 "무엇이 없어서 못 재는지" 항목과 `args.spec.ts`의 같은 항목.
둘 다 "자격증명만의 문제가 아니다"를 단언하고 있었고, 그 문장이 거짓이 된 뒤에도
새 메시지가 우연히 `tool-calling`·`packages/core/src/llm`을 포함해 **초록으로 통과했다** —
그대로 두면 의도가 뒤집힌 생존자를 숨기는 셈이라 사유 단언을 바꿨다.

- Acceptance 1 (정확도 >= 0.85) **여전히 미측정** — 자격증명 대기 + G6 비준 4건 선행.
- Acceptance 2·3·4는 T-016이 이미 PASS로 남겼고 이 브랜치에서도 그대로다.

### 부분 구현 (2026-08-23, `feat/T-016-tool-eval`)
**STATUS는 BLOCKED 그대로다.** Acceptance 1은 여전히 **판정 불가**다.
모델 없이 판정 가능한 나머지 셋만 구현했다 — selector가 붙으면 바로 돌릴 수 있는 러너다.
- Acceptance 2 (오답이 무엇을 골랐는지 리포트에 기록) **PASS** —
  `cases[].attempts[].chosenTool` + `confusions[]`. `run.spec.ts`·`score.spec.ts`가 잠근다.
- Acceptance 3 (기준선 하락 시 exit 1) **PASS** — `pnpm eval:tools:check`가 실제 프로세스에서
  0.7→**1** / 0.95→**0** / 0.85(동률)→**0** / 오라클 1.0→**78**을 낸다(양방향 잠금).
- Acceptance 4 (`pnpm verify` 그린) **PASS** — lint + typecheck + unit 1431 + integration 255.

## Scope
- `eval/tools/scenarios.json`: 20개 시나리오 `{prompt, expectedTool, requiredArgs[]}`
- 러너: 도구 목록만 제시하고 모델이 고른 도구·인자 채점, 각 3회 반복해 안정성 측정
- `pnpm eval:tools`, 리포트 `eval/reports/{date}-tools.json`
- baselines.json에 tool-selection 기준선 추가

## Out of scope
- description 최적화 자체 (별도 태스크로 분리)

## Acceptance
- [ ] 정확도 >= 0.85 (M3 기준선, 최종 목표 0.9)
- [ ] 오답 케이스가 리포트에 어떤 도구를 잘못 골랐는지 함께 기록됨
- [ ] 기준선 하락 시 exit 1
- [ ] `pnpm verify` 그린

## Context budget
- 읽기: specs/05 Eval3, specs/07, eval/tools/**

## Findings (T-016에서 남김)

- **⚠️ F-1. G6 비준 4건이 기준선 확정보다 먼저다 — 지금 잰 수치는 무엇이든 잠정이다.**
  `specs/07`의 도구 계약과 `packages/mcp` 구현이 네 곳에서 갈라져 있고 넷 다 인간 승인 대기다:
  (1) `search_knowledge.limit`을 3으로 클램프(`specs/07:10`은 기본 5, 상한 미정 — T-015 F-1),
  (2) 응답에서 절대 `score` 제거(`specs/07:11`은 `score` 포함),
  (3) 응답이 JSON이 아니라 **평문** 렌더링(`specs/07:11`의 응답 형상과 다름),
  (4) `get_record`가 `relations`를 함께 낸다(`specs/07:16`의 "전체 레코드"에 없던 필드).
  **넷 다 description에 문장으로 적혀 있다** — 예: "절대 점수는 제공하지 않는다",
  "서버가 3건으로 줄여서 낸다". 비준 결과가 그 문장을 바꾸면 이 eval이 재는 대상이 바뀐다.
  러너는 이 사실을 리포트 `warnings`에 **조건 없이** 싣고(`UNRATIFIED_CONTRACT_NOTE`),
  `catalog.descriptionSha256`이 계약이 움직였는지를 기계적으로 드러낸다.

- **F-2. `give_feedback.query`가 `specs/07:35` 인자 목록에서 빠져 있다(T-015 F-2 재확인).**
  구현·HTTP 계약은 필수인데 스펙 문면은 셋(`recordId`, `helped`, `note?`)뿐이다.
  시나리오 TS-10·TS-11이 `query`를 필수 인자로 채점하므로, 문면이 정정되기 전까지 이 두 건의
  오답은 **모델의 실수가 아니라 스펙 결함의 관측치**로 읽어야 한다. `catalog.spec.ts`가
  실물 스키마에서 `query.required === true`를 단언해 이 사실을 상시 노출한다.

- **F-3. `eval/tools/baseline-guard.ts`가 `eval/retrieval/baseline-guard.ts`와 구조적으로 같다.**
  지표 키 집합만 다른 제네릭 가드로 접을 수 있다. 접지 않은 이유는 T-013 소유 파일을 건드리지
  않기 위해서다(최소 diff). eval 계층이 셋(generation·injection)으로 늘 때 한 번에 정리하는 편이 싸다.

- **F-4. 리포트는 모델이 채운 인자 **값**을 싣지 않는다** — 키 목록과 `expectedArgs` 대상 값만
  남긴다. `record_knowledge`의 본문이 리포트에 통째로 박히면 커밋 파일이 부풀고, 시크릿·인젝션
  텍스트가 새니타이저를 거치지 않은 채 리포트 경유로 샌다. 값 전체가 필요해지면 그때는
  `packages/core/src/sanitizer`를 통과시켜야 한다(별도 결정).

- **F-5. 루트 `package.json`에 `@sentinel/mcp` workspace 링크를 더했다(lockfile +3줄).**
  eval이 도구 description을 **실물에서** 읽어야 G6가 성립하기 때문이다(스냅샷은 사본을 재게 된다).
  `scripts/`가 `@sentinel/api`를 무는 것과 같은 컴포지션 루트 예외이며, eslint의 형제 패키지
  금지 zone은 `packages/*`만 대상으로 해 위반이 아니다. 새 외부 의존성은 없다.

## Findings (A-1 배선에서 남김)

- **A-1 F-1. 도구 인자 JSON Schema를 `eval/tools/catalog.ts`에서 직접 파생한다.**
  `selectTool()`은 `ToolSpec.inputSchema`(JSON Schema)를 요구하는데 MCP SDK는 등록된 도구의
  JSON Schema를 공개 API로 노출하지 않는다. `zod-to-json-schema`는 SDK의 **전이 의존성**일 뿐
  선언된 의존성이 아니라 쓰지 않았고(새 의존성 추가는 이 작업 밖), `_registeredTools`에 살아
  있는 Zod 스키마에서 `toJsonSchema()`로 옮긴다. **스냅샷이 아니다** — 스키마가 바뀌면 다음
  실행이 바뀐 형상을 낸다. 못 옮긴 zod 타입은 `{description}`만 남고 `catalog.spec.ts`가
  그런 인자가 0건임을 상시 단언한다(변환기의 구멍이 조용히 나가지 않는다).

- **A-1 F-2. `inputSchema`는 `descriptionSha256`에 들어가지 않는다.** 지문은 T-016이 정한 대로
  이름 + description + 인자(이름·필수여부·description)만 먹는다. 그러나 이제 모델은 **인자
  타입·열거 값**도 본다 — `limit: integer`가 `string`으로 바뀌면 모델의 행동이 바뀌는데
  지문은 그것을 못 본다. 지문의 정의를 넓히는 것은 리포트 비교 규약의 변경이라 이 작업
  범위 밖으로 뒀다. G6를 엄밀히 하려면 다음 태스크가 `fingerprint`에 `inputSchema`를 먹여야 한다.

- **A-1 F-3. 병렬 도구 호출을 세지 않는다.** `toToolChoice`가 `toolUses[0]`만 싣는다.
  `ToolChoice`가 선택 1건만 표현하기 때문이고, `expectedTool: null` 갈래에서는 "무엇이든
  불렀다"가 곧 오답이라 첫 건으로 판정이 갈리지 않는다. 다만 **"맞는 도구 + 불필요한 도구
  하나 더"가 정답으로 집계된다** — 그것을 오답으로 보려면 리포트 스키마(`ToolAttempt`)에
  호출 개수가 들어가야 하고, 그건 별 태스크다.

- **A-1 F-4. 시스템 프롬프트를 한 글자도 싣지 않았다.** specs/05가 "도구 목록만 주고 제시"라고
  못박았고 `tools.ts` 주석도 "Eval 3은 도구 설명만으로 고르게 하는 것이 목적이라 대개 비운다"로
  적어 뒀다. 정확도가 낮게 나오면 프롬프트를 붙여 올리고 싶어지는데, 그 순간 이 eval은
  description이 아니라 **우리가 쓴 힌트**를 재게 된다. `selector.spec.ts`가 `system`이
  `undefined`임을 단언해 그 유혹을 잠근다.

- **A-1 F-5. `renderCatalog()`가 이제 아무도 부르지 않는 경로다**(`catalog.spec.ts` 제외).
  native tool-use로 도구를 싣기 때문이다. 지우지 않은 이유: tool-use를 지원하지 않는 모델로
  같은 골든셋을 재려면(교차 provider 비교) 텍스트 렌더링이 그때의 유일한 수단이다.
  쓰이지 않는 채로 남기는 비용과 지웠다가 다시 쓰는 비용 중 전자를 골랐다 — 다만 **다음에
  아무도 안 쓰면 지우는 것이 맞다.**
