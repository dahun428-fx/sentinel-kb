/**
 * `pnpm eval:tools` 진입점 (specs/05 Eval 3, T-016).
 *
 * **컴포지션 루트다** — env를 읽는 유일한 지점이고, 종료 코드를 정하는 유일한 지점이다.
 * T-013(`eval/retrieval/run.cli.ts`)이 따른 규약을 그대로 쓴다: 라이브러리는 `process.exit`을
 * 부르지 않는다.
 *
 * 사용법:
 *   pnpm eval:tools                          # 기본 (20 시나리오 × 3회)
 *   pnpm eval:tools --repeats=5              # 안정성을 더 굵게
 *   pnpm eval:tools --allow-oracle-selector  # 판정 없이 파이프라인만 확인
 *
 * ## ⚠️ 잴 수 있는 selector가 없으면 재지 않는다 (EX_CONFIG 78로 거절)
 * 시나리오 판정은 **도구 목록을 주고 실제 모델이 무엇을 고르는지 보는 것**이라 모델 호출이
 * 필요하다(specs/05: "실제 모델 호출은 eval 계층에서만" — 여기가 그 계층이다).
 * 지금 이 레포에는 tool-calling 가능한 `ChatModel`도, 실 provider도 없다
 * (`packages/core/src/llm/types.ts` D-2, `eval/tools/selector.ts` 참조).
 * 그래서 이 CLI는 **아무것도 재지 않고 78로 끝난다.** `scripts/seed.cli.ts`가 fake 임베딩
 * 적재를 거절하고 `eval/retrieval/run.cli.ts`가 fake provider를 거절하는 것과 같은 게이트다.
 *
 * 종료 코드:
 *   0  판정했고 기준선 통과
 *   1  **기준선 하락** (specs/05 G4 — 머지 금지)
 *   69 EX_UNAVAILABLE — 모델 호출이 실패해 재지 못함
 *   78 EX_CONFIG — 잴 수 없는 조건(selector 부재, 시나리오·계약 불일치, 인자 오설정)
 */
import { EvalArgsError, parseRunArgs } from "./args.js";
import { EVAL_EXIT_CODES, exitCodeFor, formatVerdict, toolsBaselines } from "./baseline-guard.js";
import { readBaselines } from "./baselines.js";
import { loadToolCatalog, ToolCatalogError } from "./catalog.js";
import { REPO_ROOT, writeToolsReport } from "./report-io.js";
import { runToolsEval } from "./run.js";
import { loadScenarios, ScenarioError } from "./scenarios.js";
import { resolveSelector, SelectorCallError, SelectorUnavailableError } from "./selector.js";

const EXIT_UNAVAILABLE = 69;

async function main(): Promise<number> {
  const args = parseRunArgs(process.argv.slice(2));

  // 카탈로그·시나리오를 **selector보다 먼저** 세운다. 계약과 골든셋이 어긋난 상태라면
  // 모델을 부르기 전에 죽는 편이 싸다(60회 호출 뒤에 알아채는 것보다).
  const catalog = loadToolCatalog();
  const scenarios = await loadScenarios(catalog);
  const selector = resolveSelector(process.env, {
    allowOracle: args.allowOracleSelector,
    scenarios,
  });

  const report = await runToolsEval({
    scenarios,
    catalog,
    selector,
    repeats: args.repeats,
    baselines: toolsBaselines(await readBaselines()),
    now: new Date(),
    expectedScenarioCount: args.expectedScenarioCount,
  });

  const path = await writeToolsReport(report, REPO_ROOT);
  console.log(formatVerdict(report));
  console.log(`[eval:tools] 리포트: ${path}`);
  return exitCodeFor(report.regression);
}

try {
  process.exitCode = await main();
} catch (error) {
  if (error instanceof SelectorUnavailableError) {
    console.error(`[eval:tools] SELECTOR_UNAVAILABLE: ${error.message}`);
    process.exitCode = EVAL_EXIT_CODES.NOT_MEASURABLE;
  } else if (error instanceof SelectorCallError) {
    // 모델 호출이 실패한 채로 낸 지표는 "선택률이 떨어졌다"가 아니라 "재지 못했다"이다.
    console.error(`[eval:tools] SELECTOR_CALL_FAILED: ${error.message}`);
    process.exitCode = EXIT_UNAVAILABLE;
  } else if (error instanceof ScenarioError) {
    console.error(`[eval:tools] SCENARIOS_INVALID: ${error.message}`);
    process.exitCode = EVAL_EXIT_CODES.NOT_MEASURABLE;
  } else if (error instanceof ToolCatalogError) {
    console.error(`[eval:tools] CATALOG_UNREADABLE: ${error.message}`);
    process.exitCode = EVAL_EXIT_CODES.NOT_MEASURABLE;
  } else if (error instanceof EvalArgsError) {
    console.error(`[eval:tools] EVAL_CONFIG_INVALID: ${error.message}`);
    process.exitCode = EVAL_EXIT_CODES.NOT_MEASURABLE;
  } else {
    console.error("[eval:tools] EVAL_FAILED:", error instanceof Error ? error.message : error);
    process.exitCode = EVAL_EXIT_CODES.NOT_MEASURABLE;
  }
}
