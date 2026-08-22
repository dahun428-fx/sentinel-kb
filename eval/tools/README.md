# tool-selection eval 러너 (T-016)

specs/05 "Eval 3: Tool-selection" 구현. **지금은 측정할 수 없다** — 아래 `## 왜 지금 재지 못하나`를 읽어라.

## 이 러너가 존재해야 하는 이유

`specs/07`이 못박는다:

> description 변경은 계약 변경이다 → tool-selection eval 재실행 필수 (G6).

그런데 **그 eval이 없었다.** 즉 G6 조항은 이행 불가였다. 이 디렉터리가 그 구멍을 닫는다.

## 무엇이 있나

| 파일 | 역할 |
|---|---|
| `scenarios.json` | 시나리오 20건 `{id, prompt, expectedTool, requiredArgs[], expectedArgs?, boundary}` |
| `scenarios.ts` | 로더 + **실물 계약 대조**(없는 도구·없는 인자를 요구하면 죽는다) |
| `catalog.ts` | `createMcpServer`에서 도구 5종의 description·인자를 **실물로** 읽는다 + 계약 지문 |
| `selector.ts` | "도구 목록을 주고 모델이 고르게 한다"의 경계면. **실 구현은 아직 없다** |
| `score.ts` | 채점(올바른 도구 + 필수 인자) + 집계 + 오답 표(`confusions`) |
| `run.ts` | 시나리오 × selector × 반복 → `ToolsReport` |
| `report.ts` | 리포트 zod 스키마 + `eval/reports/YYYY-MM-DD-tools.json` 규약 |
| `baselines.ts` | `eval/baselines.json` **읽기 전용** (쓰기 경로가 없다) |
| `baseline-guard.ts` | 기준선 대조 → 종료 코드 0 / 1 / 78 |
| `run.cli.ts` | `pnpm eval:tools` |
| `check-baseline.cli.ts` | `pnpm eval:tools:check <report>` — 가드만 단독 실행 |

## 종료 코드

| 코드 | 뜻 |
|---|---|
| 0 | 판정했고 기준선 이상 |
| 1 | **기준선 하락** — specs/05 G4, 머지 금지 |
| 69 | EX_UNAVAILABLE — 모델 호출이 실패해 재지 못함 |
| 78 | EX_CONFIG — **잴 수 없음**(selector 부재, 시나리오·계약 불일치, 리포트 손상) |

78과 0을 가른 것이 요점이다. "판정 불가"를 0으로 끝내면 selector 없이 돌린 CI가 통과로 읽히고,
G6가 요구하는 재실행이 아무것도 검사하지 않은 채 통과 도장을 찍는다.

## 왜 지금 재지 못하나 (2026-08-23)

자격증명 문제가 **아니다.** 키를 넣어도 오늘은 못 잰다. 둘 다 없다:

1. **tool-calling 가능한 `ChatModel`이 없다.** `packages/core/src/llm/types.ts`의 `ChatRequest`는
   `{system, messages, maxTokens}`뿐이라 **도구를 실을 자리도, 도구 호출을 돌려받을 자리도 없다.**
   CLAUDE.md는 LLM 호출을 `packages/core/src/llm/` 경유로만 허용하므로, 이 인터페이스가 넓어져야 한다.
2. **실 provider 구현이 없다.** 같은 파일의 결정 D-2가 "실 provider는 T-019의 몫"으로 넘겨 뒀고,
   LLM SDK가 lockfile에 없다. 의존성 추가는 T-016 Scope가 아니다.

그래서 `pnpm eval:tools`는 **아무것도 재지 않고 78로 끝난다.** `eval/baselines.json`의
`tools.selectionAccuracy = 0.85`는 **건드리지 않았다** — 측정하지 않은 숫자를 기준선으로 쓰지 않는다.
specs/05가 말하는 "최종 목표 0.9"도 여기 쓰지 않았다. 재고 나서 사람이 정한다.

## ⚠️ 기준선을 확정하기 전에 **비준이 먼저다** (G6)

지금 도구 계약에는 인간 승인을 기다리는 이탈이 4건 있다:

1. `search_knowledge`의 `limit`을 3으로 클램프 (`specs/07:10`은 기본 5, 상한 미정 — T-015 F-1)
2. 응답에서 절대 `score` 제거 (`specs/07:11`은 `score` 포함)
3. 응답이 JSON이 아니라 **평문** 렌더링 (`specs/07:11`의 응답 형상과 다름)
4. `get_record`가 `relations`를 함께 낸다 (`specs/07:16`의 "전체 레코드"에 없던 필드)

넷 다 **description에 문장으로 적혀 있다** — 예: `search_knowledge`의 "절대 점수는 제공하지 않는다",
"서버가 3건으로 줄여서 낸다". 비준 결과가 이 문장들을 바꾸면 이 eval이 재는 대상이 바뀌고,
그 전에 잰 수치는 기준선이 될 수 없다. 러너는 이 사실을 리포트 `warnings`에 **조건 없이** 싣는다.

## 잴 수 있게 되면 — 무엇을 하면 되나

1. **`ChatModel`에 도구 호출을 넣는다 (G3, 인간 승인).** `ChatRequest`에 도구 정의를,
   `ChatResponse`에 도구 호출(이름 + 인자)을 실을 자리를 만든다. contracts가 아니라 core의
   인터페이스라 breaking 범위는 좁지만, LLM 계층의 계약이므로 승인 사항이다.
2. **실 provider를 붙인다.** `packages/core/src/llm/types.ts` D-2가 "공식 SDK를 써야 한다"고
   근거까지 적어 뒀다(raw fetch 선례를 LLM 쪽으로 복사하지 마라). 자격증명은 SSM/.env로만.
3. **`eval/tools/selector.ts`의 `resolveSelector`에 분기를 붙인다.** `EVAL_TOOL_SELECTOR=<provider>`.
   그 selector의 `provenance.trusted`는 `isTrustedSelector`가 정한다 — 손으로 `true`를 쓰지 마라.
4. **`pnpm eval:tools`를 돌리고 리포트를 커밋한다.** `eval/reports/YYYY-MM-DD-tools.json`.
5. **기준선을 확정한다 — 사람이.** 위 비준 4건이 끝난 **뒤에**. 에이전트는 리포트만 낸다(eval-runner 스킬).

## 시나리오를 고칠 때

- **점수를 올리려고 시나리오를 고치지 마라.** 오답이 나오면 고칠 곳은 description이고(별도 태스크),
  그것도 T-016 Out of scope다. 시나리오를 고쳐야 하는 경우는 "기대 자체가 틀렸다"는 근거가 있을 때뿐이다.
- **도구 없음(`expectedTool: null`) 케이스를 빼지 마라.** 전부 무언가를 불러야 하는 골든셋은
  에이전트가 아무거나 부르는 실패를 구조적으로 잡지 못한다. `scenarios.spec.ts`가 이걸 잠근다.
- `requiredArgs`는 **도구 스키마의 `required`가 아니다.** "이 요청을 제대로 처리하려면 채웠어야 하는
  인자"다. 예: `record_knowledge.symptom`은 스키마상 optional이지만 incident 기록 시나리오에서는 필수다.

## 그다음에 재야 할 것 (인계된 Findings)

- **`byExpectedTool`의 도구별 격차.** 어떤 도구의 description이 경계를 못 긋는지가 여기서 나온다.
  description 최적화 태스크는 이 표를 근거로 시작해야 한다(추측으로 문장을 고치지 마라).
- **`stability`가 1.0이 아니면 그 수치로 기준선을 만들지 마라.** 같은 프롬프트에 답이 흔들리면
  재실행마다 판정이 달라진다(T-013이 `ambiguousTieCount`에 대해 세운 규칙과 같다).
- **`give_feedback.query`.** `specs/07:35`의 인자 목록에서 빠져 있는데 HTTP 계약은 필수다(T-015 F-2).
  TS-10·TS-11이 이걸 채점하므로, 스펙 문면이 정정되기 전까지 이 두 건의 오답은 **스펙 결함의 관측치**다.
