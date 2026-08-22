/**
 * stdio 부팅 경로 단위 테스트.
 *
 * 통합 테스트(`mcp-transports.int.spec.ts`)는 stdio를 **자식 프로세스로 spawn**한다 —
 * 프로세스 경계 너머라 프로세스 안에서 무엇이 서버로 주입되는지는 볼 수 없다.
 * 그래서 주입 관측은 여기서, 같은 프로세스 안에서 한다.
 */
import type { Transport } from "@modelcontextprotocol/sdk/shared/transport.js";
import { describe, expect, it } from "vitest";

import { McpAuthError, parseApiKeys } from "./auth.js";
import type { CoreApiClient } from "./core-api-client.js";
import { createMcpServer, type McpContext } from "./server.js";
import { startStdioServer, STDIO_AUTH_FAILURE_MESSAGE } from "./stdio.js";

const VALID_KEY = "stdio-unit-key";
const OTHER_KEY = "stdio-unit-other-key";
const API_KEYS = parseApiKeys(`${VALID_KEY}:sentinel-kb,${OTHER_KEY}:bizcare-web`);

const unusedCoreApi: CoreApiClient = {
  read: () => Promise.reject(new Error("도구가 없다 — 불릴 리 없다")),
  write: () => Promise.reject(new Error("도구가 없다 — 불릴 리 없다")),
};

/** 실제 `process.stdin`/`stdout`을 물지 않는 전송. 부팅 경로만 태운다. */
function noopTransport(): Transport {
  return {
    start: () => Promise.resolve(),
    send: () => Promise.resolve(),
    close: () => Promise.resolve(),
  };
}

async function boot(bearerKey: string | undefined, captured: McpContext[]): Promise<void> {
  const server = await startStdioServer({
    apiKeys: API_KEYS,
    bearerKey,
    coreApiBaseUrl: "http://unused.invalid",
    createCoreApi: () => unusedCoreApi,
    createTransport: noopTransport,
    // 실제 팩토리를 그대로 쓰되 인자만 들여다본다.
    createServer: (context) => {
      captured.push(context);
      return createMcpServer(context);
    },
  });
  await server.close();
}

describe("startStdioServer — project 주입", () => {
  /**
   * HTTP 쪽과 **같은 이유**로 필요한 테스트다. stdio에는 로그 엔트리조차 없어서
   * `createMcpServer({ project: "WRONG" })`로 박아도 관측할 데가 한 곳도 없었다.
   * 도구가 0개라 프로토콜 표면에도 나타나지 않는다 — 주입 지점이 유일한 관측 지점이다.
   */
  it.each([
    [VALID_KEY, "sentinel-kb"],
    [OTHER_KEY, "bizcare-web"],
  ])("SENTINEL_KB_KEY=%s로 뜨면 주입된 project가 %s다", async (key, expected) => {
    const captured: McpContext[] = [];

    await boot(key, captured);

    expect(captured, "서버 팩토리가 불리지 않았다 — 관측 자체가 죽었다.").toHaveLength(1);
    expect(
      captured[0]?.project,
      "stdio가 서버에 넘기는 project가 키를 따라가지 않는다 — 상수로 박혔을 수 있다.",
    ).toBe(expected);
  });

  it("core-api 클라이언트도 같은 컨텍스트로 함께 넘어간다", async () => {
    const captured: McpContext[] = [];

    await boot(VALID_KEY, captured);

    expect(captured[0]?.coreApi).toBe(unusedCoreApi);
  });
});

describe("startStdioServer — 부팅 실패 진단", () => {
  it.each([
    ["키 미설정", undefined],
    ["미등록 키", "not-a-registered-key"],
  ])("%s면 뜨지 않는다", async (_label, key) => {
    const captured: McpContext[] = [];
    await expect(boot(key, captured)).rejects.toBeInstanceOf(McpAuthError);
    expect(captured, "인증 실패인데 서버가 만들어졌다").toHaveLength(0);
  });

  /**
   * stdio에는 HTTP 헤더가 **없다.** HTTP 경로의 무오라클 문구
   * ("유효한 `Authorization: Bearer <key>` 헤더가 필요하다")가 그대로 stderr로 나가면
   * 운영자는 존재하지 않는 헤더를 찾게 되고 실제 원인(`SENTINEL_KB_KEY`)에 닿지 못한다.
   */
  it("실패 메시지가 존재하지 않는 HTTP 헤더를 가리키지 않는다", async () => {
    const message = await boot(undefined, []).catch((error: unknown) => (error as Error).message);

    expect(message).toBe(STDIO_AUTH_FAILURE_MESSAGE);
    expect(message).toContain("SENTINEL_KB_KEY");
    expect(message).not.toContain("Authorization");
    expect(message).not.toContain("헤더");
  });

  /**
   * 진단을 늘렸다고 키를 찍기 시작하면 안 된다 — stderr는 CI 로그·터미널 스크롤백으로
   * 흘러나가는 경로다. 무오라클 완화는 "무엇이 문제인지"까지고 "키가 무엇이었는지"가 아니다.
   */
  it("진단이 자세해져도 키 값 자체는 찍지 않는다", async () => {
    const secret = "leaked-stdio-key-value";
    const error = await boot(secret, []).catch((e: unknown) => e);

    expect((error as Error).message).not.toContain(secret);
    expect(JSON.stringify(error, Object.getOwnPropertyNames(error))).not.toContain(secret);
  });
});
