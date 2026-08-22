import { describe, expect, it } from "vitest";

import type { GoldenCase } from "./golden-set.js";
import type { RankedHit } from "./metrics.js";
import type { EmbeddingProvenance, RetrievalMetrics } from "./report.js";
import { runRetrievalEval } from "./run.js";
import type { SearchFn, SearchInput } from "./search-client.js";

const BASE: RetrievalMetrics = { "recall@5": 0.8, mrr: 0.65 };
const NOW = new Date("2026-08-23T12:00:00.000Z");
const TRUSTED: EmbeddingProvenance = { provider: "voyage", version: 1, dim: 1024, trusted: true };
const FAKE: EmbeddingProvenance = { provider: "fake", version: 1, dim: 1024, trusted: false };

const R1 = "111111111111111111111111";
const R2 = "222222222222222222222222";
const R3 = "333333333333333333333333";

function goldenCase(overrides: Partial<GoldenCase> & Pick<GoldenCase, "caseId">): GoldenCase {
  return {
    query: "nginx 502",
    expectedRecordIds: [R1],
    queryKind: "identifier",
    ...overrides,
  };
}

/** 질의별 응답을 표로 심는다. 점수는 전부 어긋나게 둔다(T-011 F-9). */
function stubSearch(table: Record<string, readonly RankedHit[]>): SearchFn {
  return (input: SearchInput) => Promise.resolve([...(table[input.query] ?? [])]);
}

describe("runRetrievalEval", () => {
  it("리포트의 날짜·생성시각이 주입된 시계에서만 나온다", async () => {
    const report = await runRetrievalEval({
      cases: [goldenCase({ caseId: "c1" })],
      search: stubSearch({ "nginx 502": [{ recordId: R1, score: 0.9 }] }),
      limit: 5,
      baselines: BASE,
      embedding: TRUSTED,
      now: NOW,
      expectedCaseCount: 1,
    });
    expect(report.date).toBe("2026-08-23");
    expect(report.generatedAt).toBe("2026-08-23T12:00:00.000Z");
  });

  it("`limit`과 `type` 필터를 검색에 그대로 넘긴다", async () => {
    const seen: SearchInput[] = [];
    const report = await runRetrievalEval({
      cases: [goldenCase({ caseId: "c1", type: "incident" })],
      search: (input) => {
        seen.push(input);
        return Promise.resolve([{ recordId: R1, score: 0.9 }]);
      },
      limit: 20,
      baselines: BASE,
      embedding: TRUSTED,
      now: NOW,
      expectedCaseCount: 1,
    });
    expect(seen).toEqual([{ query: "nginx 502", limit: 20, type: "incident" }]);
    expect(report.config.limit).toBe(20);
  });

  /**
   * **이 테스트가 T-013 Findings의 핵심 요구(한국어/식별자 분리 집계)를 잠근다.**
   * 섞어서 하나의 Recall@5로 뭉치면 0.5가 나오고, 그 0.5만 봐서는 텍스트 경로가
   * 한국어에서 통째로 죽었다는 사실을 알 수 없다(T-010 F-6).
   */
  it("한국어 서술형과 식별자를 나눠 집계한다", async () => {
    const report = await runRetrievalEval({
      cases: [
        goldenCase({ caseId: "id-1", query: "nginx 502", expectedRecordIds: [R1] }),
        goldenCase({ caseId: "id-2", query: "E11000 duplicate", expectedRecordIds: [R1] }),
        goldenCase({
          caseId: "ko-1",
          query: "스트리밍이 끊긴다",
          expectedRecordIds: [R1],
          queryKind: "korean-prose",
        }),
        goldenCase({
          caseId: "ko-2",
          query: "응답이 느려졌다",
          expectedRecordIds: [R1],
          queryKind: "korean-prose",
        }),
      ],
      search: stubSearch({
        "nginx 502": [{ recordId: R1, score: 0.9 }],
        "E11000 duplicate": [{ recordId: R1, score: 0.8 }],
        // 한국어 질의는 엉뚱한 레코드만 끌어온다 — 텍스트 경로가 기여하지 못하는 상태의 모형.
        "스트리밍이 끊긴다": [{ recordId: R2, score: 0.4 }],
        "응답이 느려졌다": [{ recordId: R3, score: 0.3 }],
      }),
      limit: 5,
      baselines: BASE,
      embedding: TRUSTED,
      now: NOW,
      expectedCaseCount: 4,
    });

    expect(report.metrics["recall@5"]).toBe(0.5);
    expect(report.byQueryKind.identifier).toMatchObject({ caseCount: 2, "recall@5": 1, mrr: 1 });
    expect(report.byQueryKind["korean-prose"]).toMatchObject({
      caseCount: 2,
      "recall@5": 0,
      mrr: 0,
    });
    // 케이스가 없는 종류도 자리를 남긴다 — 키가 사라지면 리포트 diff에서 0건과 미측정이 섞인다.
    expect(report.byQueryKind.other.caseCount).toBe(0);
  });

  it("케이스별 순위를 남긴다 — 회귀 분석이 '무엇이 대신 올라왔나'를 볼 수 있어야 한다", async () => {
    const report = await runRetrievalEval({
      cases: [goldenCase({ caseId: "c1", expectedRecordIds: [R3] })],
      search: stubSearch({
        "nginx 502": [
          { recordId: R1, score: 0.9 },
          { recordId: R2, score: 0.8 },
          { recordId: R3, score: 0.7 },
        ],
      }),
      limit: 5,
      baselines: BASE,
      embedding: TRUSTED,
      now: NOW,
      expectedCaseCount: 1,
    });
    expect(report.cases[0]).toMatchObject({
      caseId: "c1",
      queryKind: "identifier",
      rankedRecordIds: [R1, R2, R3],
      firstHitRank: 3,
      hit: true,
    });
    expect(report.cases[0]?.reciprocalRank).toBeCloseTo(0.3333, 4);
  });

  it("동점으로 흔들릴 수 있는 케이스가 있으면 경고를 붙인다 (T-011 F-9)", async () => {
    const report = await runRetrievalEval({
      cases: [goldenCase({ caseId: "c1", expectedRecordIds: [R2] })],
      search: stubSearch({
        "nginx 502": [
          { recordId: R1, score: 0.5 },
          { recordId: R2, score: 0.5 },
        ],
      }),
      limit: 5,
      baselines: BASE,
      embedding: TRUSTED,
      now: NOW,
      expectedCaseCount: 1,
    });
    expect(report.cases[0]?.ambiguousTie).toBe(true);
    expect(report.warnings.join("\n")).toContain("동점");
  });

  it("fake 임베딩이면 지표가 1.0이어도 판정하지 않고 경고를 남긴다", async () => {
    const report = await runRetrievalEval({
      cases: [goldenCase({ caseId: "c1" })],
      search: stubSearch({ "nginx 502": [{ recordId: R1, score: 0.9 }] }),
      limit: 5,
      baselines: BASE,
      embedding: FAKE,
      now: NOW,
      expectedCaseCount: 1,
    });
    expect(report.metrics["recall@5"]).toBe(1);
    expect(report.regression.evaluated).toBe(false);
    expect(report.warnings.join("\n")).toContain("BM25");
  });

  it("골든셋이 비어 있으면 판정하지 않고 그 사실을 경고로 남긴다", async () => {
    const report = await runRetrievalEval({
      cases: [],
      search: stubSearch({}),
      limit: 5,
      baselines: BASE,
      embedding: TRUSTED,
      now: NOW,
    });
    expect(report.config.caseCount).toBe(0);
    expect(report.regression.evaluated).toBe(false);
    expect(report.warnings.join("\n")).toContain("seedBatch");
  });

  it("골든셋이 30건이 아니면 경고한다 (specs/05)", async () => {
    const report = await runRetrievalEval({
      cases: [goldenCase({ caseId: "c1" })],
      search: stubSearch({ "nginx 502": [{ recordId: R1, score: 0.9 }] }),
      limit: 5,
      baselines: BASE,
      embedding: TRUSTED,
      now: NOW,
    });
    expect(report.warnings.join("\n")).toContain("30건");
  });
});
