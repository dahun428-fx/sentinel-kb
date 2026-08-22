/**
 * `pnpm eval:generation:check <report.json>` — **회귀 가드 단독 실행**.
 *
 * 이미 만들어진 리포트를 현재 `eval/baselines.json`으로 다시 판정하고 종료 코드를 낸다.
 * 모델도 core-api도 부르지 않는다.
 *
 * ## 왜 별도 진입점이 필요한가 (T-020 Acceptance 3)
 * "judge 점수가 기준선보다 낮으면 exit 1"을 **증명**하려면 낮은 리포트를 실제로 넣고
 * 프로세스가 1로 죽는 것을 봐야 한다. 그런데 `run.cli.ts`로 그러려면 실 모델·실 judge·
 * 떠 있는 core-api가 필요하고, 지금 이 레포에는 API 키가 없다. 판정 로직만 떼어 내면
 * **자격증명 없이도 가드가 진짜인지 양방향으로 확인**할 수 있고, 그 확인이
 * `check-baseline.cli.spec.ts`다. T-016이 같은 이유로 같은 구조를 썼다.
 *
 * 부수 효과로 커밋된 과거 리포트(`eval/reports/*-generation.json`)를 새 기준선으로 다시
 * 읽을 수 있다 — 사람이 faithfulness 기준선을 올렸을 때 어떤 과거 리포트가 그 선 아래인지 나온다.
 *
 * 종료 코드는 `run.cli.ts`와 같다: 0 통과 / 1 하락 / 78 판정 불가·리포트 손상.
 */
import {
  EVAL_EXIT_CODES,
  exitCodeFor,
  formatVerdict,
  generationBaselines,
  recheckReport,
} from "./baseline-guard.js";
import { readBaselines } from "./baselines.js";
import { readGenerationReport } from "./report-io.js";

const USAGE = "사용법: pnpm eval:generation:check <eval/reports/YYYY-MM-DD-generation.json>";

async function main(): Promise<number> {
  const path = process.argv[2];
  if (path === undefined || path === "") {
    console.error(`[eval:generation:check] 리포트 경로가 없다. ${USAGE}`);
    return EVAL_EXIT_CODES.NOT_MEASURABLE;
  }

  const report = await readGenerationReport(path);
  const baselines = generationBaselines(await readBaselines());
  const rechecked = recheckReport(report, baselines);

  console.log(formatVerdict(rechecked));
  return exitCodeFor(rechecked.regression);
}

try {
  process.exitCode = await main();
} catch (error) {
  // 리포트를 못 읽거나 스키마를 어기면 "통과"가 아니라 "판정 불가"다.
  console.error(
    `[eval:generation:check] REPORT_UNREADABLE: ${error instanceof Error ? error.message : String(error)}`,
  );
  process.exitCode = EVAL_EXIT_CODES.NOT_MEASURABLE;
}
