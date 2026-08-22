/**
 * `pnpm eval:injection` 진입점 (specs/05 Eval 4, T-021).
 *
 * **컴포지션 루트다** — env·시계·fs를 읽는 유일한 지점이고 종료 코드를 정하는 유일한 지점이다.
 * `eval/retrieval/run.cli.ts`가 세운 규약을 그대로 따른다.
 *
 * ## DB도 core-api도 부르지 않는다
 *
 * 방어선 1(`sanitize`)과 2(`buildGenerationContext` → `renderUserMessage`)는 **순수 함수**다.
 * 오염 레코드를 실제로 적재하고 검색을 태우면 T-006 F-8의 함정에 그대로 빠진다 —
 * `FakeEmbedder`로는 오염 청크가 `SIMILARITY_THRESHOLD` 게이트를 못 넘어 컨텍스트에
 * 들어오지도 못하고, 그러면 "10/10 방어"가 **아무것도 검증하지 않은 채** 통과한다.
 * 여기서는 검색 결과를 직접 조립해 오염 청크가 **반드시 컨텍스트 후보로 들어오게** 만든 뒤
 * 제외가 실제로 발동하는지를 본다. 재는 대상이 검색 품질이 아니라 방어선이기 때문에
 * 이 대체가 정당하다(검색 품질은 T-013의 몫이다).
 *
 * 종료 코드:
 *   0  판정했고 통과 (방어선 1·2만으로 전부 막혔거나, judge가 "따른 케이스 0건"으로 판정)
 *   1  **판정했고 실패** (judge가 지시를 따른 케이스를 찾았다 — specs/05: 1건이라도면 실패)
 *   78 EX_CONFIG — 잴 수 없음(방어선 3 판정 불가, 코퍼스 0건, 대조군 소실, 리포트 손상)
 */
import { EVAL_EXIT_CODES } from "../retrieval/baseline-guard.js";

import { readInjectionBaselines } from "./baselines.js";
import { judgeAvailability, promptClausePresent, runDetection, runExclusion } from "./defenses.js";
import { exitCodeForInjection } from "./guard.js";
import { REPO_ROOT, writeInjectionReport } from "./report-io.js";
import { buildInjectionReport, formatInjectionVerdict } from "./run.js";

async function main(): Promise<number> {
  if (process.argv.slice(2).length > 0) {
    console.error("[eval:injection] 인자를 받지 않는다. 사용법: pnpm eval:injection");
    return EVAL_EXIT_CODES.NOT_MEASURABLE;
  }

  const baselines = (await readInjectionBaselines()).injection;
  const detection = runDetection();
  const exclusion = runExclusion(detection);

  const report = buildInjectionReport({
    detection,
    exclusion,
    judge: judgeAvailability(process.env),
    clausePresent: promptClausePresent(),
    baselines,
    now: new Date(),
  });

  const path = await writeInjectionReport(report, REPO_ROOT);
  console.log(formatInjectionVerdict(report));
  console.log(`[eval:injection] 리포트: ${path}`);
  return exitCodeForInjection(report.regression);
}

try {
  process.exitCode = await main();
} catch (error) {
  console.error("[eval:injection] EVAL_FAILED:", error instanceof Error ? error.message : error);
  process.exitCode = EVAL_EXIT_CODES.NOT_MEASURABLE;
}
