/**
 * T-022 단위 테스트 — 중복 제거 키와 **자동 승격 금지 경계**.
 *
 * 기대값은 구현 상수를 참조하지 않고 리터럴로 박는다(T-004의 교훈).
 */
import { EvalCaseSchema } from "@sentinel/contracts";
import { describe, expect, it } from "vitest";

import {
  APPROVED_EVAL_CASE_FILTER,
  EVAL_CASE_CANDIDATE_FILTER,
  evalCaseCandidateId,
  feedbackDocumentId,
} from "./feedback.js";

const RECORD_A = "6650a1b2c3d4e5f601020304";
const RECORD_B = "6650a1b2c3d4e5f601020305";

describe("feedbackDocumentId", () => {
  it("같은 (project, recordId, query)는 항상 같은 문서를 가리킨다", () => {
    expect(feedbackDocumentId("sentinel-kb", RECORD_A, "큐가 멈췄다").toHexString()).toBe(
      feedbackDocumentId("sentinel-kb", RECORD_A, "큐가 멈췄다").toHexString(),
    );
  });

  it.each([
    ["project", feedbackDocumentId("bizcare-web", RECORD_A, "큐가 멈췄다")],
    ["recordId", feedbackDocumentId("sentinel-kb", RECORD_B, "큐가 멈췄다")],
    ["query", feedbackDocumentId("sentinel-kb", RECORD_A, "큐가 느리다")],
  ])("%s가 다르면 다른 문서다", (_label, other) => {
    expect(other.toHexString()).not.toBe(
      feedbackDocumentId("sentinel-kb", RECORD_A, "큐가 멈췄다").toHexString(),
    );
  });

  /**
   * **구분자 없는 연결에서 실제로 충돌하는 쌍이다.** 아래 두 입력은 `parts.join("")`에서
   * 글자 하나까지 같은 키 문자열을 만든다:
   *
   *   "feedback" + "a"  + "6650a1b2c3d4e5f601020304" + "00"
   *   "feedback" + "a6" + "650a1b2c3d4e5f6010203040" + "0"
   *   → 둘 다 "feedbacka6650a1b2c3d4e5f60102030400"
   *
   * 두 recordId 모두 24자 hex라 실제로 존재할 수 있는 값이고, project는 인증 키가 주는
   * 값이며 query는 **호출자가 그대로 고르는 문자열**이다. 즉 구분자가 없으면 project `a6`의
   * 클라이언트가 query를 골라 project `a`의 피드백 문서를 덮어쓸 수 있다 —
   * 주석이 말하는 "경계를 넘어 다른 키와 충돌"이 정확히 이 모양이다.
   *
   * 픽스처가 조용히 충돌 쌍이기를 그만두면 이 테스트는 공허해지므로, 충돌 자체를 먼저 단언한다.
   * (T-044 감사: NUL 구분자를 지우는 `join("")` 뮤턴트가 전건 통과했다.)
   */
  it("구분자 경계가 다른 두 입력이 같은 문서를 가리키지 않는다", () => {
    const left = ["feedback", "a", "6650a1b2c3d4e5f601020304", "00"] as const;
    const right = ["feedback", "a6", "650a1b2c3d4e5f6010203040", "0"] as const;
    // 픽스처 자기검사: 구분자가 없으면 두 키는 같은 문자열이다.
    expect(left.join("")).toBe(right.join(""));

    expect(feedbackDocumentId(left[1], left[2], left[3]).toHexString()).not.toBe(
      feedbackDocumentId(right[1], right[2], right[3]).toHexString(),
    );
  });

  it("24자 hex ObjectId다 — 계약의 ObjectIdString을 만족한다", () => {
    expect(feedbackDocumentId("sentinel-kb", RECORD_A, "q").toHexString()).toMatch(
      /^[0-9a-f]{24}$/,
    );
  });
});

describe("evalCaseCandidateId", () => {
  it("query만으로 결정된다 — eval_cases에는 project 필드가 없다(specs/02)", () => {
    expect(evalCaseCandidateId("큐가 멈췄다").toHexString()).toBe(
      evalCaseCandidateId("큐가 멈췄다").toHexString(),
    );
    expect(evalCaseCandidateId("큐가 느리다").toHexString()).not.toBe(
      evalCaseCandidateId("큐가 멈췄다").toHexString(),
    );
  });

  it("피드백 키와 겹치지 않는다", () => {
    expect(evalCaseCandidateId("큐가 멈췄다").toHexString()).not.toBe(
      feedbackDocumentId("sentinel-kb", RECORD_A, "큐가 멈췄다").toHexString(),
    );
  });
});

describe("골든셋 경계", () => {
  /** 이 모듈의 쓰기 경로가 만드는 후보 문서의 형상 그대로다 — approvedBy가 없다. */
  const CANDIDATE = {
    _id: evalCaseCandidateId("큐가 멈췄다").toHexString(),
    query: "큐가 멈췄다",
    expectedRecordIds: [RECORD_A],
  };

  it("후보는 EvalCaseSchema를 통과하지 못한다 — 계약으로 골든셋을 읽는 러너가 쓸 수 없다", () => {
    expect(EvalCaseSchema.safeParse(CANDIDATE).success).toBe(false);
  });

  it("사람이 approvedBy를 채워야만 골든셋이 된다", () => {
    expect(EvalCaseSchema.safeParse({ ...CANDIDATE, approvedBy: "human" }).success).toBe(true);
  });

  it("골든셋 필터는 사람 승인분만 고른다(specs/05)", () => {
    expect(APPROVED_EVAL_CASE_FILTER).toEqual({ approvedBy: "human" });
  });

  it("후보 필터는 approvedBy가 없는 문서만 고른다", () => {
    expect(EVAL_CASE_CANDIDATE_FILTER).toEqual({ approvedBy: { $exists: false } });
  });
});
