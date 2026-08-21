import { describe, expect, it } from "vitest";

import { FeedbackRequest, FeedbackSchema } from "./feedback.js";

const VALID_REQUEST = {
  recordId: "0123456789abcdef01234567",
  query: "MCP 504",
  helped: true,
};

describe("FeedbackRequest", () => {
  it("specs/04의 {recordId, query, helped, note?}를 파싱한다", () => {
    expect(FeedbackRequest.safeParse(VALID_REQUEST).success).toBe(true);
    expect(
      FeedbackRequest.safeParse({ ...VALID_REQUEST, note: "정확했다" }).success,
    ).toBe(true);
  });

  it("helped는 boolean이어야 한다", () => {
    expect(FeedbackRequest.safeParse({ ...VALID_REQUEST, helped: "yes" }).success).toBe(
      false,
    );
  });

  it("project는 서버가 주입하므로 바디로 받지 않는다", () => {
    expect(
      FeedbackRequest.safeParse({ ...VALID_REQUEST, project: "other" }).success,
    ).toBe(false);
  });
});

describe("FeedbackSchema", () => {
  it("저장된 피드백은 project와 createdAt을 갖는다", () => {
    expect(
      FeedbackSchema.safeParse({
        ...VALID_REQUEST,
        _id: "0123456789abcdef01234568",
        project: "sentinel-kb",
        createdAt: new Date(),
      }).success,
    ).toBe(true);

    expect(
      FeedbackSchema.safeParse({ ...VALID_REQUEST, _id: "0123456789abcdef01234568" })
        .success,
    ).toBe(false);
  });
});
