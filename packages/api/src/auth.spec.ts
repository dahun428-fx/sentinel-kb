import { describe, expect, it } from "vitest";

import { ApiKeyConfigError, parseApiKeys, resolveProject } from "./auth.js";
import { HttpError } from "./errors.js";

/**
 * 기대값은 **리터럴**이다. `.env.example`이나 구현 상수에서 끌어오면 상수를 고쳤을 때
 * 기대값도 따라 움직여 아무것도 검증하지 못한다(T-004·T-006에서 반복 확인된 실패 양식).
 */
describe("parseApiKeys — 부팅 시 1회 파싱", () => {
  it(".env.example 형식을 키→project 맵으로 읽는다", () => {
    const keys = parseApiKeys("devkey123:sentinel-kb,devkey456:bizcare-web");

    expect(keys.get("devkey123")).toBe("sentinel-kb");
    expect(keys.get("devkey456")).toBe("bizcare-web");
    expect(keys.size).toBe(2);
  });

  it("공백과 후행 콤마를 허용한다", () => {
    const keys = parseApiKeys("  a:proj-a , b:proj-b ,");

    expect([...keys.entries()]).toEqual([
      ["a", "proj-a"],
      ["b", "proj-b"],
    ]);
  });

  /**
   * 오설정은 **생성 시점에** 터져야 한다. 빈 맵으로 부팅하면 모든 요청이 401이 되고
   * 원인은 로그 어디에도 남지 않는다 — 그게 T-006이 넘긴 인계 패턴의 요지다.
   */
  it.each([
    ["미설정", undefined],
    ["빈 문자열", ""],
    ["공백만", "   "],
    ["콜론 없음", "devkey123"],
    ["콜론 둘", "devkey123:sentinel-kb:extra"],
    ["빈 키", ":sentinel-kb"],
    ["빈 project", "devkey123:"],
    ["키 중복", "devkey123:sentinel-kb,devkey123:bizcare-web"],
    ["항목 없음", ",,,"],
  ])("%s이면 던진다", (_label, raw) => {
    expect(() => parseApiKeys(raw)).toThrow(ApiKeyConfigError);
  });
});

describe("resolveProject", () => {
  const keys = parseApiKeys("devkey123:sentinel-kb");

  it("등록된 키를 project로 해석한다", () => {
    expect(resolveProject("Bearer devkey123", keys)).toBe("sentinel-kb");
  });

  it("스킴 이름의 대소문자를 가리지 않는다 (RFC 7235)", () => {
    expect(resolveProject("bearer devkey123", keys)).toBe("sentinel-kb");
  });

  it.each([
    ["헤더 없음", undefined],
    ["스킴 없음", "devkey123"],
    ["다른 스킴", "Basic devkey123"],
    ["미등록 키", "Bearer nope"],
    ["빈 토큰", "Bearer "],
  ])("%s이면 401을 던진다", (_label, header) => {
    let thrown: unknown;
    try {
      resolveProject(header, keys);
    } catch (error: unknown) {
      thrown = error;
    }
    expect(thrown).toBeInstanceOf(HttpError);
    expect((thrown as HttpError).statusCode).toBe(401);
    expect((thrown as HttpError).code).toBe("UNAUTHORIZED");
  });

  it("실패 사유를 메시지로 구분하지 않는다 — 키 유효성 오라클이 되면 안 된다", () => {
    const messages = [undefined, "Basic x", "Bearer nope"].map((header) => {
      try {
        resolveProject(header, keys);
        return "<no error>";
      } catch (error: unknown) {
        return (error as HttpError).message;
      }
    });

    expect(new Set(messages).size).toBe(1);
  });
});
