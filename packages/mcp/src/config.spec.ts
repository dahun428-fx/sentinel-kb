import { describe, expect, it } from "vitest";

import { readMcpConfig } from "./config.js";

const BASE = { API_KEYS: "key-a:sentinel-kb" };

describe("readMcpConfig — CORE_API_URL (T-059, P1 리뷰 A7)", () => {
  it("빈 문자열·공백은 미설정으로 보고 기본 주소를 쓴다", () => {
    expect(readMcpConfig({ ...BASE, CORE_API_URL: "" }).coreApiBaseUrl).toBe("http://localhost:3001");
    expect(readMcpConfig({ ...BASE, CORE_API_URL: "   " }).coreApiBaseUrl).toBe("http://localhost:3001");
  });

  it("값이 있으면 그대로 쓴다", () => {
    expect(readMcpConfig({ ...BASE, CORE_API_URL: " http://core-api:3001 " }).coreApiBaseUrl).toBe(
      "http://core-api:3001",
    );
  });
});
