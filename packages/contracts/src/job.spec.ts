import { describe, expect, it } from "vitest";

import { JobSchema, JobStatus, JobType } from "./job.js";

const VALID_ID = "0123456789abcdef01234567";

function validJob(): Record<string, unknown> {
  return {
    _id: VALID_ID,
    type: "embed",
    recordId: VALID_ID,
    status: "pending",
    attempts: 0,
    createdAt: new Date("2026-01-01T00:00:00Z"),
    updatedAt: new Date("2026-01-01T00:00:00Z"),
  };
}

describe("JobStatus", () => {
  it("DB-DESIGN.md:69의 5개 상태만 허용한다", () => {
    expect(JobStatus.options).toEqual(["pending", "running", "failed", "dead", "done"]);
  });

  it("스펙에 없는 상태는 거부한다", () => {
    expect(JobStatus.safeParse("queued").success).toBe(false);
    expect(JobStatus.safeParse("PENDING").success).toBe(false);
  });
});

describe("JobType", () => {
  it("specs/03 §1-1이 정의한 embed 하나만 허용한다", () => {
    expect(JobType.safeParse("embed").success).toBe(true);
    expect(JobType.safeParse("reindex").success).toBe(false);
    expect(JobType.safeParse("").success).toBe(false);
  });
});

describe("JobSchema", () => {
  it("유효한 작업을 파싱한다", () => {
    expect(JobSchema.safeParse(validJob()).success).toBe(true);
  });

  it("lastError는 선택 필드다", () => {
    const result = JobSchema.safeParse({
      ...validJob(),
      status: "dead",
      attempts: 4,
      lastError: "voyage 429 rate limited",
    });
    expect(result.success).toBe(true);
  });

  it("attempts가 음수면 거부한다", () => {
    // specs/03 §1-4의 재시도 카운터다 — 음수는 dead 판정을 영원히 미룬다.
    expect(JobSchema.safeParse({ ...validJob(), attempts: -1 }).success).toBe(false);
  });

  it("attempts가 정수가 아니면 거부한다", () => {
    expect(JobSchema.safeParse({ ...validJob(), attempts: 1.5 }).success).toBe(false);
  });

  it("type이 embed가 아니면 거부한다", () => {
    expect(JobSchema.safeParse({ ...validJob(), type: "rerank" }).success).toBe(false);
  });

  it("status가 열거 밖이면 거부한다", () => {
    expect(JobSchema.safeParse({ ...validJob(), status: "retrying" }).success).toBe(false);
  });

  it("recordId가 24자 hex가 아니면 거부한다", () => {
    expect(JobSchema.safeParse({ ...validJob(), recordId: "not-an-objectid" }).success).toBe(false);
  });

  it("알 수 없는 필드를 거부한다(strict)", () => {
    expect(JobSchema.safeParse({ ...validJob(), priority: 1 }).success).toBe(false);
  });
});
