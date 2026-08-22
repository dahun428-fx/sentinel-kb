import { describe, expect, it } from "vitest";

import { buildSummary, firstSentences } from "./summary.js";

describe("firstSentences — specs/04의 '첫 2문장'", () => {
  it("한국어 마침표로 두 문장을 뽑는다", () => {
    const text = "결제 큐가 멈췄다. 컨슈머가 메시지를 소비하지 않았다. 세 번째 문장은 버린다.";

    expect(firstSentences(text, 2)).toBe("결제 큐가 멈췄다. 컨슈머가 메시지를 소비하지 않았다.");
  });

  it("느낌표·물음표·전각 부호도 종결로 본다", () => {
    expect(firstSentences("왜 죽었나? 아무도 몰랐다! 세 번째.", 2)).toBe(
      "왜 죽었나? 아무도 몰랐다!",
    );
  });

  it("줄바꿈도 문장 경계다 — 구두점 없는 불릿 목록에서 본문 전체가 요약이 되면 안 된다", () => {
    const text = "- 큐가 멈춤\n- 컨슈머 재기동\n- 프리페치 하향";

    expect(firstSentences(text, 2)).toBe("- 큐가 멈춤 - 컨슈머 재기동");
  });

  it("문장이 하나뿐이면 그 하나만 돌려준다", () => {
    expect(firstSentences("한 문장뿐이다.", 2)).toBe("한 문장뿐이다.");
  });

  it("종결 부호가 아예 없으면 전체가 한 문장이다", () => {
    expect(firstSentences("종결 부호 없는 한 줄", 2)).toBe("종결 부호 없는 한 줄");
  });

  it("빈 문자열은 빈 문자열이다", () => {
    expect(firstSentences("   ", 2)).toBe("");
  });
});

describe("buildSummary", () => {
  it("근거 섹션의 첫 2문장을 쓴다", () => {
    expect(buildSummary("증상 하나. 증상 둘. 증상 셋.", "제목")).toBe("증상 하나. 증상 둘.");
  });

  /** `RecordSchema.summary`가 `min(1)`이라 빈 요약은 저장 자체가 실패한다. */
  it("근거 섹션이 비면 제목으로 폴백한다", () => {
    expect(buildSummary("", "결제 큐가 멈춘 장애")).toBe("결제 큐가 멈춘 장애");
  });

  /**
   * 구두점 없는 로그 덤프가 통째로 요약이 되면 목록 응답이 본문을 실어 나른다 —
   * NFR-03이 막으려는 상태다. 400자에서 자르고 말줄임표를 붙인다.
   */
  it("상한을 넘으면 자르고 말줄임표를 붙인다", () => {
    const summary = buildSummary("가".repeat(1000), "제목");

    expect(summary).toHaveLength(401);
    expect(summary.endsWith("…")).toBe(true);
  });

  it("상한 이하는 자르지 않는다", () => {
    const summary = buildSummary("나".repeat(400), "제목");

    expect(summary).toBe("나".repeat(400));
  });
});
