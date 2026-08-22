import { describe, expect, it } from "vitest";

import { CORE_API_KEY_ENV, CORE_API_URL_ENV, readCoreApiConfig } from "./env";

describe("readCoreApiConfig", () => {
  it("키가 없으면 던진다 — 익명 요청의 401은 화면에서 '결과 없음'과 구분되지 않는다", () => {
    expect(() => readCoreApiConfig({})).toThrow(/CORE_API_KEY/);
    expect(() => readCoreApiConfig({ [CORE_API_KEY_ENV]: "   " })).toThrow(/CORE_API_KEY/);
  });

  it("URL이 없으면 CORE_API_PORT 기본값(3001)으로 폴백한다", () => {
    expect(readCoreApiConfig({ [CORE_API_KEY_ENV]: "devkey123" })).toEqual({
      baseUrl: "http://localhost:3001",
      apiKey: "devkey123",
    });
  });

  it("baseUrl 끝의 슬래시를 떼어 `//v1/search` 같은 경로를 막는다", () => {
    const config = readCoreApiConfig({
      [CORE_API_KEY_ENV]: "devkey123",
      [CORE_API_URL_ENV]: "http://core-api:3001///",
    });
    expect(config.baseUrl).toBe("http://core-api:3001");
  });

  it("환경변수 이름에 NEXT_PUBLIC_ 접두사를 쓰지 않는다 — 붙는 순간 클라이언트로 인라인된다", () => {
    expect(CORE_API_KEY_ENV.startsWith("NEXT_PUBLIC_")).toBe(false);
    expect(CORE_API_URL_ENV.startsWith("NEXT_PUBLIC_")).toBe(false);
  });
});
