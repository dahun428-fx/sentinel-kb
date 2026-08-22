# T-014: MCP 서버 스켈레톤 + Bearer 인증
refs: specs/07-mcp.md
M: M3 | deps: T-012

## Scope
- `packages/mcp`: MCP SDK 서버, Streamable HTTP `/mcp` + stdio 어댑터(로컬)
- Bearer 인증 미들웨어 → project 클레임을 요청 컨텍스트에 주입
- core-api HTTP 클라이언트(타임아웃·재시도)
- 도구 0개 상태로 initialize/tools list 응답

## Out of scope
- 도구 구현 (T-015)

## Acceptance
- [ ] MCP SDK 클라이언트로 initialize 성공하는 통합 테스트
- [ ] 인증 헤더 없음 → 401
- [ ] stdio 모드에서도 동일 서버 인스턴스가 기동
- [ ] `pnpm verify` 그린

## Context budget
- 읽기: specs/07, packages/mcp/**

## 결정 (비준 대기)

- **D-1. MCP는 core-api를 HTTP로 부른다.** 새 결정이 아니라 **스펙 확인**이다 —
  specs/01의 패키지 표(`mcp/  MCP 서버 (core-api HTTP 소비)`)와 다이어그램(`mcp-server ──▶ core-api` 내부 HTTP)이
  이미 정했다. `@sentinel/core` 직접 호출은 MCP 프로세스에 Mongo 연결·임베딩 자격증명을 들이고,
  새니타이즈·project 강제 같은 쓰기 게이트를 우회한다. → `packages/mcp/src/core-api-client.ts`.
- **D-2. 재시도는 멱등 요청에만.** 클라이언트 표면을 `read()`/`write()`로 갈라 **호출부가 멱등성을 선언**하게 했다.
  기본값은 재시도 없음. `record_knowledge`(T-015)는 `POST /v1/records`이고 타임아웃은 "도달하지 않았다"가 아니라
  **"결과를 모른다"**라, 재전송하면 같은 사건이 레코드 두 벌로 남는다.
- **D-3. 인증 로직은 복제한다.** `mcp → api` import는 형제 간 간선이라 specs/01의 의존 방향 위반이다.
  근거는 **specs/01의 의존 방향 그 자체**이고 툴체인이 아니다 —
  당초 적었던 "`tsc -b` 프로젝트 참조 때문에 스펙 파일에서만 import해도 실제 빌드 그래프 간선이 된다"는
  **반증됐다.** `packages/mcp/tsconfig.json`에 `../api` 참조를 넣지 않고 `@sentinel/api`를 import해도
  `tsc -b` exit 0, eslint exit 0, 런타임 정상이었다(pnpm 워크스페이스가 이미 해석한다).
  즉 **형제 간선을 막는 장치가 아무것도 없었다.** 그 자리를 `eslint.config.js`의
  `import/no-restricted-paths` 형제 zone(api/mcp/worker/web 상호 금지)이 메운다.
  `scripts/`는 컴포지션 루트라 target에서 제외했다(`seed.cli.ts`가 `@sentinel/api`를 부르는 것은 정당하다).
  발화는 `packages/mcp/lint-fixtures/violation-imports-api.ts` + `tools/dependency-boundaries.spec.ts`가 잠근다.
  근본 해법(F-1)은 budget 밖 수정이라 이 태스크에서 불가. 복제의 대가는 `auth.spec.ts`의 **양방향 소스 대조**로 막는다.
- **D-4. 401은 HTTP 레벨에서 나가고, stdio의 인증 실패는 부팅 실패다.**
  MCP 프로토콜에 인증 실패 응답이 없다 — JSON-RPC 에러로 내리면 클라이언트가 세션이 섰다고 믿는다.
  stdio에는 401을 낼 지점 자체가 없으므로, `SENTINEL_KB_KEY`로 project를 확정하지 못하면 **뜨지 않는다.**
  스코프 없이 조용히 뜨는 서버는 로컬 기록을 엉뚱한 project로 보낸다.
  단, **stdio의 부팅 실패 문구는 HTTP의 무오라클 문구와 갈라진다.** HTTP 응답은 그대로 두되
  (원격 요청자에게는 키 유효성 오라클을 주지 않는다), stdio stderr는
  "`SENTINEL_KB_KEY`가 설정되지 않았거나 `API_KEYS`에 등록되어 있지 않다"로 진단 가능하게 낸다.
  D-4가 인용한 오라클 방지 논거는 **로컬 프로세스를 자기 손으로 띄운 사람에게는 적용되지 않는다** —
  그 사람이 이미 키의 주인이다. 존재하지 않는 `Authorization` 헤더를 가리키는 문구는
  운영자를 있지도 않은 것을 찾게 만든다. (키 값 자체는 여전히 찍지 않는다.)
- **D-5. MCP는 호출자의 Bearer 토큰을 core-api로 그대로 패스스루한다.**
  MCP가 별도 서비스 키를 들면 쓰기 요청의 project가 core-api에서 **MCP 자신의 것**으로 해석되는
  confused deputy가 된다. 그래서 `resolveAuth`는 `{project, key}`를 돌려주고 `key`가
  `createCoreApiClient`로 그대로 넘어간다.
  **귀결(배포 제약): MCP와 core-api의 `API_KEYS`가 동일해야 한다.** 다르면 MCP에서 인증에 성공한 키가
  core-api에서 401이 되고, 그 실패는 initialize가 아니라 **도구 호출 시점에야** 드러난다 —
  가장 늦게, 가장 진단하기 어려운 자리다. `specs/06`의 SSM 시크릿 렌더링에 이 동일성 요구가
  반영돼야 한다(비준 대상 — 두 서비스가 같은 SSM 파라미터를 읽거나, 같은 값이 렌더링되도록 못박는다).
- **D-6. HTTP 전송은 stateless다.** 요청마다 새 서버·새 전송을 만들고
  `StreamableHTTPServerTransport`에 `sessionIdGenerator`를 주지 않는다(SDK: 미제공 = 세션 관리 비활성).
  세션을 들면 **세션 ID 하나가 project 하나에 묶인 채 메모리에 남아**, 키가 회수돼도 살아 있는 세션은
  계속 그 project로 쓴다. NFR-07(수평 확장)과도 정합한다 — 어느 인스턴스로 가도 결과가 같다.
  **이 결정을 기록해 두는 이유:** 기록이 없으면 T-026에서 nginx sticky session 논의가
  "MCP는 세션을 쓰니까"라는 없는 전제로 재개된다. **sticky session은 필요 없다.**
- **D-7. Acceptance 3("동일 서버 인스턴스")을 재정의했다.**
  SDK의 `Server.connect`는 전송을 1:1로 소유하므로 두 전송이 **같은 객체**를 공유하는 것은
  애초에 성립할 수 없다 — 문자 그대로는 판정 불가능한 항목이었다. 검증 가능한 명제로 바꿨다:
  **"두 전송이 같은 팩토리(`createMcpServer`)에서 나온다"** + 그 관측 가능한 귀결인
  **도구목록·serverInfo·capabilities·instructions 4중 대조**(`mcp-transports.int.spec.ts`).
  이 재정의가 코드 주석에만 있고 결정 목록에 없었다 → 여기로 올린다.

## Findings

- **F-1. `parseApiKeys`가 두 곳에 있다 — `@sentinel/core`로 승격해야 한다.**
  `packages/api/src/auth.ts`와 `packages/mcp/src/auth.ts`가 같은 파싱 규칙을 각자 들고 있다.
  순수 문자열 파싱이라 core에 두어도 "core는 HTTP를 모른다"를 어기지 않는다.
  이 태스크는 budget이 `packages/mcp/**`라 api·core를 **수정**할 수 없어 복제로 갔다.
  임시 방어선: `packages/mcp/src/auth.spec.ts`가 두 파일의 함수 본문을 주석·공백만 지우고 **직접 대조**한다
  (고정 다이제스트가 아니라 대조인 이유: 다이제스트는 상수만 갱신하면 통과해 **가드를 끄는 게 고치는 것보다 쉽다**).
  → 별도 태스크로 승격하고 트립와이어를 회수할 것.

- **F-2. MCP env 4개가 `.env.example`에 없다.**
  `CORE_API_URL`·`CORE_API_TIMEOUT_MS`·`CORE_API_MAX_ATTEMPTS`·`SENTINEL_KB_KEY`.
  budget 밖 파일 **수정**이라 넣지 못했다. 지금은 `packages/mcp/src/config.ts`의 기본값
  (`http://localhost:3001` / 10000 / 3)이 문서 역할을 한다. → **T-026**에서 compose env와 함께 추가.

- **F-3. SDK가 전이 의존성 91개를 끌고 온다 (lockfile +510줄, 설치 크기 5.9M).**
  수치는 실측이다: `@modelcontextprotocol/sdk@1.30.0`의 전이 폐포를 pnpm 스토어에서 세면 **91개**
  (SDK 자신 제외), `node_modules/.pnpm/@modelcontextprotocol+sdk@1.30.0_zod@3.25.76`이 **5.9M**.
  (최초 기록의 "59개"는 과소 집계였다 — 직접 의존만 세고 전이를 접었다.)
  `express@5`·`hono`·`cors`·`jose`·`ajv`·`pkce-challenge` 등. 이 구현이 실제로 쓰는 것은
  `hono`(`StreamableHTTPServerTransport`가 `@hono/node-server` 경유로 쓴다)뿐이고 **express는 전혀 쓰지 않는다** —
  SDK의 무조건 의존이라 뺄 수 없다. 이미지 크기와 공급망 표면 양쪽에 영향. → **T-026**에서 계량.
  (zod는 `3.25.76` 하나로 수렴했다 — contracts와 동일 인스턴스라 T-015가 contracts 스키마를
  `registerTool`에 그대로 넘길 수 있다.)

- **F-4. `/mcp` 외에는 전부 404다 — 헬스체크 엔드포인트가 없다. 이건 specs/07의 갭이다.**
  compose healthcheck나 nginx upstream 감시가 붙을 자리가 없다.
  **"스펙 문면이 없어서 추가하지 않았다"는 틀린 서술이었다** — `specs/06-deployment.md`의 관측 행이
  `/health` 모니터를 **이미 요구한다.** 그러니 요구가 없는 게 아니라 **specs/07이 MCP 표면에
  그 자리를 만들어 두지 않은 것**이고, specs/06과 specs/07이 서로 어긋나 있다.
  T-014가 임의로 뚫지 않은 판단 자체는 유지한다(도구 5개 상한과 같은 이유로 MCP 표면은
  스펙 개정 + 인간 승인 사항이다). → **T-026**에서 specs/07 개정과 함께 결정.

- **F-5. specs/07의 `.mcp.json` 예시에 stdio 항목이 없다.**
  스펙은 stdio 어댑터를 요구하는데 클라이언트 연결 예시는 `"type": "http"`뿐이다.
  `pnpm --filter @sentinel/mcp start:stdio`로 뜨지만 문서에 없다. → **T-017**(클라이언트 연동)에서 보강.

- **F-6. SDK 타입이 이 레포의 `exactOptionalPropertyTypes: true`와 충돌한다.**
  전송 클래스가 `onclose`/`sessionId`를 getter/setter로 노출해 `T | undefined`가 되는데
  `Transport` 인터페이스는 선택 프로퍼티(`onclose?: () => void`)라 assignable하지 않다. 런타임 형상은 동일하다.
  `http.ts`·`mcp-transports.int.spec.ts`에 `asTransport` 캐스트 1개씩(총 2곳, `any` 아님).
  SDK가 고치면 회수할 것.

- **F-7. 도구 0개로 `tools/list`를 응답시키려고 register-then-remove 관용구를 썼다.**
  `McpServer`는 첫 도구 등록 시점에야 `tools` capability와 핸들러를 단다. 저수준 `setRequestHandler`로
  직접 달면 T-015의 `registerTool`이 `assertCanSetRequestHandler`에서 던진다.
  → `server.ts`의 `ensureToolListing`. T-015가 실제 도구를 등록해도 동작은 같다.
  내부 도구가 새지 않는지는 통합 테스트가 잠근다.

- **F-8. 응답 토큰 예산(NFR-03) 가드는 T-014에 넣을 곳이 없었다.**
  도구가 0개라 응답 크기를 잴 대상이 없다. `packages/mcp` 응답에 레코드 본문 전체를 넣지 않는다는
  CLAUDE.md 금지 사항은 **T-015에서 테스트로 잠가야 한다**(`mcp-tool-conventions` 스킬).

- **F-9. HTTP 표면에 요청 크기 제한·레이트 리밋이 없다.**
  `/mcp`는 인증된 요청만 받지만 본문 크기 상한이 없다. 스펙에 문면이 없어 추가하지 않았다.
  → **T-026**(nginx 계층에서 거는 편이 자연스럽다).

- **F-10. 429 재시도 분기를 덮는 테스트가 없다.**
  `core-api-client.ts`의 `isRetryableStatus`는 `status === 429 || status >= 500`인데,
  **`status === 429 ||`를 지워도 unit 테스트가 전부 통과한다**(검증자 실측). 재시도 테스트가
  전부 500/503/전송실패로만 쓰여 있어 429 분기가 관측되지 않는다. core-api에 레이트 리밋이
  붙는 순간(F-9 → T-026) 조용히 죽는 경로다. → **T-015**에서 429 케이스 추가.

- **F-11. `ensureToolListing`은 T-015에서 회수할 스캐폴딩이다.**
  도구가 0개라서만 존재한다. T-015가 실제 도구 5개를 등록하면 capability·핸들러는 그쪽에서
  초기화되고 이 함수는 **등록→삭제 no-op**만 남는다(요청마다 실행되는 죽은 코드).
  회수 대상: `ensureToolListing` 함수와 호출부, `mcp-transports.int.spec.ts`의
  "내부 부트스트랩 도구가 새지 않는다" 테스트. → `server.ts` 주석에도 체크리스트로 박아 뒀다.
