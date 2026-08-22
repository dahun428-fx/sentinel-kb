/**
 * MCP 서버 정의 — **stdio와 Streamable HTTP가 공유하는 단 하나의 팩토리다.**
 *
 * Acceptance 3("stdio 모드에서도 동일 서버 인스턴스가 기동")이 뜻하는 바를 여기서 고정한다.
 * 전송 하나에 서버 객체 하나가 붙으므로(SDK의 `Server.connect`는 전송을 1:1로 소유한다)
 * "같은 **객체**"는 애초에 성립할 수 없다. 검증 가능한 명제는 이것이다:
 *
 * > 두 전송 모두 이 팩토리 하나에서 나오고, 따라서 **같은 도구 목록·같은 핸들러·
 * > 같은 serverInfo·같은 capabilities**를 노출한다.
 *
 * 그래서 `mcp-transports.int.spec.ts`는 실제 MCP 클라이언트로 양쪽에 initialize한 뒤
 * `tools/list` 결과와 `getServerVersion()`/`getServerCapabilities()`를 **서로 비교**한다.
 * "둘 다 뜬다"가 아니라 "둘이 같은 것을 말한다"가 단언 대상이다.
 */
import { VERSION } from "@sentinel/core";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";

import type { CoreApiClient } from "./core-api-client.js";

export const SERVER_NAME = "sentinel-kb";

/**
 * 도구 개수 상한. 출처: specs/07-mcp.md("도구 5개 — **이 이상 늘리지 않는다**"),
 * CLAUDE.md 금지 사항("MCP 도구 개수 5개 초과 금지").
 *
 * T-014는 도구가 0개지만 상한 테스트는 **지금** 넣는다 — T-015가 6개째를 등록하는 순간
 * `mcp-transports.int.spec.ts`가 죽는다. 상한을 나중에 넣으면 이미 넘긴 뒤에 넣게 된다.
 */
export const MAX_TOOLS = 5;

/**
 * 요청 컨텍스트. HTTP 모드는 요청마다, stdio 모드는 프로세스마다 하나씩 만들어진다.
 * 도구 핸들러(T-015)는 이 값을 클로저로 받는다 — 클라이언트가 인자로 준 project를
 * 쓰지 않기 위해서다(specs/04의 confused deputy 방지 규약과 같은 이유).
 */
export interface McpContext {
  /** Bearer 키에서 해석된 project 클레임. */
  readonly project: string;
  /** core-api 호출 창구. 도구는 이것 말고 다른 경로로 데이터에 닿지 않는다. */
  readonly coreApi: CoreApiClient;
}

/**
 * 서버 팩토리 타입. **전송이 이 함수를 주입받게 하는 이유는 테스트 편의가 아니라 관측 가능성이다.**
 *
 * T-014에는 도구가 0개라 `McpContext.project`를 **읽는 코드가 하나도 없다.** 그래서
 * 전송이 `createMcpServer({ project: "무엇이든" })`처럼 상수를 넘겨도 프로토콜 표면(initialize,
 * tools/list)에는 아무 차이가 나타나지 않는다 — HTTP 로그의 `project` 필드는 `resolveAuth`
 * 결과에서 바로 가는 **다른 경로**라 주입을 관측하지 못한다.
 * 팩토리를 주입 가능하게 두면 테스트가 **주입 지점 그 자체**에서 값을 포착할 수 있다
 * (`createCoreApi` 주입과 대칭). Scope 2번("project 클레임을 요청 컨텍스트에 주입")의
 * 불변식은 이 경로로만 잠긴다.
 */
export type McpServerFactory = (context: McpContext) => McpServer;

/**
 * 도구를 등록한다. **T-014는 아무것도 등록하지 않는다** — 도구 구현은 T-015의 몫이다
 * (태스크 Out of scope). 자리를 미리 만들어 두는 이유는 T-015가 전송·인증 코드를
 * 건드리지 않고 이 함수 하나만 채우면 되게 하기 위함이다.
 */
/* eslint-disable @typescript-eslint/no-unused-vars --
 * 인자를 지금 쓰지 않지만 시그니처는 남긴다. T-015가 전송·인증 코드를 건드리지 않고
 * 이 본문만 채우게 하려는 것이고, 시그니처가 없으면 T-015가 `createMcpServer`를 고치게 되어
 * "두 전송이 같은 팩토리에서 나온다"는 Acceptance 3의 불변식이 손대는 대상이 된다. */
function registerTools(server: McpServer, context: McpContext): void {
  // T-015: search_knowledge / get_record / record_knowledge / suggest_resolution / give_feedback
}
/* eslint-enable @typescript-eslint/no-unused-vars */

/**
 * 도구가 0개여도 `tools/list`가 **응답하게** 만든다 (태스크 Scope: "도구 0개 상태로
 * initialize/tools list 응답").
 *
 * SDK의 `McpServer`는 첫 도구가 등록될 때 비로소 `tools` capability와 `tools/list`
 * 핸들러를 단다. 도구가 0개면 클라이언트는 capability도 못 보고 `tools/list`에
 * "Method not found"를 받는다. 저수준 `setRequestHandler`로 직접 달면 T-015가
 * 도구를 등록하는 순간 `assertCanSetRequestHandler`가 "이미 존재한다"며 던진다.
 *
 * 그래서 **공개 API만으로** 해결한다: 도구를 하나 등록했다가 곧바로 제거한다.
 * 등록 부수효과로 capability와 핸들러가 초기화되고, 제거 후 목록은 비어 있다.
 *
 * ---
 * ## ⚠️ T-015에서 **회수할 것** (삭제 대상 스캐폴딩)
 *
 * 이 관용구가 존재하는 이유는 **도구가 0개라는 것 하나뿐이다.** T-015가 실제 도구 5개를
 * `registerTools`에 등록하면 capability와 핸들러는 그쪽에서 이미 초기화되고,
 * 이 함수는 **등록했다가 지우는 no-op**만 남는다 — 아무것도 지키지 않으면서 매 요청
 * (HTTP는 요청마다 서버를 새로 만든다) 실행되는 죽은 코드다.
 *
 * T-015 체크리스트: 도구를 등록한 뒤 `createMcpServer`에서 `ensureToolListing` 호출과
 * 이 함수, 그리고 `mcp-transports.int.spec.ts`의 "내부 부트스트랩 도구가 새지 않는다"
 * 테스트를 **함께** 지운다. 도구 0개 테스트("빈 배열")도 그때 실제 도구 목록으로 바뀐다.
 */
function ensureToolListing(server: McpServer): void {
  const placeholder = server.registerTool(
    "__bootstrap__",
    { description: "내부 부트스트랩용. 즉시 제거되며 클라이언트에 노출되지 않는다." },
    () => ({ content: [] }),
  );
  placeholder.remove();
}

/**
 * MCP 서버를 만든다. **모든 전송이 이 함수를 통해서만 서버를 얻는다.**
 * 다른 곳에서 `new McpServer(...)`를 부르면 두 전송의 도구 목록이 갈라질 수 있다.
 */
export function createMcpServer(context: McpContext): McpServer {
  const server = new McpServer(
    { name: SERVER_NAME, version: VERSION },
    {
      instructions:
        "여러 프로젝트의 트러블슈팅 사례를 검색하고 기록하는 지식보관소다. " +
        "디버깅 전에 과거 사례를 먼저 찾고, 해결한 뒤에 기록한다.",
    },
  );

  registerTools(server, context);
  ensureToolListing(server);

  return server;
}
