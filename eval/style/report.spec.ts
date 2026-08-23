/**
 * 리포트 스키마. **본문을 담을 자리가 없다는 것**이 이 파일이 지키는 계약이다 —
 * 미승인 초안과 사람 글이 커밋되는 리포트를 타고 새어 나가지 않게 한다(§0-5·§7).
 */
import { describe, expect, it } from "vitest";

import {
  StyleReport,
  styleReportFileName,
  STYLE_REPORT_FILE_PATTERN,
  toReportDate,
} from "./report.js";

function validReport(): unknown {
  return {
    kind: "style",
    date: "2026-08-23",
    generatedAt: "2026-08-23T04:05:06.000Z",
    judge: { provider: "anthropic", model: "claude-x", trusted: true },
    blindSeed: "T-034-style-eval",
    corpus: { generated: 1, human: 3, control: 4, requiredHuman: 3 },
    metrics: {
      discriminationAccuracy: 0.5,
      chanceLevel: 0.5,
      aiDetectionRate: 0.5,
      humanFalseAiRate: 0.5,
      controlAccuracy: 1,
      lintPassRate: 1,
      factCheckViolations: 0,
      publicationRate: null,
      degenerate: false,
    },
    baselines: { discriminationAccuracy: 0.7 },
    regression: { evaluated: true, pass: true, reason: null },
    warnings: [],
    pieces: [
      {
        itemId: "ITEM-01",
        origin: "generated",
        sourceRef: "ART-pattern-01",
        chars: 1200,
        verdict: "ai",
        correct: true,
        confidence: 4,
        reason: "근거 한 줄",
      },
    ],
    pipeline: [
      {
        articleId: "ART-pattern-01",
        accepted: true,
        rejection: null,
        lintPassed: true,
        lintViolationRules: [],
        factCheckViolations: 0,
        attempts: 1,
        styleSamples: 2,
      },
    ],
  };
}

describe("StyleReport", () => {
  it("정상 리포트를 통과시킨다", () => {
    expect(() => StyleReport.parse(validReport())).not.toThrow();
  });

  it("글 본문을 담으려는 시도를 거부한다 (.strict)", () => {
    const withBody = validReport() as Record<string, unknown>;
    const pieces = withBody["pieces"] as Record<string, unknown>[];
    pieces[0] = { ...pieces[0], text: "본문 전문이 여기 들어가면 안 된다" };

    expect(() => StyleReport.parse(withBody)).toThrow();
  });

  it("리포트 최상위에도 본문 필드를 끼워 넣을 수 없다", () => {
    expect(() => StyleReport.parse({ ...(validReport() as object), bodies: ["..."] })).toThrow();
  });

  it("판정 불가와 통과를 나눠 담는다", () => {
    const report = validReport() as Record<string, unknown>;
    report["regression"] = { evaluated: false, pass: false, reason: "못 쟀다" };

    const parsed = StyleReport.parse(report);

    expect(parsed.regression.evaluated).toBe(false);
    expect(parsed.regression.pass).toBe(false);
  });

  it("발행률은 null을 허용한다 — 0과 다르다", () => {
    const parsed = StyleReport.parse(validReport());

    expect(parsed.metrics.publicationRate).toBeNull();
  });

  it("근거는 240자에서 잘린 값만 허용한다", () => {
    const report = validReport() as Record<string, unknown>;
    const pieces = report["pieces"] as Record<string, unknown>[];
    pieces[0] = { ...pieces[0], reason: "가".repeat(241) };

    expect(() => StyleReport.parse(report)).toThrow();
  });
});

describe("파일명", () => {
  it("YYYY-MM-DD-style.json", () => {
    expect(styleReportFileName("2026-08-23")).toBe("2026-08-23-style.json");
    expect(STYLE_REPORT_FILE_PATTERN.test("2026-08-23-style.json")).toBe(true);
  });

  it("날짜 형식이 아니면 거부한다", () => {
    expect(() => styleReportFileName("2026/08/23")).toThrow();
  });

  it("UTC 기준으로 날짜를 만든다 — 타임존으로 하루 밀리지 않게", () => {
    expect(toReportDate(new Date("2026-08-23T23:30:00.000Z"))).toBe("2026-08-23");
  });
});
