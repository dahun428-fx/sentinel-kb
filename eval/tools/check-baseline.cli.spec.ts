import { spawnSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { makeReportFixture } from "./report-fixture.js";
import type { ToolsReport } from "./report.js";

/**
 * **T-016 Acceptance 3을 프로세스 수준에서 판정한다.**
 *
 * "기준선 하락 시 exit 1"은 순수 함수로 증명되지 않는다 — 판정이 맞아도 CLI가 종료 코드를
 * 안 실으면 CI는 아무것도 막지 못한다. 그래서 여기서는 **실제 프로세스를 띄워** 종료 코드를 본다.
 *
 * ⚠️ 한쪽만 보면 안 된다. 낮은 리포트로 1이 나오는 것만 확인하면 "항상 1을 내는 가드"를
 * 통과시키고, 높은 리포트로 0이 나오는 것만 확인하면 "항상 0을 내는 가드"를 통과시킨다.
 * 아래는 0·1·78 세 방향을 모두 건다.
 *
 * 기준선은 커밋된 `eval/baselines.json`(tools.selectionAccuracy 0.85)을 그대로 쓴다 —
 * 테스트를 위해 기준선을 고치는 것은 CLAUDE.md 즉시 중단 사유다.
 */
const REPO_ROOT = fileURLToPath(new URL("../../", import.meta.url));
const CLI = fileURLToPath(new URL("./check-baseline.cli.ts", import.meta.url));

let workDir: string;

beforeAll(() => {
  workDir = mkdtempSync(join(tmpdir(), "sentinel-tools-guard-"));
});

afterAll(() => {
  rmSync(workDir, { recursive: true, force: true });
});

function writeReport(name: string, report: ToolsReport | Record<string, unknown>): string {
  const path = join(workDir, name);
  writeFileSync(path, `${JSON.stringify(report, null, 2)}\n`, "utf8");
  return path;
}

interface CliRun {
  readonly status: number;
  readonly stdout: string;
  readonly stderr: string;
}

function runGuard(reportPath: string | undefined): CliRun {
  const result = spawnSync(
    process.execPath,
    ["--import", "tsx", CLI, ...(reportPath === undefined ? [] : [reportPath])],
    { cwd: REPO_ROOT, encoding: "utf8" },
  );
  if (result.error !== undefined) throw result.error;
  return { status: result.status ?? -1, stdout: result.stdout, stderr: result.stderr };
}

describe("tool-selection 회귀 가드 CLI — 기준선 대비 양방향", () => {
  it("기준선보다 낮은 리포트는 exit 1이다", () => {
    const path = writeReport("below.json", makeReportFixture({ metrics: { selectionAccuracy: 0.7 } }));
    const run = runGuard(path);
    expect(run.status).toBe(1);
    expect(run.stdout).toContain("selectionAccuracy");
    expect(run.stdout).toContain("기준선");
  });

  it("기준선 이상이면 exit 0이다 — 항상 1을 내는 가드가 아니다", () => {
    const path = writeReport("above.json", makeReportFixture({ metrics: { selectionAccuracy: 0.95 } }));
    const run = runGuard(path);
    expect(run.status).toBe(0);
    expect(run.stdout).toContain("기준선 통과");
  });

  it("기준선과 동률(0.85)이면 exit 0이다", () => {
    const path = writeReport("equal.json", makeReportFixture({ metrics: { selectionAccuracy: 0.85 } }));
    expect(runGuard(path).status).toBe(0);
  });

  it("소수 4자리 한 칸 아래(0.8499)도 exit 1이다 — EPSILON이 회귀를 삼키지 않는다", () => {
    const path = writeReport("hair.json", makeReportFixture({ metrics: { selectionAccuracy: 0.8499 } }));
    expect(runGuard(path).status).toBe(1);
  });

  it("리포트가 pass:true라고 주장해도 지표가 낮으면 exit 1이다", () => {
    const fixture = makeReportFixture({ metrics: { selectionAccuracy: 0.1 } });
    expect(fixture.regression.pass).toBe(true);
    expect(runGuard(writeReport("liar.json", fixture)).status).toBe(1);
  });

  /** **자격증명 없이 판정하는 변경이 들어오면 여기서 죽는다.** */
  it("실제 모델이 아닌 selector의 리포트는 1.0이어도 통과가 아니라 판정 불가(78)다", () => {
    const path = writeReport(
      "untrusted.json",
      makeReportFixture({ metrics: { selectionAccuracy: 1 }, trusted: false }),
    );
    const run = runGuard(path);
    expect(run.status, "오라클 만점이 기준선 통과로 읽히고 있다").toBe(78);
    expect(run.stdout).toContain("판정 불가");
  });

  it("시나리오 0건 리포트는 판정 불가(78)다", () => {
    const path = writeReport(
      "empty.json",
      makeReportFixture({ metrics: { selectionAccuracy: 0 }, scenarioCount: 0 }),
    );
    expect(runGuard(path).status).toBe(78);
  });

  it("스키마를 어긴 리포트는 조용히 통과하지 않는다 (78)", () => {
    const path = writeReport("broken.json", { kind: "tools", metrics: { accuracy: 0.9 } });
    const run = runGuard(path);
    expect(run.status).toBe(78);
    expect(run.stderr).toContain("REPORT_UNREADABLE");
  });

  it("인자가 없으면 78이다 — 아무것도 안 재고 0으로 끝나지 않는다", () => {
    expect(runGuard(undefined).status).toBe(78);
  });

  it("없는 파일도 78이다", () => {
    expect(runGuard(join(workDir, "nope.json")).status).toBe(78);
  });
});
