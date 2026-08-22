/**
 * 도구 개수 가드가 **실제 등록 수**를 세는지 본다.
 *
 * T-015 검증 지적(부수): 부팅 가드가 세던 것은 `REGISTRARS.length`, 즉 **배열 리터럴 길이**였다.
 * 등록기 하나가 도구 둘을 등록하면 서버에는 6개가 서는데 가드는 5를 보고 통과한다 —
 * `specs/07`의 "도구 5개, 이 이상 늘리지 않는다"와 CLAUDE.md 금지 사항이 그 경로로 뚫린다.
 */
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { describe, expect, it } from "vitest";

import type { CoreApiClient } from "../core-api-client.js";
import type { McpContext } from "../server.js";
import { registerAllTools } from "./index.js";

const coreApi: CoreApiClient = {
  read: () => Promise.reject(new Error("이 테스트는 core-api를 부르지 않는다")),
  write: () => Promise.reject(new Error("이 테스트는 core-api를 부르지 않는다")),
};
const context: McpContext = { project: "sentinel-kb", coreApi };

function emptyServer(): McpServer {
  return new McpServer({ name: "tool-count-test", version: "0.0.0" });
}

describe("registerAllTools — 도구 수 세기", () => {
  it("specs/07의 도구 5개를 등록하고 5를 보고한다", () => {
    expect(registerAllTools(emptyServer(), context)).toBe(5);
  });

  /**
   * **관측의 핵심.** 서버에 이미 도구가 하나 서 있으면 등록 후 총 6개다.
   * 실제 레지스트리를 세면 6이 나오고, 배열 리터럴 길이를 세면 5가 나온다 —
   * 즉 이 단언 하나가 두 구현을 갈라놓는다. (`createMcpServer`의 `registered !== MAX_TOOLS`
   * 가드가 이 값을 보므로, 6이 나와야 부팅이 실제로 죽는다.)
   */
  it("등록기 배열 길이가 아니라 서버에 실제로 선 도구 수를 센다", () => {
    const server = emptyServer();
    server.registerTool(
      "sneaked_in",
      { description: "등록기 하나가 도구 둘을 등록한 상황을 흉내낸다", inputSchema: {} },
      () => ({ content: [{ type: "text", text: "" }] }),
    );

    expect(
      registerAllTools(server, context),
      "배열 리터럴 길이를 세고 있다 — 6번째 도구가 가드를 통과한다",
    ).toBe(6);
  });
});
