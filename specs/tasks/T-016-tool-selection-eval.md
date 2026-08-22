# T-016: tool-selection eval 러너 + 시나리오 20
refs: specs/05-test-strategy.md (Eval 3)
M: M3 | deps: T-015

STATUS: BLOCKED
사유: **Acceptance 1(정확도 >= 0.85)은 측정 자체가 불가능하다.** 자격증명 문제가 아니라
  레포에 도구 선택을 물어볼 수 있는 모델 클라이언트가 없다 — 키를 넣어도 오늘은 못 잰다.
실패 로그:
  - `packages/core/src/llm/types.ts`의 `ChatRequest`는 `{system, messages, maxTokens}`뿐이다.
    **도구를 실을 자리도, 도구 호출을 돌려받을 자리도 없다.** CLAUDE.md는 LLM 호출을
    `packages/core/src/llm/` 경유로만 허용하므로 이 인터페이스가 넓어져야 한다(계약 변경).
  - 같은 파일 결정 D-2가 "실 provider는 컴포지션 루트가 모델을 무는 태스크(T-019)의 몫"으로
    넘겨 뒀고, LLM SDK가 lockfile에 없다. 의존성 추가는 T-016 Scope 밖이다.
  - 그래서 `pnpm eval:tools`는 아무것도 재지 않고 **exit 78(EX_CONFIG)**로 거절한다.
    `--allow-oracle-selector`로 파이프라인을 돌려도 정확도 1.0에 **여전히 78**이다(실측).
필요한 결정: **(1) `ChatModel`에 도구 호출을 넣는 계약 확장(G3, 인간 승인), (2) 실 provider +
  자격증명 주입.** 그리고 그 전에 **G6 비준 4건**(아래 F-1)이 먼저다 — 비준 결과가 description을
  바꾸면 그때 잰 수치는 기준선이 될 수 없다. `eval/baselines.json`은 손대지 않았다.

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
