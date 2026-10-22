import { describe, expect, it } from "vitest";

import {
  ApiKeyConfigError,
  parseApiKeys,
  apiKeyOptionsFor,
  PRODUCTION_MIN_KEY_LENGTH,
} from "./api-keys.js";

/**
 * 파싱 규칙 자체의 행동은 `packages/api/src/auth.spec.ts`와 `packages/mcp/src/auth.spec.ts`가
 * 이미 양쪽에서 잠근다(T-037은 그 테스트들을 한 글자도 고치지 않았다 — 두 표면이 같은 구현을
 * 쓰는지 확인하는 관측점이라 일부러 남겼다).
 *
 * 여기서 잠그는 것은 **T-037이 새로 만든 보장**이다: 에러 메시지가 `API_KEYS` 원문을 싣지 않는다.
 * 이 메시지는 부팅 실패 경로에서 stderr로 나가 컨테이너 로그·CI 로그·로그 수집기로 흘러간다.
 */
describe("parseApiKeys 에러 메시지 — 설정 원문을 로그로 흘리지 않는다", () => {
  function messageOf(raw: string): string {
    try {
      parseApiKeys(raw);
    } catch (error: unknown) {
      expect(error).toBeInstanceOf(ApiKeyConfigError);
      return (error as Error).message;
    }
    throw new Error("던졌어야 한다");
  }

  it("콜론이 셋인 항목의 원문이 메시지에 없다", () => {
    const message = messageOf("ok:proj,supersecretkey:proj:extra");

    expect(message).not.toContain("supersecretkey");
    expect(message).not.toContain("supersecretkey:proj:extra");
  });

  it("빈 project 항목의 키가 메시지에 없다", () => {
    expect(messageOf("supersecretkey:")).not.toContain("supersecretkey");
  });

  it("중복 키 값이 메시지에 없다", () => {
    expect(messageOf("supersecretkey:p1,supersecretkey:p2")).not.toContain("supersecretkey");
  });

  /**
   * 값을 지우고 끝내면 운영자가 무엇이 잘못됐는지 알 수 없다 — 그건 개선이 아니다.
   * 그래서 값 대신 **콤마로 가른 1-based 항목 번호**를 말한다. 빈 조각도 자리를 차지하므로
   * 운영자가 `.env`에서 세는 콤마 수와 일치한다.
   */
  it("대신 몇 번째 항목인지를 말한다 — 진단성은 인덱스로 보존된다", () => {
    expect(messageOf("a:p1,,bad")).toContain("3번째");
    expect(messageOf("a:p1,b:p2,c:")).toContain("3번째");
  });

  it("중복은 두 항목 번호를 모두 말한다", () => {
    const message = messageOf("a:p1,b:p2,a:p3");

    expect(message).toContain("3번째");
    expect(message).toContain("1번째");
  });
});

describe("운영 키 최소 길이 (T-061, T-050 F-2)", () => {
  const LONG = "a".repeat(32);

  it("minKeyLength보다 짧은 키는 몇 번째 항목인지만 대고 거부한다 — 값은 싣지 않는다", () => {
    expect(() => parseApiKeys(`${LONG}:sentinel-kb,devkey123:other`, { minKeyLength: 32 })).toThrow(
      /2번째 항목의 키가 32자보다 짧다/,
    );
    try {
      parseApiKeys("devkey123:other", { minKeyLength: 32 });
    } catch (error) {
      expect(String(error)).not.toContain("devkey123");
    }
  });

  it("production에서만 최소 길이를 건다", () => {
    expect(apiKeyOptionsFor({ NODE_ENV: "production" })).toEqual({
      minKeyLength: PRODUCTION_MIN_KEY_LENGTH,
    });
    expect(apiKeyOptionsFor({ NODE_ENV: "development" })).toEqual({});
    expect(parseApiKeys("devkey123:sentinel-kb", apiKeyOptionsFor({})).get("devkey123")).toBe(
      "sentinel-kb",
    );
  });
});
