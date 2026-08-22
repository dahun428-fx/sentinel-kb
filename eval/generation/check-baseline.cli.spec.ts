import { spawnSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { makeReportFixture } from "./report-fixture.js";
import type { GenerationReport } from "./report.js";

/**
 * **T-020 Acceptance 3을 프로세스 수준에서 판정한다.**
 *
 * "judge 점수와 리포트가 baselines.json에 기록되고 하락 시 exit 1"은 순수 함수로 증명되지
 * 않는다 — 판정이 맞아도 CLI가 종료 코드를 안 실으면 CI는 아무것도 막지 못한다.
 * 그래서 여기서는 **실제 프로세스를 띄워** 종료 코드를 본다. T-016과 같은 구조다.
 *
 * ⚠️ 한쪽만 보면 안 된다. 낮은 리포트로 1이 나오는 것만 확인하면 "항상 1을 내는 가드"를
 * 통과시키고, 높은 리포트로 0이 나오는 것만 확인하면 "항상 0을 내는 가드"를 통과시킨다.
 * 아래는 0·1·78 세 방향을 모두 건다.
 *
 * 기준선은 커밋된 `eval/baselines.json`
 * (generation.citationRuleCheck 1.0 / faithfulness 4.0 / usefulness 3.5)을 그대로 쓴다 —
 * 테스트를 위해 기준선을 고치는 것은 CLAUDE.md 즉시 중단 사유다.
 */
const REPO_ROOT = fileURLToPath(new URL("../../", import.meta.url));
const CLI = fileURLToPath(new URL("./check-baseline.cli.ts", import.meta.url));

let workDir: string;

beforeAll(() => {
  workDir = mkdtempSync(join(tmpdir(), "sentinel-generation-guard-"));
});

afterAll(() => {
  rmSync(workDir, { recursive: true, force: true });
});

function writeReport(name: string, report: GenerationReport | Record<string, unknown>): string {
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

describe("generation 회귀 가드 CLI — 기준선 대비 양방향", () => {
  it("기준선 이상이면 exit 0이다 — 항상 1을 내는 가드가 아니다", () => {
    const run = runGuard(writeReport("above.json", makeReportFixture()));
    expect(run.status).toBe(0);
    expect(run.stdout).toContain("기준선 통과");
  });

  it("faithfulness가 기준선보다 낮으면 exit 1이다", () => {
    const path = writeReport("faith.json", makeReportFixture({ metrics: { faithfulness: 3.9 } }));
    const run = runGuard(path);
    expect(run.status).toBe(1);
    expect(run.stdout).toContain("faithfulness");
  });

  it("usefulness가 기준선보다 낮으면 exit 1이다", () => {
    const path = writeReport("useful.json", makeReportFixture({ metrics: { usefulness: 3.4 } }));
    expect(runGuard(path).status).toBe(1);
  });

  /** specs/05: 인용 룰체크는 **100% 요구**다. 15건 중 1건만 어겨도 0.9333이 된다. */
  it("인용 룰체크가 0.9333이면 exit 1이다 (100% 요구)", () => {
    const path = writeReport(
      "citation.json",
      makeReportFixture({ metrics: { citationRuleCheck: 0.9333 } }),
    );
    const run = runGuard(path);
    expect(run.status).toBe(1);
    expect(run.stdout).toContain("citationRuleCheck");
  });

  it("기준선과 동률이면 exit 0이다", () => {
    const path = writeReport(
      "equal.json",
      makeReportFixture({ metrics: { citationRuleCheck: 1, faithfulness: 4, usefulness: 3.5 } }),
    );
    expect(runGuard(path).status).toBe(0);
  });

  it("리포트가 pass:true라고 주장해도 지표가 낮으면 exit 1이다", () => {
    const fixture = makeReportFixture({ metrics: { faithfulness: 1 } });
    expect(fixture.regression.pass).toBe(true);
    expect(runGuard(writeReport("liar.json", fixture)).status).toBe(1);
  });

  /** **자격증명 없이 판정하는 변경이 들어오면 여기서 죽는다.** */
  it("픽스처 judge의 리포트는 만점이어도 통과가 아니라 판정 불가(78)다", () => {
    const path = writeReport(
      "fixture-judge.json",
      makeReportFixture({
        metrics: { citationRuleCheck: 1, faithfulness: 5, usefulness: 5 },
        judgeTrusted: false,
      }),
    );
    const run = runGuard(path);
    expect(run.status, "픽스처 만점이 기준선 통과로 읽히고 있다").toBe(78);
    expect(run.stdout).toContain("판정 불가");
  });

  it("픽스처 생성기의 리포트도 판정 불가(78)다", () => {
    const path = writeReport(
      "fixture-gen.json",
      makeReportFixture({ generatorTrusted: false }),
    );
    expect(runGuard(path).status).toBe(78);
  });

  it("답변 0건 리포트는 판정 불가(78)다", () => {
    const path = writeReport(
      "empty.json",
      makeReportFixture({
        metrics: { citationRuleCheck: 0, faithfulness: 0, usefulness: 0 },
        answeredCount: 0,
      }),
    );
    expect(runGuard(path).status).toBe(78);
  });

  it("스키마를 어긴 리포트는 조용히 통과하지 않는다 (78)", () => {
    const path = writeReport("broken.json", {
      kind: "generation",
      metrics: { citation: 0.9 },
    });
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
