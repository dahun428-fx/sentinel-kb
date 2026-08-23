/**
 * 기준선 읽기. **없는 기준선을 기본값으로 채우지 않는다** — 채우면 그 순간
 * "측정된 적 없는 수"가 판정 기준이 되고, CI는 그것을 통과했다고 보고한다.
 */
import { describe, expect, it } from "vitest";

import { parseStyleBaselines, StyleBaselineMissingError } from "./baselines.js";

describe("parseStyleBaselines", () => {
  it("style 절이 있으면 그대로 읽는다", () => {
    const parsed = parseStyleBaselines({
      injection: { defenseRate: 1 },
      style: { discriminationAccuracy: 0.7 },
    });

    expect(parsed.style.discriminationAccuracy).toBe(0.7);
  });

  it("style 절이 없으면 던진다 — 기본값으로 내려앉지 않는다", () => {
    expect(() => parseStyleBaselines({ injection: { defenseRate: 1 } })).toThrow(
      StyleBaselineMissingError,
    );
  });

  it("사람이 무엇을 써야 하는지 에러 문구가 알려준다", () => {
    try {
      parseStyleBaselines({});
      expect.unreachable("던졌어야 한다");
    } catch (error) {
      expect(error).toBeInstanceOf(StyleBaselineMissingError);
      expect((error as Error).message).toContain("discriminationAccuracy");
      expect((error as Error).message).toContain("eval/baselines.json");
    }
  });

  it("범위를 벗어난 값은 거부한다", () => {
    expect(() => parseStyleBaselines({ style: { discriminationAccuracy: 1.4 } })).toThrow(
      StyleBaselineMissingError,
    );
  });

  it("모르는 키가 섞이면 거부한다 (.strict)", () => {
    expect(() =>
      parseStyleBaselines({ style: { discriminationAccuracy: 0.7, target: 0.5 } }),
    ).toThrow(StyleBaselineMissingError);
  });
});
