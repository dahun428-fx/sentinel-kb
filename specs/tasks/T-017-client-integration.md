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

STATUS: PARTIAL — 문서·설정 부분 완료. Acceptance 1·2는 미충족(아래 근거).

## 구현 (feat/T-017-client-docs)

- `.mcp.json` (신규, 루트): `sentinel-kb`(Streamable HTTP) + `sentinel-kb-local`(stdio) 두 항목.
  값은 전부 `${VAR}` 참조 — 시크릿 리터럴 없음.
- `docs/connect.md`: 전송 2종, 키 발급, **MCP↔core-api `API_KEYS` 동일성 함정**,
  stdio 부팅 거부 동작, stdout 순수성, MCP env 6종, 도구 5종(스텁 한계 명시),
  프로젝트 CLAUDE.md 프로토콜 문구, 검증·진단표.
- `tools/connect-docs.spec.ts`: 문서 가드 10개. 뮤테이션으로 실제 물림을 확인했다.
- `README.md`: 연결 문서 포인터.

## Acceptance 판정

1. **미충족.** 다른 프로젝트 세션의 `search_knowledge` 호출 로그를 첨부하려면 배포된 서버가
   필요하다. 이 브랜치의 base(`main`)에는 T-014·T-015가 없어 `packages/mcp`가 스텁이고,
   호출할 서버 자체가 존재하지 않는다. **로그를 지어내지 않았다.**
   → T-014·T-015 머지 + 배포 후 별도 세션에서 수행할 것.
2. **미충족(보류).** `mcp:ping` 미구현 — F-1.
3. **충족.** `CLAUDE.md`의 "도그푸딩 프로토콜 (M3 이후)" 절에 이미 반영돼 있다(변경 불필요).
   `docs/connect.md` §6이 이 문구를 다른 프로젝트로 복제하는 절차를 문서화한다.
4. **충족.** `pnpm verify` 그린 (679 unit + 101 integration).
   단, 이 verify는 **MCP 동작을 판정하지 않는다** — 이 worktree에 MCP 구현이 없다.

## Findings

- **F-1 (`pnpm mcp:ping` 보류).** Scope 3번을 구현하지 않았다. 이 세션의 지시가 변경 범위를
  "문서와 설정 파일(`docs/`, `.mcp.json`, `README.md`, 이 태스크 파일)"로 한정하고
  "코드 수정이 꼭 필요하면 멈추고 보고하라"고 명시했다. `mcp:ping`은 `scripts/mcp-ping.ts` +
  루트 `package.json` 스크립트 항목이 필요하다. 임의로 고르지 않고 보고한다.
  설계는 정해져 있다: SDK 의존 없이 `fetch`로 `initialize` → `tools/list`를 던지고 이름 5개를
  출력한다(루트에 `@modelcontextprotocol/sdk`를 추가하면 lockfile이 바뀌어 병렬 브랜치와 충돌).
- **F-2 (`.env.example` 누락, T-014 F-2 재확인).** `SENTINEL_KB_KEY`·`CORE_API_URL`·
  `CORE_API_TIMEOUT_MS`·`CORE_API_MAX_ATTEMPTS`가 `.env.example`에 없다. 이번에도 범위 밖이라
  넣지 못했고, 대신 `docs/connect.md` §5가 정본 표 역할을 한다. T-026에서 compose env와 함께 추가.
- **F-3 (`pnpm run`이 stdout을 오염시킨다).** 이 레포에서 확인: `pnpm run <script>`는 실행 헤더를
  **stdout**으로 낸다. stdio 전송에서는 이 한 줄이 JSON-RPC 파서를 깨뜨린다.
  `.mcp.json`은 `pnpm exec`를 쓰고, 가드 테스트가 `pnpm run` 회귀를 막는다.
- **F-4 (`specs/07` 개정 후보).** specs/07 §"클라이언트 연결"의 `.mcp.json` 예시에 stdio 항목이
  없고, MCP↔core-api `API_KEYS` 동일성 제약도 어디에도 적혀 있지 않다. 지금은 `docs/connect.md`가
  그 자리를 메우고 있으나, 배포 제약은 스펙에 있어야 한다 → 스펙 개정 제안(인간 승인 필요).
- **F-5 (도그푸딩 프로젝트 2곳 중 1곳만).** Scope의 "실제 프로젝트 2곳"에서 자기 자신(이 레포)만
  적용했다. 두 번째 프로젝트는 이 레포 밖의 파일을 고치는 일이라 이 PR의 범위가 아니다.
