/**
 * T-014 Acceptance 통합 테스트. **실제 MCP SDK 클라이언트로 initialize한다** —
 * HTTP 스텁으로 JSON-RPC 프레임을 흉내내면 프로토콜 협상(버전·capability·Accept 헤더)이
 * 검증되지 않아, 정작 Claude Code가 붙는 순간 깨지는 것을 못 잡는다.
 *
 * stdio 쪽은 **진짜 자식 프로세스를 spawn한다.** 같은 프로세스에서 파이프를 흉내내면
 * "stdout에 배너 한 줄이 섞여 파서가 깨지는" 실제 실패 모드를 놓친다.
 */
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import {
  getDefaultEnvironment,
  StdioClientTransport,
} from "@modelcontextprotocol/sdk/client/stdio.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import type { Transport } from "@modelcontextprotocol/sdk/shared/transport.js";
import type { AddressInfo } from "node:net";
import { fileURLToPath } from "node:url";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { parseApiKeys } from "./auth.js";
import type { CoreApiClient } from "./core-api-client.js";
import { createMcpHttpServer, MCP_PATH, type McpHttpLogEntry } from "./http.js";
import { createMcpServer, MAX_TOOLS, SERVER_NAME, type McpContext } from "./server.js";

const VALID_KEY = "int-test-key-do-not-log";
/**
 * 키가 **둘**인 이유: 하나뿐이면 "project 클레임을 상수로 박은" 구현과
 * 올바른 구현을 관측으로 구분할 수 없다. 서로 다른 project로 가는 키 두 개가 있어야
 * 주입이 실제로 키를 따라간다는 것을 단언할 수 있다.
 */
const OTHER_KEY = "int-test-other-key";
const API_KEYS_ENV = `${VALID_KEY}:sentinel-kb,${OTHER_KEY}:bizcare-web`;
const API_KEYS = parseApiKeys(API_KEYS_ENV);

/** core-api를 실제로 띄우지 않는다. T-014에는 도구가 0개라 아무도 이걸 부르지 않는다. */
const unusedCoreApi: CoreApiClient = {
  read: () => Promise.reject(new Error("도구가 없다 — 불릴 리 없다")),
  write: () => Promise.reject(new Error("도구가 없다 — 불릴 리 없다")),
};

const TSX_BIN = fileURLToPath(new URL("../../../node_modules/.bin/tsx", import.meta.url));
const STDIO_CLI = fileURLToPath(new URL("./stdio.cli.ts", import.meta.url));

const logs: McpHttpLogEntry[] = [];
/**
 * **주입 지점에서 포착한 컨텍스트.** 로그의 `project` 필드가 아니다 —
 * 로그는 `resolveAuth` 결과에서 바로 가는 다른 경로라, 전송이 서버에 넘기는 값을
 * 상수로 박아도 로그는 멀쩡히 올바른 값을 낸다(그 구멍으로 뮤테이션이 살아남았다).
 * 여기 담기는 것은 `createMcpServer`가 **실제로 받는** 인자 그 자체다.
 */
const httpContexts: McpContext[] = [];
let baseUrl: string;
let httpServer: ReturnType<typeof createMcpHttpServer>;

beforeAll(async () => {
  httpServer = createMcpHttpServer({
    apiKeys: API_KEYS,
    coreApiBaseUrl: "http://unused.invalid",
    log: (entry) => logs.push(entry),
    createCoreApi: () => unusedCoreApi,
    // 실제 팩토리를 그대로 쓰되 인자만 들여다본다 — 프로덕션 경로를 우회하지 않는다.
    createServer: (context) => {
      httpContexts.push(context);
      return createMcpServer(context);
    },
  });
  await new Promise<void>((resolve) => httpServer.listen(0, "127.0.0.1", resolve));
  const address = httpServer.address() as AddressInfo;
  baseUrl = `http://127.0.0.1:${String(address.port)}`;
});

afterAll(async () => {
  await new Promise<void>((resolve) => httpServer.close(() => resolve()));
});

/**
 * SDK 클라이언트 전송의 `sessionId`는 `string | undefined`인데 `Transport` 인터페이스는
 * `sessionId?: string`이라, 이 레포의 `exactOptionalPropertyTypes: true` 아래에서
 * assignable하지 않다. 런타임 형상은 같다 — `http.ts`의 `asTransport`와 같은 사유다.
 */
function asTransport(transport: StreamableHTTPClientTransport): Transport {
  return transport as unknown as Transport;
}

/** Streamable HTTP로 붙은 실제 MCP 클라이언트. */
async function connectHttp(key: string = VALID_KEY): Promise<Client> {
  const client = new Client({ name: "t-014-int-test", version: "0.0.0" });
  await client.connect(
    asTransport(
      new StreamableHTTPClientTransport(new URL(`${baseUrl}${MCP_PATH}`), {
        requestInit: { headers: { authorization: `Bearer ${key}` } },
      }),
    ),
  );
  return client;
}

/** 자식 프로세스를 spawn해 stdio로 붙은 실제 MCP 클라이언트. */
async function connectStdio(env: Record<string, string>): Promise<Client> {
  const client = new Client({ name: "t-014-int-test", version: "0.0.0" });
  await client.connect(
    new StdioClientTransport({
      command: TSX_BIN,
      args: [STDIO_CLI],
      env: { ...getDefaultEnvironment(), ...env },
      stderr: "pipe",
    }),
  );
  return client;
}

const VALID_STDIO_ENV = {
  API_KEYS: API_KEYS_ENV,
  SENTINEL_KB_KEY: VALID_KEY,
  CORE_API_URL: "http://unused.invalid",
};

describe("Acceptance 1 — MCP SDK 클라이언트로 initialize", () => {
  it("Streamable HTTP로 initialize에 성공하고 서버 정보를 받는다", async () => {
    const client = await connectHttp();
    try {
      expect(client.getServerVersion()?.name).toBe(SERVER_NAME);
      expect(client.getServerCapabilities()?.tools).toBeDefined();
    } finally {
      await client.close();
    }
  });

  it("도구가 0개여도 tools/list가 응답한다 (빈 배열)", async () => {
    const client = await connectHttp();
    try {
      await expect(client.listTools()).resolves.toEqual({ tools: [] });
    } finally {
      await client.close();
    }
  });
});

describe("Acceptance 2 — 인증", () => {
  it("Authorization 헤더가 없으면 401이다", async () => {
    const response = await fetch(`${baseUrl}${MCP_PATH}`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        accept: "application/json, text/event-stream",
      },
      body: JSON.stringify({
        jsonrpc: "2.0",
        id: 1,
        method: "initialize",
        params: {
          protocolVersion: "2025-06-18",
          capabilities: {},
          clientInfo: { name: "x", version: "0" },
        },
      }),
    });

    expect(response.status).toBe(401);
    expect(response.headers.get("www-authenticate")).toBe("Bearer");
    // specs/04의 `{error:{code,message}}` 규약을 그대로 쓴다.
    await expect(response.json()).resolves.toEqual({
      error: { code: "UNAUTHORIZED", message: expect.any(String) as unknown as string },
    });
  });

  it("401은 MCP 프로토콜 레벨이 아니라 HTTP 레벨이다 — 세션이 서지 않는다", async () => {
    await expect(connectHttp("wrong-key")).rejects.toThrow();
  });

  it("미등록 키와 헤더 없음이 같은 메시지를 낸다 — 키 유효성 오라클 금지", async () => {
    const body = async (headers: Record<string, string>): Promise<unknown> =>
      await (await fetch(`${baseUrl}${MCP_PATH}`, { method: "POST", headers, body: "{}" })).json();

    expect(await body({})).toEqual(await body({ authorization: "Bearer definitely-not-a-key" }));
  });

  it("`/mcp` 외의 경로는 404다 — 인증 이전에 걸린다", async () => {
    const response = await fetch(`${baseUrl}/health`, { method: "GET" });
    expect(response.status).toBe(404);
  });

  /**
   * Scope의 "project 클레임을 요청 컨텍스트에 주입"이 실제로 **키를 따라가는지** 본다.
   * 주입 값을 상수로 박아도 키가 하나면 아무 테스트도 죽지 않는다 — 그래서 키가 둘이다.
   */
  it("주입된 project가 제시된 키를 따라간다 — 상수로 박으면 죽는다", async () => {
    logs.length = 0;

    for (const key of [VALID_KEY, OTHER_KEY]) {
      const client = await connectHttp(key);
      await client.listTools();
      await client.close();
    }

    const projects = logs.filter((entry) => entry.status < 400).map((entry) => entry.project);
    expect(new Set(projects)).toEqual(new Set(["sentinel-kb", "bizcare-web"]));
  });

  /**
   * 위 테스트가 보는 것은 **로그 필드**다. 로그의 `project`는 `resolveAuth` 결과에서 바로 가고
   * 서버로 주입되는 값은 `createMcpServer(...)` 인자로 간다 — 분기 이후 **서로 독립된 두 경로**다.
   * 그래서 `createMcpServer({ project: "WRONG", ... })`로 박아도 위 테스트는 통과한다(실측됨).
   *
   * 도구가 0개인 T-014에는 `McpContext.project`를 **읽는 코드가 없어서** 프로토콜 표면에도
   * 차이가 나타나지 않는다. 그러니 관측 지점은 주입 지점 자신뿐이다 —
   * 이 테스트가 Scope 2번("project 클레임을 요청 컨텍스트에 주입")을 잠그는 유일한 장치다.
   */
  it("서버에 **주입되는** McpContext.project가 키를 따라간다 — 로그가 아니라 주입 지점을 본다", async () => {
    for (const [key, expected] of [
      [VALID_KEY, "sentinel-kb"],
      [OTHER_KEY, "bizcare-web"],
    ] as const) {
      httpContexts.length = 0;

      const client = await connectHttp(key);
      await client.listTools();
      await client.close();

      expect(
        httpContexts.length,
        "서버 팩토리가 한 번도 불리지 않았다 — 관측 자체가 죽었다는 뜻이다.",
      ).toBeGreaterThan(0);
      expect(
        new Set(httpContexts.map((context) => context.project)),
        `키 ${key}로 붙었는데 주입된 project가 ${expected}가 아니다. ` +
          "전송이 상수를 넘기고 있거나 resolveAuth 결과가 아닌 다른 값을 넘기고 있다.",
      ).toEqual(new Set([expected]));
    }
  });
});

describe("Acceptance 3 — stdio와 HTTP가 같은 서버 정의를 노출한다", () => {
  it("stdio 모드가 실제로 기동하고 initialize에 성공한다", async () => {
    const client = await connectStdio(VALID_STDIO_ENV);
    try {
      expect(client.getServerVersion()?.name).toBe(SERVER_NAME);
    } finally {
      await client.close();
    }
  }, 30_000);

  /**
   * **"둘 다 뜬다"가 아니라 "둘이 같은 것을 말한다"를 단언한다.**
   * 전송 하나에 서버 객체 하나가 붙으므로 같은 *객체*는 성립할 수 없다. 검증 가능한 명제는
   * 두 전송이 `createMcpServer` 하나에서 나온다는 것이고, 그 관측 가능한 귀결이
   * 도구 목록·serverInfo·capabilities·instructions의 일치다.
   *
   * 한쪽만 도구를 등록하거나(T-015가 전송별로 갈라 쓰면) 한쪽만 팩토리를 우회하면 여기서 죽는다.
   */
  it("도구 목록·serverInfo·capabilities·instructions가 완전히 일치한다", async () => {
    const [http, stdio] = await Promise.all([connectHttp(), connectStdio(VALID_STDIO_ENV)]);
    try {
      expect(await stdio.listTools()).toEqual(await http.listTools());
      expect(stdio.getServerVersion()).toEqual(http.getServerVersion());
      expect(stdio.getServerCapabilities()).toEqual(http.getServerCapabilities());
      expect(stdio.getInstructions()).toEqual(http.getInstructions());
    } finally {
      await Promise.all([http.close(), stdio.close()]);
    }
  }, 30_000);

  it("stdio는 인증이 안 되면 **뜨지 않는다** — 401을 낼 HTTP 지점이 없기 때문", async () => {
    // 키 없음
    await expect(
      connectStdio({ API_KEYS: API_KEYS_ENV, CORE_API_URL: "http://unused.invalid" }),
    ).rejects.toThrow();
    // 미등록 키
    await expect(
      connectStdio({ ...VALID_STDIO_ENV, SENTINEL_KB_KEY: "not-a-registered-key" }),
    ).rejects.toThrow();
  }, 30_000);
});

/**
 * 도구 상한. 출처: specs/07-mcp.md("도구 5개 — 이 이상 늘리지 않는다"), CLAUDE.md.
 * **0개인 지금 넣어야** T-015가 6개째를 등록하는 순간 죽는다.
 * 상수(`TOOL_NAMES` 류)가 아니라 **살아 있는 서버가 실제로 광고하는 목록**을 센다 —
 * 상수를 갱신하지 않고 도구만 등록하면 상수 기반 테스트는 통과해 버린다.
 */
describe("MCP 도구 개수 상한", () => {
  /**
   * 상한 **5는 여기 리터럴로 박는다.** `MAX_TOOLS`만 보면 그 상수를 6으로 올리는 것이
   * 게이트를 통과하는 가장 쉬운 길이 되어, 프로덕션 코드 한 줄로 가드가 꺼진다.
   * 리터럴이면 우회하려면 **이 테스트를 고쳐야** 하고, 그건 CLAUDE.md의 즉시 중단 사유다.
   */
  it("실제 tools/list가 광고하는 도구가 5개를 넘지 않는다", async () => {
    const client = await connectHttp();
    try {
      const { tools } = await client.listTools();
      expect(
        tools.length,
        `도구 ${String(tools.length)}개. specs/07은 5개를 상한으로 못박았고, ` +
          "신규 도구는 스펙 개정 + 인간 승인 사항이다(CLAUDE.md 금지 사항).",
      ).toBeLessThanOrEqual(5);
    } finally {
      await client.close();
    }
  });

  it("MAX_TOOLS 상수가 스펙의 5와 어긋나지 않는다", () => {
    expect(MAX_TOOLS, "specs/07-mcp.md는 도구 5개를 상한으로 정했다.").toBe(5);
  });

  it("내부 부트스트랩 도구가 클라이언트에 새지 않는다", async () => {
    const client = await connectHttp();
    try {
      const { tools } = await client.listTools();
      expect(tools.map((tool) => tool.name)).not.toContain("__bootstrap__");
    } finally {
      await client.close();
    }
  });
});

describe("시크릿이 로그로 새지 않는다", () => {
  it("성공·실패 어느 경로에서도 Bearer 토큰이 로그에 남지 않는다", async () => {
    logs.length = 0;

    const client = await connectHttp();
    await client.listTools();
    await client.close();
    await fetch(`${baseUrl}${MCP_PATH}`, {
      method: "POST",
      headers: { authorization: "Bearer another-secret-value" },
      body: "{}",
    });

    const dumped = JSON.stringify(logs);
    expect(dumped).not.toContain(VALID_KEY);
    expect(dumped).not.toContain("another-secret-value");
    expect(dumped.toLowerCase()).not.toContain("authorization");
    expect(dumped.toLowerCase()).not.toContain("bearer");
    // 로깅 자체가 죽어 있으면 위 단언이 공허해진다 — 실제로 줄이 나갔는지 확인한다.
    expect(logs.length).toBeGreaterThan(0);
    expect(logs.some((entry) => entry.status === 401)).toBe(true);
    expect(logs.some((entry) => entry.project === "sentinel-kb")).toBe(true);
  });
});
