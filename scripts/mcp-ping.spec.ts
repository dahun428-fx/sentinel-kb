import { describe, expect, it } from "vitest";

import {
  assertToolCount,
  EXPECTED_TOOL_COUNT,
  type FetchLike,
  MCP_PING_EXIT,
  McpPingError,
  parseRpcBody,
  parseToolNames,
  pingMcp,
  readPingConfig,
  redactSecrets,
} from "./mcp-ping.js";

/**
 * T-017 `pnpm mcp:ping`.
 *
 * 이 브랜치에는 붙을 서버가 없다(`packages/mcp`가 스텁이고 배포도 없다). 그래서 fetch를 주입해
 * **실패 갈래마다 종료 코드가 실제로 갈리는지**를 검증한다. "연결 실패"와 "도구 수 불일치"가
 * 같은 코드로 나오면 ping은 있으나 마나다 — 운영자가 로그를 읽어야만 무엇이 문제인지 알게 된다.
 */

const KEY = "ping-test-key-do-not-log";
const CONFIG = { endpoint: "https://kb.example.com/mcp", key: KEY };

const TOOLS = [
  "search_knowledge",
  "get_record",
  "record_knowledge",
  "suggest_resolution",
  "give_feedback",
];

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}

/** initialize → notifications/initialized → tools/list 순서를 그대로 흉내낸다. */
function fetchWithTools(toolNames: readonly string[]): { fetchImpl: FetchLike; calls: string[] } {
  const calls: string[] = [];
  const fetchImpl: FetchLike = (_url, init) => {
    const body = JSON.parse(String(init.body)) as { method: string };
    calls.push(body.method);
    if (body.method === "initialize") {
      return Promise.resolve(
        jsonResponse({
          jsonrpc: "2.0",
          id: 1,
          result: { protocolVersion: "2025-06-18", serverInfo: { name: "sentinel-kb" } },
        }),
      );
    }
    if (body.method === "notifications/initialized") {
      return Promise.resolve(new Response(null, { status: 202 }));
    }
    return Promise.resolve(
      jsonResponse({
        jsonrpc: "2.0",
        id: 2,
        result: { tools: toolNames.map((name) => ({ name })) },
      }),
    );
  };
  return { fetchImpl, calls };
}

/** 던져진 McpPingError를 잡아 돌려준다. 안 던지면 테스트가 죽는다. */
async function catchPingError(run: () => Promise<unknown>): Promise<McpPingError> {
  try {
    await run();
  } catch (error: unknown) {
    if (error instanceof McpPingError) return error;
    throw error;
  }
  throw new Error("McpPingError가 던져지지 않았다.");
}

describe("readPingConfig", () => {
  it("URL 끝에 /mcp를 붙인다", () => {
    const config = readPingConfig({
      SENTINEL_KB_URL: "https://kb.example.com",
      SENTINEL_KB_KEY: KEY,
    });
    expect(config.endpoint).toBe("https://kb.example.com/mcp");
  });

  it("이미 /mcp로 끝나면 두 번 붙이지 않는다", () => {
    const config = readPingConfig({
      SENTINEL_KB_URL: "https://kb.example.com/mcp",
      SENTINEL_KB_KEY: KEY,
    });
    expect(config.endpoint).toBe("https://kb.example.com/mcp");
  });

  it("트레일링 슬래시를 정리한다", () => {
    const config = readPingConfig({
      SENTINEL_KB_URL: "https://kb.example.com//",
      SENTINEL_KB_KEY: KEY,
    });
    expect(config.endpoint).toBe("https://kb.example.com/mcp");
  });

  it.each([
    ["URL 없음", { SENTINEL_KB_KEY: KEY }],
    ["키 없음", { SENTINEL_KB_URL: "https://kb.example.com" }],
    ["빈 문자열", { SENTINEL_KB_URL: "  ", SENTINEL_KB_KEY: KEY }],
    ["URL이 아님", { SENTINEL_KB_URL: "kb.example.com", SENTINEL_KB_KEY: KEY }],
    ["스킴이 http/https가 아님", { SENTINEL_KB_URL: "ftp://kb.example.com", SENTINEL_KB_KEY: KEY }],
  ])("%s → CONFIG(78)로 죽는다", async (_label, env) => {
    const error = await catchPingError(() => Promise.resolve(readPingConfig(env)));
    expect(error.exitCode).toBe(MCP_PING_EXIT.CONFIG);
  });

  it("잘못된 URL을 되비추지 않는다 — 사용자가 URL 자리에 키를 넣었을 수 있다", async () => {
    const error = await catchPingError(() =>
      Promise.resolve(readPingConfig({ SENTINEL_KB_URL: KEY, SENTINEL_KB_KEY: KEY })),
    );
    expect(error.message).not.toContain(KEY);
  });
});

describe("redactSecrets", () => {
  it("키 값을 지운다", () => {
    expect(redactSecrets(`앞 ${KEY} 뒤`, [KEY])).toBe("앞 *** 뒤");
  });

  it("정확 일치가 아니어도 Bearer 뒤 토큰을 지운다", () => {
    expect(redactSecrets("authorization: Bearer someOtherToken", [])).toBe(
      "authorization: Bearer ***",
    );
  });

  it("빈 시크릿은 문자열을 파괴하지 않는다", () => {
    expect(redactSecrets("멀쩡한 메시지", [""])).toBe("멀쩡한 메시지");
  });
});

describe("parseRpcBody", () => {
  it("application/json 본문을 읽는다", () => {
    expect(parseRpcBody("application/json", '{"result":{"ok":true}}').result).toEqual({ ok: true });
  });

  it("text/event-stream의 마지막 data: 줄을 읽는다", () => {
    const sse = 'event: message\ndata: {"result":{"ok":true}}\n\n';
    expect(parseRpcBody("text/event-stream; charset=utf-8", sse).result).toEqual({ ok: true });
  });

  it.each([
    ["빈 본문", ""],
    ["JSON이 아님", "<html>502 Bad Gateway</html>"],
    ["JSON이지만 객체가 아님", "42"],
  ])("%s → PROTOCOL(76)", async (_label, body) => {
    const error = await catchPingError(() =>
      Promise.resolve(parseRpcBody("application/json", body)),
    );
    expect(error.exitCode).toBe(MCP_PING_EXIT.PROTOCOL);
  });

  it("프록시 오류 페이지의 본문을 메시지에 싣지 않는다", async () => {
    const leaky = `<html>proxied Authorization: Bearer ${KEY}</html>`;
    const error = await catchPingError(() => Promise.resolve(parseRpcBody("text/html", leaky)));
    expect(error.message).not.toContain(KEY);
  });
});

describe("parseToolNames", () => {
  it("이름을 순서대로 뽑는다", () => {
    expect(parseToolNames({ tools: TOOLS.map((name) => ({ name })) })).toEqual(TOOLS);
  });

  it.each([
    ["tools가 없음", {}],
    ["tools가 배열이 아님", { tools: "nope" }],
    ["항목에 name이 없음", { tools: [{ title: "x" }] }],
  ])("%s → PROTOCOL(76)", async (_label, result) => {
    const error = await catchPingError(() => Promise.resolve(parseToolNames(result)));
    expect(error.exitCode).toBe(MCP_PING_EXIT.PROTOCOL);
  });
});

describe("pingMcp — 전송", () => {
  it("initialize → notifications/initialized → tools/list 순서로 말한다", async () => {
    const { fetchImpl, calls } = fetchWithTools(TOOLS);
    const result = await pingMcp({ ...CONFIG, fetchImpl });
    expect(calls).toEqual(["initialize", "notifications/initialized", "tools/list"]);
    expect(result.toolNames).toEqual(TOOLS);
  });

  it("Bearer 헤더와 두 content-type을 모두 받겠다는 Accept를 보낸다", async () => {
    let seen: Record<string, string> = {};
    const { fetchImpl } = fetchWithTools(TOOLS);
    await pingMcp({
      ...CONFIG,
      fetchImpl: (url, init) => {
        seen = init.headers as Record<string, string>;
        return fetchImpl(url, init);
      },
    });
    expect(seen["authorization"]).toBe(`Bearer ${KEY}`);
    // 이 Accept가 빠지면 Streamable HTTP 전송이 406으로 끊는다.
    expect(seen["accept"]).toContain("text/event-stream");
    expect(seen["accept"]).toContain("application/json");
  });

  it("서버가 세션 ID를 주면 이후 요청에 실어 보낸다 (stateful 전환 대비)", async () => {
    const seen: (string | undefined)[] = [];
    const { fetchImpl } = fetchWithTools(TOOLS);
    await pingMcp({
      ...CONFIG,
      fetchImpl: async (url, init) => {
        seen.push((init.headers as Record<string, string>)["mcp-session-id"]);
        const response = await fetchImpl(url, init);
        response.headers.set("mcp-session-id", "sess-1");
        return response;
      },
    });
    expect(seen).toEqual([undefined, "sess-1", "sess-1"]);
  });
});

describe("pingMcp — 실패 갈래마다 종료 코드가 갈린다", () => {
  it("네트워크 오류 → UNAVAILABLE(69)이고 원인 코드를 알려준다", async () => {
    const error = await catchPingError(() =>
      pingMcp({
        ...CONFIG,
        fetchImpl: () =>
          Promise.reject(
            Object.assign(new TypeError("fetch failed"), { cause: { code: "ECONNREFUSED" } }),
          ),
      }),
    );
    expect(error.exitCode).toBe(MCP_PING_EXIT.UNAVAILABLE);
    expect(error.message).toContain("ECONNREFUSED");
  });

  it("타임아웃 → UNAVAILABLE(69)", async () => {
    const error = await catchPingError(() =>
      pingMcp({
        ...CONFIG,
        fetchImpl: () =>
          Promise.reject(Object.assign(new Error("aborted"), { name: "TimeoutError" })),
      }),
    );
    expect(error.exitCode).toBe(MCP_PING_EXIT.UNAVAILABLE);
    expect(error.message).toContain("타임아웃");
  });

  it("401 → NO_PERM(77). 서버 미도달(69)과 구분된다", async () => {
    const error = await catchPingError(() =>
      pingMcp({
        ...CONFIG,
        fetchImpl: () => Promise.resolve(jsonResponse({ error: { code: "UNAUTHORIZED" } }, 401)),
      }),
    );
    expect(error.exitCode).toBe(MCP_PING_EXIT.NO_PERM);
    expect(error.exitCode).not.toBe(MCP_PING_EXIT.UNAVAILABLE);
  });

  it("404 → PROTOCOL(76). nginx 라우팅을 의심하라고 말한다", async () => {
    const error = await catchPingError(() =>
      pingMcp({ ...CONFIG, fetchImpl: () => Promise.resolve(jsonResponse({}, 404)) }),
    );
    expect(error.exitCode).toBe(MCP_PING_EXIT.PROTOCOL);
    expect(error.message).toContain("/mcp");
  });

  it("JSON-RPC 오류 응답 → PROTOCOL(76)", async () => {
    const error = await catchPingError(() =>
      pingMcp({
        ...CONFIG,
        fetchImpl: () =>
          Promise.resolve(jsonResponse({ jsonrpc: "2.0", id: 1, error: { message: "nope" } })),
      }),
    );
    expect(error.exitCode).toBe(MCP_PING_EXIT.PROTOCOL);
  });

  it("어떤 실패 메시지에도 키가 실리지 않는다", async () => {
    const leak = new TypeError(`request failed: Bearer ${KEY}`);
    const error = await catchPingError(() =>
      pingMcp({ ...CONFIG, fetchImpl: () => Promise.reject(leak) }),
    );
    // 라이브러리가 이미 cause만 뽑아 쓰지만, CLI의 redactSecrets가 최종 방어선이다.
    expect(redactSecrets(error.message, [KEY])).not.toContain(KEY);
  });
});

describe("assertToolCount — 붙은 뒤의 판정", () => {
  it(`도구 ${String(EXPECTED_TOOL_COUNT)}개면 통과한다`, () => {
    expect(() => {
      assertToolCount(TOOLS);
    }).not.toThrow();
  });

  it("specs/07의 도구 수와 같은 값을 기대한다", () => {
    expect(EXPECTED_TOOL_COUNT).toBe(5);
  });

  it.each([
    ["0개(스텁 서버)", []],
    ["4개(등록 누락)", TOOLS.slice(0, 4)],
    ["6개(스펙 위반 추가)", [...TOOLS, "sixth_tool"]],
  ])("%s → TOOLS_MISMATCH(1)", async (_label, names) => {
    const error = await catchPingError(() => Promise.resolve(assertToolCount(names)));
    expect(error.exitCode).toBe(MCP_PING_EXIT.TOOLS_MISMATCH);
    // 연결 문제와 헷갈리지 않게 말해 준다.
    expect(error.message).toContain("연결과 인증은 정상이다");
  });

  it("연결 실패와 도구 수 불일치는 절대 같은 코드가 아니다", () => {
    expect(MCP_PING_EXIT.TOOLS_MISMATCH).not.toBe(MCP_PING_EXIT.UNAVAILABLE);
    expect(new Set(Object.values(MCP_PING_EXIT)).size).toBe(Object.values(MCP_PING_EXIT).length);
  });
});
