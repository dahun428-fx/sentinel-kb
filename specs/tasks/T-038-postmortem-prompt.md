# T-038: MCP `postmortem-interview` 프롬프트
refs: specs/07-mcp.md §Prompts, specs/00-product.md FR-09, .claude/skills/postmortem-schema/SKILL.md
M: M3 | deps: T-015

`specs/07-mcp.md`의 `## Prompts` 절(`postmortem-interview` 1개)을 **어느 태스크도 인수하지 않았다.**
T-014는 도구 0개, T-015는 도구 5종만 다뤘고 둘 다 프롬프트를 Scope에 넣지 않았다.
그 결과 MCP `prompts` capability가 아무 데서도 서지 않는다 — 스펙이 요구하는 표면이 통째로 비어 있다.

## Scope
- `packages/mcp/src/prompts/postmortem-interview.md`: 프롬프트 본문.
  **코드에 인라인하지 않는다** — 도구 description과 같은 계약물이라 버전 관리 대상이다
  (T-018의 `prompts/answer.md` 분리와 같은 규약).
- `packages/mcp/src/prompts/index.ts`: `registerAllPrompts()` + 프롬프트 개수 부팅 가드
- `packages/mcp/src/server.ts`: 팩토리에서 프롬프트 등록 → `prompts` capability 광고
- 실제 MCP SDK 클라이언트로 `prompts/list`·`prompts/get`을 호출하는 통합 테스트

## Out of scope
- 신규 도구 (도구는 5개 그대로다 — specs/07, CLAUDE.md 금지 사항)
- `packages/contracts` 수정 (섹션 필드는 있는 그대로 쓴다, G3)
- 프롬프트 인자 (아래 D-1: 인자 0개로 간다)
- resources capability, prompt completion(`completable`)
- Web UI 쪽 포스트모템 위저드 (FR-09 P2의 나머지 절반)

## Acceptance
- [ ] `prompts/list`가 정확히 1개, 이름 `postmortem-interview`를 반환한다 (SDK 클라이언트 통합 테스트)
- [ ] `initialize` 응답의 `capabilities.prompts`가 정의돼 있다 (`getServerCapabilities()?.prompts`)
- [ ] `prompts/get`이 반환하는 텍스트가 `postmortem-interview.md` 파일 내용과 **정확히 일치**한다
      (인라인 복제·문자열 조립 금지)
- [ ] 프롬프트 텍스트가 `IncidentInput`/`DivergenceInput`의 **모든 섹션 필드 키**를 포함한다.
      기대 목록은 상수가 아니라 contracts 스키마의 `shape`에서 뽑는다 — 필드가 늘면 테스트가 먼저 죽는다
- [ ] 질문 순서가 텍스트 안에서 강제된다: `symptom` < `rootCause` < `resolution` < `prevention`,
      `expected` < `actual` < `correction`, `search_knowledge` < `record_knowledge` (문자열 인덱스 비교)
- [ ] 필수 절(순서 근거 / 검색 먼저 / 관측 / 종류 판별 / incident·divergence 갈래 / 제목·태그 /
      저장 전 점검 / 저장)이 모두 존재한다. 필드 이름 단언만으로는 이 절들을 통째로 지워도
      살아남는다(뮤테이션 실측 확인)
- [ ] `prompts/list` 항목에 `arguments`가 없다 — 사용자 입력이 프롬프트 응답으로 들어가는 경로가 0이다 (NFR-05)
- [ ] `tools/list`가 여전히 정확히 5개다 (프롬프트를 도구로 만들지 않았다는 증거)
- [ ] stdio와 HTTP가 같은 `prompts/list`·`prompts/get`·`capabilities`를 낸다
- [ ] 프롬프트 토큰 추정치가 `PROMPT_TOKEN_BUDGET` 이하다 (`estimateTokens`, packages/mcp/src/tools/format.ts)
- [ ] `pnpm verify` 그린

## Context budget
- 읽기: specs/07-mcp.md, specs/00-product.md(FR 표), specs/tasks/README.md,
  specs/tasks/T-014-mcp-skeleton.md, specs/tasks/T-018-generator.md(프롬프트 파일 분리 규약만),
  packages/mcp/src/**, packages/contracts/src/record.ts,
  packages/core/seed/**, docs/analysis/T-004-POSTMORTEM.md,
  .claude/skills/postmortem-schema/SKILL.md, .claude/skills/mcp-tool-conventions/SKILL.md
- 쓰기: packages/mcp/src/prompts/**, packages/mcp/src/server.ts, packages/mcp/src/index.ts, specs/tasks/**

## 결정 (비준 대기)

- **D-1. 프롬프트 인자는 0개다.** 두 가지 이유가 겹친다.
  (1) **NFR-05.** 인자를 받으면 `prompts/get` 응답에 호출자 문자열을 끼워 넣는 경로가 생기고,
  그 순간 프롬프트는 `get_record`처럼 data 래핑이 필요한 표면이 된다. 인자가 없으면 응답이
  **파일 내용 그대로인 상수**라 래핑할 외부 텍스트 자체가 존재하지 않는다.
  (2) **인자로 받을 만한 값이 `type` 하나인데, 그걸 미리 묻는 것이 이 프롬프트가 막으려는 바로 그 실수다.**
  무엇이 관측됐는지 말하기 전에 "이건 divergence야"를 고르면 이후 모든 질문이 그 틀에 갇힌다.
  종류 판별은 인터뷰 2단계에 있고, 1단계 관측에서 **데이터로** 갈라져야 한다.
  → 나중에 인자를 붙인다면 **열거형만** 허용하고 자유 텍스트는 금지한다.

- **D-2. `prompts` capability는 `tools`와 달리 스캐폴딩이 필요 없다.**
  T-014 F-7이 `ensureToolListing`(등록→삭제)을 쓴 이유는 **도구가 0개**여서였다.
  SDK(`server/mcp.js`)는 `registerPrompt`가 `setPromptRequestHandlers()`를 부르고 거기서
  `registerCapabilities({prompts:{listChanged:true}})`를 다는데, 이 태스크는 프롬프트를
  **1개 실제로 등록**하므로 capability가 정상 경로로 선다. 등록→삭제 관용구를 복제하지 않는다.

- **D-3. 개수 상한을 부팅에서 강제한다(`MAX_PROMPTS = 1`).**
  `createMcpServer`가 도구 5개를 `!==`로 잠근 것과 같은 이유다. specs/07은 프롬프트도
  "`postmortem-interview` 1개만"이라고 못박았다. 테스트에서만 세면 프로덕션 경로는 2개째를
  통과시킨다.

## Findings

- **F-1. specs/07의 `## Prompts` 절은 이름과 한 줄 설명뿐이다.** 도구 5종은 인자·응답·경계까지
  계약으로 적혀 있는데 프롬프트는 그렇지 않다. 그래서 "인자 0개"(D-1)나 "질문 순서"는
  스펙 문면이 아니라 **이 태스크의 결정**이다. 비준되면 specs/07에 반영해야 한다.
- **F-2. FR-09(포스트모템 위저드)는 P2이고 UI 쪽 절반이 남는다.** 이 태스크는 MCP 표면만 채운다.
- **F-3. `eval:tools`는 도구 선택만 본다 — 프롬프트 품질을 재는 eval이 없다.**
  프롬프트 텍스트가 나빠져도 어떤 게이트도 울지 않는다. 지금 방어선은 통합 테스트의
  필수 필드·순서 단언뿐이다.
