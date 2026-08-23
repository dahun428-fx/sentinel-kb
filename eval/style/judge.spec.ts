/**
 * judge의 계약. **못 읽은 응답을 판정으로 접지 않는 것**과 **자격증명 없이 서지 않는 것**이
 * 두 축이다. 둘 다 접으면 판별 정확도가 모델이 아니라 파서·기본값의 산물이 된다.
 */
import { describe, expect, it } from "vitest";

import {
  createFixtureStyleJudge,
  parseStyleJudgement,
  renderStyleJudgeMessage,
  resolveStyleJudge,
  StyleJudgeCallError,
  StyleJudgeUnavailableError,
} from "./judge.js";

describe("parseStyleJudgement", () => {
  it("JSON 한 줄을 읽는다", () => {
    const parsed = parseStyleJudgement('{"verdict":"ai","confidence":4,"reason":"대칭 구조."}');

    expect(parsed).toEqual({ verdict: "ai", confidence: 4, reason: "대칭 구조." });
  });

  it("코드 펜스로 감싸 와도 읽는다", () => {
    const parsed = parseStyleJudgement(
      '```json\n{"verdict":"human","confidence":2,"reason":"오타가 있다."}\n```',
    );

    expect(parsed.verdict).toBe("human");
  });

  it("JSON이 없으면 던진다 — 기본값으로 내려앉지 않는다", () => {
    expect(() => parseStyleJudgement("아마도 AI가 쓴 것 같습니다")).toThrow(StyleJudgeCallError);
  });

  it("verdict가 ai/human이 아니면 던진다 — 한쪽으로 접으면 정확도가 파서의 산물이 된다", () => {
    expect(() => parseStyleJudgement('{"verdict":"unsure","confidence":3,"reason":"x"}')).toThrow(
      StyleJudgeCallError,
    );
  });

  it("confidence가 1–5 밖이면 던진다", () => {
    expect(() => parseStyleJudgement('{"verdict":"ai","confidence":9,"reason":"x"}')).toThrow(
      StyleJudgeCallError,
    );
  });

  it("근거는 240자에서 자른다 — 리포트 스키마의 상한과 같다", () => {
    const parsed = parseStyleJudgement(
      JSON.stringify({ verdict: "ai", confidence: 3, reason: "가".repeat(400) }),
    );

    expect(parsed.reason).toHaveLength(240);
  });

  it("근거가 없으면 빈 문자열이다 — 판정 자체를 버리지는 않는다", () => {
    expect(parseStyleJudgement('{"verdict":"ai","confidence":3}').reason).toBe("");
  });
});

describe("resolveStyleJudge", () => {
  it("자격증명이 없으면 judge를 세우지 않고 던진다", () => {
    expect(() => resolveStyleJudge({})).toThrow(StyleJudgeUnavailableError);
  });

  it("왜 거절했는지, 무엇을 설정해야 하는지 알려준다", () => {
    try {
      resolveStyleJudge({});
      expect.unreachable("던졌어야 한다");
    } catch (error) {
      const message = (error as Error).message;
      expect(message).toContain("EVAL_JUDGE_MODEL");
      expect(message).toContain("고정 응답");
    }
  });
});

describe("createFixtureStyleJudge", () => {
  it("trusted가 false다 — 이 judge로 낸 리포트는 측정이 아니다", () => {
    const judge = createFixtureStyleJudge(() => ({
      verdict: "ai",
      confidence: 3,
      reason: "픽스처",
    }));

    expect(judge.trusted).toBe(false);
    expect(judge.provider).toBe("fixture");
  });
});

describe("renderStyleJudgeMessage", () => {
  it("글을 태그 블록에 가둔다 — 과업 지시와 판정 대상의 경계를 만든다", () => {
    const rendered = renderStyleJudgeMessage({ itemId: "ITEM-02", text: "본문" });

    expect(rendered).toContain('<piece id="ITEM-02">');
    expect(rendered).toContain("</piece>");
  });

  it("긴 글은 자른다 — 요청이 무한히 커지지 않게", () => {
    const rendered = renderStyleJudgeMessage({ itemId: "ITEM-01", text: "가".repeat(9000) });

    expect(rendered.length).toBeLessThan(5000);
  });
});
