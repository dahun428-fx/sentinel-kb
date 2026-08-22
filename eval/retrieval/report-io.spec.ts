import { mkdtempSync, readFileSync, readdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, join } from "node:path";

import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { makeReportFixture } from "./report-fixture.js";
import { readRetrievalReport, retrievalReportPath, writeRetrievalReport } from "./report-io.js";
import { RETRIEVAL_REPORT_FILE_PATTERN } from "./report.js";

let root: string;

beforeAll(() => {
  root = mkdtempSync(join(tmpdir(), "sentinel-eval-report-"));
});

afterAll(() => {
  rmSync(root, { recursive: true, force: true });
});

describe("리포트 입출력", () => {
  it("specs/05의 경로·파일명으로 쓴다", async () => {
    const path = await writeRetrievalReport(makeReportFixture({ date: "2026-08-23" }), root);
    expect(path).toBe(join(root, "eval/reports/2026-08-23-retrieval.json"));
    expect(RETRIEVAL_REPORT_FILE_PATTERN.test(basename(path))).toBe(true);
    expect(readdirSync(join(root, "eval/reports"))).toContain("2026-08-23-retrieval.json");
  });

  /** 파일명 날짜와 본문 날짜가 어긋나면 시계열을 날짜로 읽는 순간 거짓말이 된다. */
  it("파일명 날짜는 리포트 본문의 `date`에서만 나온다", async () => {
    const path = await writeRetrievalReport(makeReportFixture({ date: "2026-09-01" }), root);
    expect(basename(path)).toBe("2026-09-01-retrieval.json");
    expect(retrievalReportPath("2026-09-01", root)).toBe(path);
  });

  it("사람이 diff로 읽을 수 있게 들여쓰고 개행으로 끝낸다", async () => {
    const path = await writeRetrievalReport(makeReportFixture({ date: "2026-09-02" }), root);
    const raw = readFileSync(path, "utf8");
    expect(raw.endsWith("\n")).toBe(true);
    expect(raw).toContain('\n  "kind": "retrieval"');
  });

  it("쓴 리포트를 그대로 다시 읽는다", async () => {
    const report = makeReportFixture({ date: "2026-09-03", metrics: { "recall@5": 0.83, mrr: 0.71 } });
    const path = await writeRetrievalReport(report, root);
    await expect(readRetrievalReport(path)).resolves.toEqual(report);
  });

  it("스키마를 어긴 파일은 조용히 통과하지 않는다", async () => {
    const path = join(root, "eval/reports/2026-09-04-retrieval.json");
    await writeRetrievalReport(makeReportFixture({ date: "2026-09-04" }), root);
    const { writeFileSync } = await import("node:fs");
    writeFileSync(path, JSON.stringify({ kind: "retrieval" }), "utf8");
    await expect(readRetrievalReport(path)).rejects.toThrow();
  });
});
