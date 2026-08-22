import { ObjectId } from "mongodb";
import { describe, expect, it } from "vitest";

import { decodeCursor, encodeCursor } from "./cursor.js";

describe("cursor 인코딩", () => {
  it("왕복해도 같은 값이다", () => {
    const cursor = {
      createdAt: new Date("2026-01-01T00:00:00.000Z"),
      id: new ObjectId("0123456789abcdef01234567"),
    };

    const decoded = decodeCursor(encodeCursor(cursor));

    expect(decoded?.createdAt.toISOString()).toBe("2026-01-01T00:00:00.000Z");
    expect(decoded?.id.toHexString()).toBe("0123456789abcdef01234567");
  });

  /** 평문이면 클라이언트가 값을 조립하기 시작하고, 그 순간 정렬 키 변경이 breaking change가 된다. */
  it("불투명하다 — 원문이 그대로 보이지 않는다", () => {
    const encoded = encodeCursor({
      createdAt: new Date("2026-01-01T00:00:00.000Z"),
      id: new ObjectId("0123456789abcdef01234567"),
    });

    expect(encoded).not.toContain("2026-01-01");
    expect(encoded).not.toContain("0123456789abcdef01234567");
  });

  it.each([
    ["빈 문자열", ""],
    ["구분자 없음", Buffer.from("2026-01-01T00:00:00.000Z", "utf8").toString("base64url")],
    ["날짜가 아님", Buffer.from("nope|0123456789abcdef01234567", "utf8").toString("base64url")],
    ["id가 hex가 아님", Buffer.from("2026-01-01T00:00:00.000Z|zzzz", "utf8").toString("base64url")],
    ["base64가 아님", "!!!not-base64!!!"],
  ])("%s이면 undefined다 — 던지면 500이 된다", (_label, encoded) => {
    expect(decodeCursor(encoded)).toBeUndefined();
  });
});
