/**
 * `pnpm mcp:ping` 라이브러리 (T-017). 프로세스 진입점은 `mcp-ping.cli.ts`다 —
 * `seed.ts`/`seed.cli.ts` 규약을 그대로 따른다: 여기서는 `process.exit`을 부르지 않고
 * 종료 코드는 던지는 오류에 실어 보내며, 실제 종료는 컴포지션 루트가 정한다.
 *
 * ## 왜 MCP SDK를 쓰지 않고 fetch로 직접 말하는가
 * 루트 `package.json`에 `@modelcontextprotocol/sdk`를 추가하면 lockfile이 바뀌고,
 * 지금 `packages/mcp`를 병렬로 고치는 브랜치들과 정면으로 충돌한다. ping이 필요로 하는 것은
 * `initialize` → `tools/list` 두 왕복뿐이라 프레임을 손으로 만드는 값이 충돌 위험보다 싸다.
 * (전송 계약 자체의 검증은 SDK 클라이언트를 쓰는 `packages/mcp`의 통합 테스트가 한다.)
 *
 * ## 왜 종료 코드가 여러 개인가
 * "연결이 안 된다"와 "붙었는데 도구가 5개가 아니다"는 **다른 사건이고 다른 사람이 고친다.**
 * 전자는 배포·네트워크, 후자는 코드다. 하나의 exit 1로 뭉뚱그리면 운영자가 로그를 읽어야
 * 알 수 있고, 자동화는 아무것도 가를 수 없다. `seed.cli.ts`가 세운 sysexits 규약을 잇는다.
 *
 * ## 시크릿
 * 이 파일에서 나가는 어떤 메시지에도 키가 실리지 않는다. 원본 오류 객체를 그대로 붙이지 않고
 * (`console.error(error)`가 API 키를 통째로 덤프한 T-014 전례가 있다) 메시지를 만들어 낸 뒤
 * `redactSecrets`로 한 번 더 훑는다. 방어선이 둘인 이유는 fetch가 던지는 오류의 `cause`에
 * 무엇이 담길지 우리가 통제하지 못하기 때문이다.
 */

/** specs/07 "도구 5개 — 이 이상 늘리지 않는다". ping의 성공 판정이 이 숫자다. */
export const EXPECTED_TOOL_COUNT = 5;

/** 클라이언트가 제시하는 프로토콜 버전. `packages/mcp`의 통합 테스트와 같은 값. */
export const PROTOCOL_VERSION = "2025-06-18";

const DEFAULT_TIMEOUT_MS = 10_000;

/**
 * 종료 코드. 0/1을 뺀 나머지는 sysexits.h를 따른다(`seed.cli.ts` 선례).
 * **`UNAVAILABLE`(서버에 닿지 못함)과 `TOOLS_MISMATCH`(붙었는데 도구 수가 다름)를 가르는 것이
 * 이 표의 존재 이유다.**
 */
export const MCP_PING_EXIT = {
  /** 도구 5개 확인. */
  OK: 0,
  /** 연결·인증·프로토콜 모두 정상인데 도구 수가 5개가 아니다. 코드 문제다. */
  TOOLS_MISMATCH: 1,
  /** 서버에 닿지 못했다 — DNS·방화벽·미기동·타임아웃. 배포/네트워크 문제다. */
  UNAVAILABLE: 69,
  /** ping 자신의 버그. 위 어디에도 분류되지 않은 오류가 여기로 온다. */
  SOFTWARE: 70,
  /** HTTP는 됐는데 MCP로서 말이 안 통한다 — 404, 5xx, 깨진 JSON-RPC. */
  PROTOCOL: 76,
  /** 401/403. 키가 이 서버의 `API_KEYS`에 없다. */
  NO_PERM: 77,
  /** env 오설정. 서버를 부르기도 전에 걸린다. */
  CONFIG: 78,
} as const;

export type McpPingExit = (typeof MCP_PING_EXIT)[keyof typeof MCP_PING_EXIT];

export class McpPingError extends Error {
  constructor(
    readonly exitCode: McpPingExit,
    readonly code: string,
    message: string,
  ) {
    super(message);
    this.name = "McpPingError";
  }
}

/**
 * 문자열에서 시크릿을 지운다. 정확 일치만으로는 부족해서 `Bearer <token>` 형태도 함께 훑는다 —
 * 오류 메시지가 우리가 넘긴 헤더를 그대로 되비추는 경우가 있다.
 * 빈 문자열은 건너뛴다(모든 위치에 매치돼 문자열을 파괴한다).
 */
export function redactSecrets(text: string, secrets: readonly string[]): string {
  let out = text;
  for (const secret of secrets) {
    if (secret.length === 0) continue;
    out = out.split(secret).join("***");
  }
  return out.replace(/(Bearer\s+)\S+/gi, "$1***");
}

export interface PingConfig {
  /** 실제로 POST할 절대 URL. 항상 `/mcp`로 끝난다. */
  readonly endpoint: string;
  readonly key: string;
}

/**
 * env 해석. 이 함수가 env를 읽는 유일한 지점이고, 실패는 전부 `CONFIG`다.
 * 변수 이름은 `.mcp.json`·`docs/connect.md`와 같다 — ping이 쓰는 값과 클라이언트가 쓰는 값이
 * 갈라지면 ping이 통과해도 아무것도 보장하지 못한다.
 */
export function readPingConfig(env: NodeJS.ProcessEnv): PingConfig {
  const rawUrl = env["SENTINEL_KB_URL"]?.trim() ?? "";
  const key = env["SENTINEL_KB_KEY"]?.trim() ?? "";
  if (rawUrl === "") {
    throw new McpPingError(
      MCP_PING_EXIT.CONFIG,
      "MCP_PING_CONFIG_INVALID",
      "`SENTINEL_KB_URL`이 비어 있다. 예: SENTINEL_KB_URL=https://kb.example.com",
    );
  }
  if (key === "") {
    throw new McpPingError(
      MCP_PING_EXIT.CONFIG,
      "MCP_PING_CONFIG_INVALID",
      "`SENTINEL_KB_KEY`가 비어 있다. 서버의 `API_KEYS`에 등록된 키여야 한다.",
    );
  }

  let parsed: URL;
  try {
    parsed = new URL(rawUrl);
  } catch {
    // 오류 원문을 싣지 않는다 — URL 파서가 입력 전체를 되비추는데, 사용자가 URL 자리에
    // 키를 잘못 넣었을 수 있다.
    throw new McpPingError(
      MCP_PING_EXIT.CONFIG,
      "MCP_PING_CONFIG_INVALID",
      "`SENTINEL_KB_URL`이 유효한 URL이 아니다.",
    );
  }
  if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
    throw new McpPingError(
      MCP_PING_EXIT.CONFIG,
      "MCP_PING_CONFIG_INVALID",
      `\`SENTINEL_KB_URL\`의 스킴이 http/https가 아니다: ${parsed.protocol}`,
    );
  }

  const base = rawUrl.replace(/\/+$/, "");
  return { endpoint: base.endsWith("/mcp") ? base : `${base}/mcp`, key };
}

/** 테스트가 주입하는 최소 fetch 시그니처. 실제 `globalThis.fetch`가 그대로 대입된다. */
export type FetchLike = (url: string, init: RequestInit) => Promise<Response>;

interface JsonRpcResponse {
  readonly result?: unknown;
  readonly error?: { readonly code?: number; readonly message?: string };
}

/**
 * Streamable HTTP 응답 본문에서 JSON-RPC 프레임을 꺼낸다.
 *
 * 이 전송은 같은 엔드포인트에서 `application/json`과 `text/event-stream` **둘 다** 낼 수 있다
 * (SDK의 `enableJsonResponse` 설정에 달렸고, 그건 서버 쪽 사정이라 클라이언트가 가정하면 안 된다).
 * SSE면 마지막 `data:` 줄이 우리가 기다리던 응답이다.
 */
export function parseRpcBody(contentType: string, body: string): JsonRpcResponse {
  const text = contentType.toLowerCase().includes("text/event-stream")
    ? (body
        .split(/\r?\n/)
        .filter((line) => line.startsWith("data:"))
        .map((line) => line.slice("data:".length).trim())
        .at(-1) ?? "")
    : body.trim();

  if (text === "") {
    throw new McpPingError(
      MCP_PING_EXIT.PROTOCOL,
      "MCP_PING_BAD_FRAME",
      "응답 본문이 비어 있다 — MCP 서버가 아닌 것이 `/mcp`에 응답하고 있을 수 있다.",
    );
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    // 본문을 메시지에 싣지 않는다. 프록시 오류 페이지가 요청 헤더를 되비추는 경우가 있다.
    throw new McpPingError(
      MCP_PING_EXIT.PROTOCOL,
      "MCP_PING_BAD_FRAME",
      "응답이 JSON-RPC 프레임이 아니다(파싱 실패).",
    );
  }
  if (typeof parsed !== "object" || parsed === null) {
    throw new McpPingError(
      MCP_PING_EXIT.PROTOCOL,
      "MCP_PING_BAD_FRAME",
      "응답이 JSON-RPC 객체가 아니다.",
    );
  }
  return parsed as JsonRpcResponse;
}

/** `tools/list` 결과에서 이름만 뽑는다. 형태가 다르면 프로토콜 오류다. */
export function parseToolNames(result: unknown): string[] {
  const tools =
    typeof result === "object" && result !== null && "tools" in result
      ? (result as { tools: unknown }).tools
      : undefined;
  if (!Array.isArray(tools)) {
    throw new McpPingError(
      MCP_PING_EXIT.PROTOCOL,
      "MCP_PING_BAD_FRAME",
      "`tools/list` 응답에 tools 배열이 없다.",
    );
  }
  return tools.map((tool, index) => {
    const name =
      typeof tool === "object" && tool !== null && "name" in tool
        ? (tool as { name: unknown }).name
        : undefined;
    if (typeof name !== "string") {
      throw new McpPingError(
        MCP_PING_EXIT.PROTOCOL,
        "MCP_PING_BAD_FRAME",
        `\`tools/list\`의 ${String(index)}번째 항목에 name이 없다.`,
      );
    }
    return name;
  });
}

export interface PingOptions extends PingConfig {
  readonly fetchImpl?: FetchLike;
  readonly timeoutMs?: number;
}

export interface PingResult {
  readonly toolNames: readonly string[];
  /** 서버가 자기소개한 이름·버전. 없을 수도 있다(프로토콜상 선택). */
  readonly serverInfo?: { readonly name?: string; readonly version?: string };
}

/**
 * 한 번의 JSON-RPC 왕복. 실패를 **원인별 종료 코드로 분류하는 것이 이 함수의 본체**다.
 * `expectResult: false`면 알림(notification)이라 본문을 읽지 않는다.
 */
async function rpc(
  options: Required<Pick<PingOptions, "endpoint" | "key">> & {
    fetchImpl: FetchLike;
    timeoutMs: number;
    message: Record<string, unknown>;
    sessionId?: string;
    expectResult: boolean;
  },
): Promise<{ result: unknown; sessionId: string | undefined }> {
  const { endpoint, key, fetchImpl, timeoutMs, message, expectResult } = options;
  const headers: Record<string, string> = {
    authorization: `Bearer ${key}`,
    "content-type": "application/json",
    // 이 두 타입을 모두 받겠다고 밝히지 않으면 Streamable HTTP 전송은 406으로 끊는다.
    accept: "application/json, text/event-stream",
    "mcp-protocol-version": PROTOCOL_VERSION,
  };
  if (options.sessionId !== undefined) headers["mcp-session-id"] = options.sessionId;

  let response: Response;
  try {
    response = await fetchImpl(endpoint, {
      method: "POST",
      headers,
      body: JSON.stringify(message),
      signal: AbortSignal.timeout(timeoutMs),
    });
  } catch (error: unknown) {
    // 여기 오는 것은 "응답 자체가 없었다"이다 — 서버 미기동·DNS·방화벽·타임아웃.
    // 원본 오류를 붙이지 않고 cause의 메시지만 뽑아 쓴다(§시크릿).
    const reason = describeTransportError(error);
    throw new McpPingError(
      MCP_PING_EXIT.UNAVAILABLE,
      "MCP_PING_UNREACHABLE",
      `서버에 닿지 못했다 (${reason}). 서버가 떠 있는지, 도메인·방화벽이 맞는지 확인하라.`,
    );
  }

  if (response.status === 401 || response.status === 403) {
    throw new McpPingError(
      MCP_PING_EXIT.NO_PERM,
      "MCP_PING_UNAUTHORIZED",
      `인증 실패 (HTTP ${String(response.status)}). ` +
        "`SENTINEL_KB_KEY`가 **이 서버의** `API_KEYS`에 등록돼 있는지 확인하라.",
    );
  }
  if (!response.ok) {
    throw new McpPingError(
      MCP_PING_EXIT.PROTOCOL,
      "MCP_PING_HTTP_ERROR",
      `HTTP ${String(response.status)}. 경로가 \`/mcp\`로 라우팅되는지 확인하라(specs/06 nginx).`,
    );
  }

  const sessionId = response.headers.get("mcp-session-id") ?? undefined;
  if (!expectResult) return { result: undefined, sessionId };

  const parsed = parseRpcBody(response.headers.get("content-type") ?? "", await response.text());
  if (parsed.error !== undefined) {
    throw new McpPingError(
      MCP_PING_EXIT.PROTOCOL,
      "MCP_PING_RPC_ERROR",
      `JSON-RPC 오류: ${parsed.error.message ?? "(메시지 없음)"}`,
    );
  }
  return { result: parsed.result, sessionId };
}

/** fetch가 던진 오류에서 진단에 쓸 만한 한 조각만 뽑는다. 객체를 통째로 쓰지 않는다. */
function describeTransportError(error: unknown): string {
  if (error instanceof Error) {
    if (error.name === "TimeoutError" || error.name === "AbortError") return "타임아웃";
    const cause: unknown = error.cause;
    const causeCode =
      typeof cause === "object" && cause !== null && "code" in cause
        ? (cause as { code: unknown }).code
        : undefined;
    if (typeof causeCode === "string") return causeCode;
    return error.message;
  }
  return "알 수 없는 오류";
}

/**
 * `initialize` → (`notifications/initialized`) → `tools/list`.
 *
 * 이 서버는 stateless라 요청마다 새 서버 인스턴스가 서고, 그래서 `tools/list`만 던져도 응답한다.
 * 그래도 `initialize`를 먼저 보내는 이유는 두 가지다. (1) 프로토콜 협상·인증이 실제 클라이언트와
 * **같은 순서로** 검증된다. (2) 서버가 나중에 stateful로 바뀌어 세션을 발급해도 ping이 그대로 돈다
 * — 세션 ID가 오면 이후 요청에 실어 보낸다.
 */
export async function pingMcp(options: PingOptions): Promise<PingResult> {
  const fetchImpl = options.fetchImpl ?? ((url, init) => fetch(url, init));
  const timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const base = { endpoint: options.endpoint, key: options.key, fetchImpl, timeoutMs };

  const init = await rpc({
    ...base,
    expectResult: true,
    message: {
      jsonrpc: "2.0",
      id: 1,
      method: "initialize",
      params: {
        protocolVersion: PROTOCOL_VERSION,
        capabilities: {},
        clientInfo: { name: "sentinel-kb-mcp-ping", version: "0.0.0" },
      },
    },
  });

  const withSession = init.sessionId === undefined ? base : { ...base, sessionId: init.sessionId };

  // 라이프사이클상 initialize 다음에 오는 알림. stateless 서버에는 무의미하지만
  // stateful로 바뀌었을 때 tools/list가 거부되지 않게 하는 값싼 보험이다.
  await rpc({
    ...withSession,
    expectResult: false,
    message: { jsonrpc: "2.0", method: "notifications/initialized" },
  });

  const listed = await rpc({
    ...withSession,
    expectResult: true,
    message: { jsonrpc: "2.0", id: 2, method: "tools/list", params: {} },
  });

  const serverInfo =
    typeof init.result === "object" && init.result !== null && "serverInfo" in init.result
      ? (init.result as { serverInfo?: { name?: string; version?: string } }).serverInfo
      : undefined;

  return {
    toolNames: parseToolNames(listed.result),
    ...(serverInfo === undefined ? {} : { serverInfo }),
  };
}

/**
 * 도구 수 판정. **여기서만 `TOOLS_MISMATCH`가 난다** — 연결·인증·프로토콜이 전부 통과한 뒤이므로
 * 이 실패는 언제나 "서버 코드가 스펙과 다르다"를 뜻한다.
 */
export function assertToolCount(toolNames: readonly string[]): void {
  if (toolNames.length === EXPECTED_TOOL_COUNT) return;
  throw new McpPingError(
    MCP_PING_EXIT.TOOLS_MISMATCH,
    "MCP_PING_TOOL_COUNT_MISMATCH",
    `도구가 ${String(EXPECTED_TOOL_COUNT)}개여야 하는데 ${String(toolNames.length)}개다` +
      `${toolNames.length === 0 ? "" : `: ${toolNames.join(", ")}`}. ` +
      "연결과 인증은 정상이다 — 서버 쪽 도구 등록을 확인하라(specs/07).",
  );
}
