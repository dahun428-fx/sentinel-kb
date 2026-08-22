/**
 * 채점 규칙을 잠근다. **이 파일이 죽으면 eval이 재는 대상이 바뀐 것이다.**
 *
 * 아래 단언들은 각각 "이렇게 느슨해질 수 있다"는 구체적 변경을 겨냥한다:
 *   - 필수 인자 검사 제거 → "도구만 맞으면 정답" 케이스가 통과해 버린다
 *   - `expectedTool:null`을 항상 오답 처리 → 도구 없음 케이스가 구조적으로 0점이 된다
 *   - 빈 문자열을 채운 값으로 인정 → `resolution: ""`인 호출이 만점을 받는다
 */
import { describe, expect, it } from "vitest";

import { aggregate, collectConfusions, presentArgs, scoreAttempt, scoreScenario } from "./score.js";
import type { Scenario } from "./scenarios.js";

function scenario(overrides: Partial<Scenario> = {}): Scenario {
  return {
    id: "TS-99",
    prompt: "프롬프트",
    expectedTool: "record_knowledge",
    requiredArgs: ["type", "title", "symptom", "resolution"],
    expectedArgs: { type: "incident" },
    boundary: "테스트용",
    ...overrides,
  };
}

const FULL_ARGS = {
  type: "incident",
  title: "제목",
  symptom: "증상",
  resolution: "해결",
};

describe("scoreAttempt — 올바른 도구 + 필수 인자", () => {
  it("도구와 필수 인자가 모두 맞으면 정답이다", () => {
    const attempt = scoreAttempt(scenario(), { tool: "record_knowledge", args: FULL_ARGS }, 1);
    expect(attempt.correct).toBe(true);
    expect(attempt.missingArgs).toEqual([]);
  });

  /** **필수 인자 검사가 사라지면 이 테스트가 죽는다.** specs/05는 "도구 + 필수 인자"를 요구한다. */
  it("도구는 맞았지만 필수 인자를 빠뜨리면 오답이고, 무엇이 빠졌는지 남는다", () => {
    const attempt = scoreAttempt(
      scenario(),
      { tool: "record_knowledge", args: { type: "incident", title: "제목" } },
      1,
    );
    expect(attempt.correct, "인자 검사가 꺼져 있다 — 도구만 맞으면 통과하고 있다").toBe(false);
    expect(attempt.missingArgs).toEqual(["symptom", "resolution"]);
  });

  it("빈 문자열·빈 배열·null은 채운 값이 아니다", () => {
    const attempt = scoreAttempt(
      scenario(),
      { tool: "record_knowledge", args: { ...FULL_ARGS, resolution: "   " } },
      1,
    );
    expect(attempt.correct).toBe(false);
    expect(attempt.missingArgs).toEqual(["resolution"]);
  });

  it("false와 0은 채운 값이다 — helped:false가 구조적으로 오답이 되면 안 된다", () => {
    expect(presentArgs({ helped: false, count: 0 })).toEqual(["helped", "count"]);
  });

  it("인자 값이 다르면 오답이다 (record_knowledge(type:divergence))", () => {
    const attempt = scoreAttempt(
      scenario(),
      { tool: "record_knowledge", args: { ...FULL_ARGS, type: "divergence" } },
      1,
    );
    expect(attempt.correct).toBe(false);
    expect(attempt.wrongArgs).toEqual([
      { name: "type", expected: "incident", actual: "divergence" },
    ]);
  });

  it("boolean 인자는 문자열로 비교한다 — helped:true가 \"true\"와 같다", () => {
    const feedback = scenario({
      expectedTool: "give_feedback",
      requiredArgs: ["recordId", "query", "helped"],
      expectedArgs: { helped: "true" },
    });
    const attempt = scoreAttempt(
      feedback,
      { tool: "give_feedback", args: { recordId: "abc", query: "질의", helped: true } },
      1,
    );
    expect(attempt.correct).toBe(true);
  });

  it("도구를 틀리면 인자 판정을 하지 않고, 무엇을 골랐는지만 남는다 (Acceptance 2)", () => {
    const attempt = scoreAttempt(scenario(), { tool: "search_knowledge", args: {} }, 1);
    expect(attempt.correct).toBe(false);
    expect(attempt.chosenTool).toBe("search_knowledge");
    expect(attempt.missingArgs, "틀린 도구의 인자를 세면 오답 사유가 뒤바뀐다").toEqual([]);
  });
});

describe("scoreAttempt — 도구 없음이 정답인 시나리오", () => {
  const none = scenario({ expectedTool: null, requiredArgs: [], expectedArgs: {} });

  /** **이 갈래를 항상 오답으로 접는 변경이 들어오면 여기서 죽는다.** */
  it("아무 도구도 부르지 않으면 정답이다", () => {
    const attempt = scoreAttempt(none, { tool: null, args: {} }, 1);
    expect(attempt.correct, "도구 없음이 정답인 케이스가 구조적으로 0점이 되고 있다").toBe(true);
  });

  it("무언가를 부르면 오답이고, 무엇을 불렀는지 남는다", () => {
    const attempt = scoreAttempt(none, { tool: "search_knowledge", args: { query: "무엇" } }, 1);
    expect(attempt.correct).toBe(false);
    expect(attempt.chosenTool).toBe("search_knowledge");
  });
});

describe("scoreScenario / aggregate — 반복과 안정성", () => {
  const target = scenario();

  it("3회 중 2회만 맞으면 정확도는 2/3이지 1도 0도 아니다", () => {
    const result = scoreScenario(target, [
      { tool: "record_knowledge", args: FULL_ARGS },
      { tool: "record_knowledge", args: FULL_ARGS },
      { tool: "search_knowledge", args: { query: "무엇" } },
    ]);
    expect(result.correctCount).toBe(2);

    const summary = aggregate([result], 3);
    expect(summary.metrics.selectionAccuracy).toBeCloseTo(2 / 3, 4);
    expect(summary.diagnostics.attempts).toBe(3);
  });

  it("회차마다 다른 도구를 고르면 stable이 false다", () => {
    const result = scoreScenario(target, [
      { tool: "record_knowledge", args: FULL_ARGS },
      { tool: "search_knowledge", args: {} },
      { tool: "record_knowledge", args: FULL_ARGS },
    ]);
    expect(result.stable).toBe(false);
    expect(aggregate([result], 3).diagnostics.stability).toBe(0);
  });

  it("일관되게 틀려도 stable이다 — 안정성과 정확도는 다른 축이다", () => {
    const result = scoreScenario(target, [
      { tool: "search_knowledge", args: {} },
      { tool: "search_knowledge", args: {} },
    ]);
    expect(result.stable).toBe(true);
    expect(result.correctCount).toBe(0);
  });

  it("도구만 맞고 인자를 빠뜨리면 toolAccuracy와 selectionAccuracy가 갈린다", () => {
    const result = scoreScenario(target, [{ tool: "record_knowledge", args: { type: "incident" } }]);
    const summary = aggregate([result], 1);
    expect(summary.metrics.selectionAccuracy).toBe(0);
    expect(summary.diagnostics.toolAccuracy).toBe(1);
    expect(summary.diagnostics.argAccuracy).toBe(0);
  });

  it("시도가 0건이면 0.0을 품질로 읽지 말라는 경고가 붙는다", () => {
    expect(aggregate([], 3).warnings.join("\n")).toContain("잰 것이 없");
  });

  it("byExpectedTool에 '도구 없음' 묶음이 별도로 선다", () => {
    const none = scenario({ id: "TS-98", expectedTool: null, requiredArgs: [], expectedArgs: {} });
    const summary = aggregate(
      [
        scoreScenario(target, [{ tool: "record_knowledge", args: FULL_ARGS }]),
        scoreScenario(none, [{ tool: "search_knowledge", args: {} }]),
      ],
      1,
    );
    const bucket = summary.byExpectedTool.find((entry) => entry.expectedTool === null);
    expect(bucket?.scenarioCount).toBe(1);
    expect(bucket?.selectionAccuracy).toBe(0);
  });
});

describe("collectConfusions — 오답이 무엇을 골랐는지 (Acceptance 2)", () => {
  it("같은 오답이 반복되면 한 줄로 접고 count를 올린다", () => {
    const result = scoreScenario(scenario(), [
      { tool: "suggest_resolution", args: {} },
      { tool: "suggest_resolution", args: {} },
      { tool: "record_knowledge", args: FULL_ARGS },
    ]);
    const confusions = collectConfusions([result]);
    expect(confusions).toHaveLength(1);
    expect(confusions[0]).toMatchObject({
      scenarioId: "TS-99",
      expectedTool: "record_knowledge",
      chosenTool: "suggest_resolution",
      count: 2,
    });
  });

  it("도구는 맞고 인자 때문에 틀린 오답도 사유와 함께 남는다", () => {
    const result = scoreScenario(scenario(), [
      { tool: "record_knowledge", args: { type: "incident", title: "제목" } },
    ]);
    const confusions = collectConfusions([result]);
    expect(confusions[0]?.chosenTool).toBe("record_knowledge");
    expect(confusions[0]?.missingArgs).toEqual(["symptom", "resolution"]);
  });

  it("정답만 있으면 비어 있다", () => {
    expect(
      collectConfusions([scoreScenario(scenario(), [{ tool: "record_knowledge", args: FULL_ARGS }])]),
    ).toEqual([]);
  });
});
