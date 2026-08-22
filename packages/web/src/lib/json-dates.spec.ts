import { RecordSchema } from "@sentinel/contracts";
import { describe, expect, it } from "vitest";

import { reviveDates } from "./json-dates";

const RAW_INCIDENT = {
  _id: "0123456789abcdef01234567",
  type: "incident",
  project: "sentinel-kb",
  title: "결제 웹훅 타임아웃",
  summary: "웹훅 처리기가 30초를 넘겨 결제 확정이 밀렸다.",
  severity: "SEV2",
  tags: ["payment"],
  sanitizeFlags: [],
  relations: [],
  status: "published",
  embeddingVersion: 1,
  symptom: "웹훅이 30초 뒤 504로 끊긴다.",
  resolution: "핸들러를 큐로 분리하고 즉시 202를 준다.",
  createdAt: "2026-08-21T04:05:06.000Z",
  updatedAt: "2026-08-21T04:05:06.000Z",
};

describe("reviveDates", () => {
  it("contracts의 z.date() 필드를 되살려 HTTP 응답이 그대로 파싱된다", () => {
    // 되살리기 전에는 계약이 거부한다 — 이 테스트가 지키는 것이 그 경계다.
    expect(RecordSchema.safeParse(RAW_INCIDENT).success).toBe(false);

    const parsed = RecordSchema.parse(reviveDates(RAW_INCIDENT));
    expect(parsed.createdAt).toBeInstanceOf(Date);
    expect(parsed.createdAt.toISOString()).toBe("2026-08-21T04:05:06.000Z");
  });

  it("날짜 키가 아니면 문자열 그대로 둔다", () => {
    expect(reviveDates({ title: "2026-08-21T04:05:06.000Z" })).toEqual({
      title: "2026-08-21T04:05:06.000Z",
    });
  });

  it("ISO 형식이 아니면 손대지 않는다", () => {
    expect(reviveDates({ createdAt: "어제" })).toEqual({ createdAt: "어제" });
  });

  it("배열과 중첩 객체를 따라간다", () => {
    const revived = reviveDates({ items: [{ createdAt: "2026-08-21T04:05:06.000Z" }] }) as {
      items: { createdAt: unknown }[];
    };
    expect(revived.items[0]?.createdAt).toBeInstanceOf(Date);
  });

  it("입력을 변형하지 않는다", () => {
    const input = { createdAt: "2026-08-21T04:05:06.000Z" };
    reviveDates(input);
    expect(typeof input.createdAt).toBe("string");
  });
});
