/**
 * judge 경계. **모델을 부르지 않고** 파싱·게이트·프레이밍만 본다(specs/05 결정론 원칙).
 */
import { describe, expect, it } from "vitest";

import {
  JUDGE_MODEL_ENV,
  JudgeCallError,
  JudgeUnavailableError,
  createFixtureJudge,
  parseJudgement,
  renderJudgeMessage,
  resolveJudge,
} from "./judge.js";

describe("resolveJudge", () => {
  /** **자격증명 없이 판정하는 변경이 들어오면 여기서 죽는다.** */
  it("모델·키가 없으면 던진다 — 픽스처로 조용히 내려앉지 않는다", () => {
    expect(() => resolveJudge({}, false)).toThrow(JudgeUnavailableError);
    expect(() => resolveJudge({}, false)).toThrow(new RegExp(JUDGE_MODEL_ENV));
  });

  it("--allow-fixture-judge면 픽스처로 내려가되 trusted:false다", () => {
    const judge = resolveJudge({}, true);
    expect(judge.provenance.trusted).toBe(false);
  });

  it("키만 있고 모델이 없어도 던진다", () => {
    expect(() => resolveJudge({ ANTHROPIC_API_KEY: "sk-test" }, false)).toThrow(
      JudgeUnavailableError,
    );
  });
});

describe("createFixtureJudge", () => {
  it("정의상 신뢰할 수 없다", async () => {
    const judge = createFixtureJudge();
    expect(judge.provenance).toEqual({ provider: "fixture", model: "fixture", trusted: false });
    await expect(judge.judge({ query: "q", answer: "a", sources: [] })).resolves.toMatchObject({
      faithfulness: 3,
    });
  });
});

describe("parseJudgement", () => {
  it("JSON 한 줄을 읽는다", () => {
    expect(parseJudgement('{"faithfulness": 5, "usefulness": 4, "note": "좋다"}')).toEqual({
      faithfulness: 5,
      usefulness: 4,
      note: "좋다",
    });
  });

  it("코드 펜스로 감싸도 읽는다", () => {
    expect(
      parseJudgement('```json\n{"faithfulness": 3, "usefulness": 3, "note": ""}\n```'),
    ).toMatchObject({ faithfulness: 3 });
  });

  /** **기본값으로 내려앉으면 지표가 모델이 아니라 파서의 산물이 된다.** */
  it("숫자를 못 읽으면 기본값을 채우지 않고 던진다", () => {
    expect(() => parseJudgement("점수를 매길 수 없습니다")).toThrow(JudgeCallError);
    expect(() => parseJudgement('{"faithfulness": "높음", "usefulness": 4}')).toThrow(
      JudgeCallError,
    );
  });

  it("1–5 범위를 벗어나면 던진다", () => {
    expect(() => parseJudgement('{"faithfulness": 0, "usefulness": 4}')).toThrow(JudgeCallError);
    expect(() => parseJudgement('{"faithfulness": 5, "usefulness": 9}')).toThrow(JudgeCallError);
  });

  it("note는 리포트 스키마 상한(240자) 안으로 잘린다", () => {
    const long = "가".repeat(400);
    const parsed = parseJudgement(
      JSON.stringify({ faithfulness: 4, usefulness: 4, note: long }),
    );
    expect(parsed.note).toHaveLength(240);
  });
});

describe("renderJudgeMessage", () => {
  it("질문·근거·답변이 각각 태그로 갇힌다", () => {
    const rendered = renderJudgeMessage({
      query: "질문",
      answer: "답변",
      sources: [{ citation: "[REC-a#b]", title: "제목", text: "본문" }],
    });

    expect(rendered).toContain("<question>");
    expect(rendered).toContain('<source citation="[REC-a#b]" title="제목">');
    expect(rendered).toContain("<answer>");
  });
});
