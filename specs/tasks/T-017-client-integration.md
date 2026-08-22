# T-017: 클라이언트 연결 문서 + .mcp.json 배포

refs: specs/07-mcp.md (도그푸딩)
M: M3 | deps: T-015

## Scope

- `docs/connect.md`: .mcp.json 예시, 키 발급 절차, 프로젝트 CLAUDE.md에 넣을 프로토콜 문구
- 실제 프로젝트 2곳에 연결 적용 (자기 자신 포함)
- 연결 확인용 `pnpm mcp:ping` 스크립트

## Out of scope

- UI

## Acceptance

- [ ] 다른 프로젝트의 Claude Code 세션에서 search_knowledge 호출 성공 스크린샷/로그가 docs에 첨부
- [ ] `pnpm mcp:ping`이 원격 서버 도구 목록 5개를 출력
- [ ] 이 레포 CLAUDE.md에 도그푸딩 프로토콜이 반영됨
- [ ] `pnpm verify` 그린

## Context budget

- 읽기: specs/07, docs/**, CLAUDE.md

---

STATUS: PARTIAL — Acceptance 2·3·4 충족. **Acceptance 1은 판정 불가**(배포된 서버 없음).

## 구현 (feat/T-017-client-docs)

- `.mcp.json` (신규, 루트): `sentinel-kb`(Streamable HTTP) + `sentinel-kb-local`(stdio) 두 항목.
  값은 전부 `${VAR}` 참조 — 시크릿 리터럴 없음.
- `docs/connect.md`: 전송 2종, 키 발급, **MCP↔core-api `API_KEYS` 동일성 함정**,
  stdio 부팅 거부 동작, stdout 순수성, MCP env 6종, 도구 5종(스텁 한계 명시),
  프로젝트 CLAUDE.md 프로토콜 문구, `mcp:ping` 종료 코드표, 진단표.
- `scripts/mcp-ping.ts` + `scripts/mcp-ping.cli.ts` + 루트 `package.json`의 `mcp:ping`:
  SDK 의존 없이 `fetch`로 `initialize` → `notifications/initialized` → `tools/list`.
  **판정은 종료 코드로 한다** (0 / 1 / 69 / 70 / 76 / 77 / 78 — 아래 D-2).
- `scripts/mcp-ping.spec.ts`: fetch 주입 유닛 테스트 37개. 실패 갈래마다 종료 코드가
  실제로 갈리는지를 단언한다.
- `tools/connect-docs.spec.ts`: 문서 가드 10개. 뮤테이션으로 실제 물림을 확인했다.
- `README.md`: 연결 문서 포인터.

## Acceptance 판정

1. **판정 불가.** 다른 프로젝트 세션의 `search_knowledge` 호출 로그를 첨부하려면 배포된 서버가
   필요하다. 이 브랜치의 base(`main`)에는 T-014·T-015가 없어 `packages/mcp`가 스텁이고,
   호출할 서버 자체가 존재하지 않는다. **로그를 지어내지 않았다.**
   → T-014·T-015 머지 + 배포 후 별도 세션에서 수행할 것.
2. **충족(대리 검증).** `pnpm mcp:ping` 구현. 진짜 sentinel-kb 서버는 아직 없으므로 일회성
   가짜 MCP 서버(스크래치패드, 레포에 커밋되지 않음)로 CLI를 직접 돌려 종료 코드를 확인했다:
   도구 5개→`0`(이름 5개 stdout 출력), 4개→`1`, URL 미설정→`78`, 서버 미기동→`69`,
   경로 오류→`76`, 401→`77`. `text/event-stream` 프레이밍도 통과.
   **원격 실서버를 상대로는 아직 돌려 보지 못했다** — 그건 Acceptance 1과 같은 조건에 묶여 있다.
3. **충족.** `CLAUDE.md`의 "도그푸딩 프로토콜 (M3 이후)" 절에 이미 반영돼 있다(변경 불필요).
   `docs/connect.md` §6이 이 문구를 다른 프로젝트로 복제하는 절차를 문서화한다.
4. **충족.** `pnpm verify` 그린 (716 unit + 101 integration).
   단, 이 verify는 **MCP 서버 동작을 판정하지 않는다** — 이 worktree에 MCP 구현이 없다.

## 결정

- **D-1 (`mcp:ping`을 SDK 없이 fetch로).** 루트에 `@modelcontextprotocol/sdk`를 추가하면
  lockfile이 바뀌어 `packages/mcp`를 고치는 병렬 브랜치와 충돌한다. ping이 필요로 하는 것은
  두 왕복뿐이라 프레임을 손으로 만드는 값이 더 싸다. 전송 계약 자체의 검증은 SDK 클라이언트를
  쓰는 `packages/mcp`의 통합 테스트가 이미 한다.
- **D-2 (종료 코드를 여럿으로).** "연결이 안 된다"(69)와 "붙었는데 도구가 5개가 아니다"(1)는
  **다른 사건이고 다른 사람이 고친다.** 하나의 exit 1로 뭉뚱그리면 자동화가 아무것도 가를 수
  없다. `seed.cli.ts`의 sysexits 규약을 이었다.
- **D-3 (시크릿 방어선 둘).** 라이브러리가 원본 오류 객체를 절대 싣지 않고(cause의 `code`만 뽑음),
  CLI가 출력 직전 `redactSecrets`로 한 번 더 훑는다. T-014에서 `console.error(error)`가 API 키를
  통째로 덤프한 전례가 있고, fetch 오류의 `cause`에 무엇이 담길지는 우리가 통제하지 못한다.
  키를 URL 자리에 잘못 넣은 경우까지 고려해 URL 파서 오류도 원문을 싣지 않는다.

## Findings

- **F-1 (해소됨).** `pnpm mcp:ping` 보류는 코디네이터 판단으로 해제됐다 — 범위 제한의 실제 사유가
  `packages/**` 충돌이었고 `scripts/`·루트 `package.json`은 거기 해당하지 않는다. 구현 완료.
- **F-1b (`mcp:ping`은 HTTP만 확인한다).** stdio 전송은 ping하지 않는다. stdio ping은
  `packages/mcp/src/stdio.cli.ts`를 spawn해야 하는데 이 브랜치에서는 그게 스텁이라
  **한 줄도 검증할 수 없는 코드가 된다.** 문서(§8-1)에 이 한계를 명시했다.
  stdio 쪽 실패 모드(배너 오염·부팅 거부)는 `packages/mcp`의 통합 테스트가 실제 spawn으로 덮는다.
- **F-1c (`pnpm mcp:ping`의 stdout도 오염된다).** F-3과 같은 함정을 ping 자신도 밟는다 —
  실측 확인: `pnpm mcp:ping`의 stdout에는 pnpm 실행 헤더가 섞이고 `pnpm --silent mcp:ping`은
  깨끗하다. 그래서 판정을 종료 코드로 두고, 문서에 `--silent`를 명시했다.
- **F-1d (CLAUDE.md 명령어 표).** `CLAUDE.md`의 "명령어" 절에 `pnpm mcp:ping`이 없다.
  CLAUDE.md는 이 세션의 변경 범위 밖이라 손대지 않았다 — 다음 태스크에서 한 줄 추가할 것.
- **F-2 (`.env.example` 누락, T-014 F-2 재확인).** `SENTINEL_KB_KEY`·`CORE_API_URL`·
  `CORE_API_TIMEOUT_MS`·`CORE_API_MAX_ATTEMPTS`가 `.env.example`에 없다. 이번에도 범위 밖이라
  넣지 못했고, 대신 `docs/connect.md` §5가 정본 표 역할을 한다. T-026에서 compose env와 함께 추가.
- **F-3 (`pnpm run`이 stdout을 오염시킨다).** 이 레포에서 확인: `pnpm run <script>`는 실행 헤더를
  **stdout**으로 낸다. stdio 전송에서는 이 한 줄이 JSON-RPC 파서를 깨뜨린다.
  `.mcp.json`은 `pnpm exec`를 쓰고, 가드 테스트가 `pnpm run` 회귀를 막는다. F-1c도 같은 뿌리다.
- **F-4 (`specs/07` 개정 후보).** specs/07 §"클라이언트 연결"의 `.mcp.json` 예시에 stdio 항목이
  없고, MCP↔core-api `API_KEYS` 동일성 제약도 어디에도 적혀 있지 않다. 지금은 `docs/connect.md`가
  그 자리를 메우고 있으나, 배포 제약은 스펙에 있어야 한다 → 스펙 개정 제안(인간 승인 필요).
- **F-5 (도그푸딩 프로젝트 2곳 중 1곳만).** Scope의 "실제 프로젝트 2곳"에서 자기 자신(이 레포)만
  적용했다. 두 번째 프로젝트는 이 레포 밖의 파일을 고치는 일이라 이 PR의 범위가 아니다.
