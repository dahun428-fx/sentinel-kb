import { describe, expect, it } from "vitest";

import { CreateRecordInput, SearchRequest } from "./index.js";

describe("@sentinel/contracts smoke", () => {
  it("유효한 incident 입력을 파싱한다", () => {
    const result = CreateRecordInput.safeParse({
      type: "incident",
      title: "MCP 서버 504 게이트웨이 타임아웃",
      symptom: "search_knowledge 호출이 30초 후 504로 실패한다",
      resolution: "nginx proxy_read_timeout을 120s로 올리고 keepalive 설정 추가",
    });
    expect(result.success).toBe(true);
  });

  it("잘못된 입력은 거부한다", () => {
    const result = SearchRequest.safeParse({ query: "a" });
    expect(result.success).toBe(false);
  });
});
