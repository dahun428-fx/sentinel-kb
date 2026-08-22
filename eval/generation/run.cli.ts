/**
 * `pnpm eval:generation` 진입점 (specs/05 Eval 2, T-020).
 *
 * **컴포지션 루트다** — env를 읽는 유일한 지점이고, 종료 코드를 정하는 유일한 지점이다.
 * T-013·T-016이 따른 규약을 그대로 쓴다: 라이브러리는 `process.exit`을 부르지 않는다.
 *
 * 사용법:
 *   pnpm eval:generation                        # 기본 (케이스 15건)
 *   pnpm eval:generation --base-url=http://...  # 원격 core-api 대상
 *   pnpm eval:generation --allow-fixture-judge  # 판정 없이 파이프라인만 확인
 *
 * ## ⚠️ 잴 수 없으면 재지 않는다 (EX_CONFIG 78로 거절)
 * 이 eval은 셋이 모두 있어야 성립한다.
 *   1. **실 임베딩** — 없으면 grounded 케이스가 전부 게이트에 걸린다(`assertMeasurableEmbeddings`).
 *   2. **떠 있는 core-api + 시드** — 답변 경로 자체가 없으면 잴 것이 없다.
 *   3. **judge 모델**(specs/05 Eval 2-b) — `ANTHROPIC_API_KEY`·`EVAL_JUDGE_MODEL`.
 * 하나라도 없으면 **아무것도 재지 않고 78로 끝난다.** `scripts/seed.cli.ts`가 fake 적재를,
 * `eval/retrieval/run.cli.ts`가 fake provider를, `eval/tools/run.cli.ts`가 selector 부재를
 * 거절하는 것과 같은 게이트다 — 측정 없이 쓴 숫자를 기준선으로 삼지 않기 위해서다.
 *
 * 종료 코드:
 *   0  판정했고 기준선 통과
 *   1  **기준선 하락** (specs/05 G4 — 머지 금지)
 *   69 EX_UNAVAILABLE — core-api·judge 호출이 실패해 재지 못함
 *   78 EX_CONFIG — 잴 수 없는 조건(fake 임베딩, judge 부재, 케이스 손상, 인자 오설정)
 */
import { EmbedderError, parseApiKeys, readEmbedderConfig } from "@sentinel/core";

import {
  assertMeasurableEmbeddings,
  EvalArgsError,
  parseRunArgs,
  resolveEvalApiKey,
} from "./args.js";
import { createAnswerClient, createSourceFetcher, EvalAnswerError } from "./answerer.js";
import { EVAL_EXIT_CODES, exitCodeFor, formatVerdict, generationBaselines } from "./baseline-guard.js";
import { readBaselines } from "./baselines.js";
import { CaseError, loadCases } from "./cases.js";
import { JudgeCallError, JudgeUnavailableError, resolveJudge } from "./judge.js";
import { REPO_ROOT, writeGenerationReport } from "./report-io.js";
import { runGenerationEval } from "./run.js";

const EXIT_UNAVAILABLE = 69;

async function main(): Promise<number> {
  const args = parseRunArgs(process.argv.slice(2), process.env);

  // 케이스와 임베딩 설정을 **모델보다 먼저** 확인한다. 잴 수 없는 상태라면 15회 호출 뒤에
  // 알아채는 것보다 지금 죽는 편이 싸다.
  const cases = loadCases();
  const embedderConfig = readEmbedderConfig(process.env);
  assertMeasurableEmbeddings(embedderConfig.provider);

  const apiKeys = parseApiKeys(process.env["API_KEYS"]);
  const apiKey = resolveEvalApiKey(apiKeys, args.project);
  const clientOptions = { baseUrl: args.baseUrl, apiKey };

  const judge = resolveJudge(process.env, args.allowFixtureJudge);

  const report = await runGenerationEval({
    cases,
    answer: createAnswerClient(clientOptions),
    fetchSources: createSourceFetcher(clientOptions),
    judge,
    /*
     * 답변을 만든 것은 core-api 뒤의 실 모델이다. 모델 식별자는 응답에 실리지 않으므로
     * (NFR-03: 응답은 최소 표면) env의 `ANTHROPIC_MODEL`을 provenance로 적는다 —
     * 그것이 서버가 쓰는 값과 같다는 전제이며, 다르면 리포트가 거짓말을 한다.
     * **`trusted`는 임베딩 게이트를 통과했다는 사실에 걸려 있다**(위에서 fake를 이미 거절했다).
     */
    generator: {
      provider: "core-api",
      model: process.env["ANTHROPIC_MODEL"]?.trim() ?? "unknown",
      trusted: true,
    },
    baselines: generationBaselines(await readBaselines()),
    now: new Date(),
    expectedCaseCount: args.expectedCaseCount,
  });

  const path = await writeGenerationReport(report, REPO_ROOT);
  console.log(formatVerdict(report));
  console.log(`[eval:generation] 리포트: ${path}`);
  return exitCodeFor(report.regression);
}

try {
  process.exitCode = await main();
} catch (error) {
  if (error instanceof JudgeUnavailableError) {
    console.error(`[eval:generation] JUDGE_UNAVAILABLE: ${error.message}`);
    process.exitCode = EVAL_EXIT_CODES.NOT_MEASURABLE;
  } else if (error instanceof JudgeCallError) {
    // judge 호출이 실패한 채로 낸 점수는 "나빠졌다"가 아니라 "재지 못했다"이다.
    console.error(`[eval:generation] JUDGE_CALL_FAILED: ${error.message}`);
    process.exitCode = EXIT_UNAVAILABLE;
  } else if (error instanceof EvalAnswerError) {
    console.error(`[eval:generation] ANSWER_FAILED: ${error.message}`);
    process.exitCode = EXIT_UNAVAILABLE;
  } else if (error instanceof EmbedderError) {
    // 임베딩 설정이 없거나 틀렸다. 품질 회귀가 아니라 오설정이므로 78이다.
    console.error(`[eval:generation] EMBEDDING_CONFIG_INVALID: ${error.message}`);
    process.exitCode = EVAL_EXIT_CODES.NOT_MEASURABLE;
  } else if (error instanceof CaseError) {
    console.error(`[eval:generation] CASES_INVALID: ${error.message}`);
    process.exitCode = EVAL_EXIT_CODES.NOT_MEASURABLE;
  } else if (error instanceof EvalArgsError) {
    console.error(`[eval:generation] EVAL_CONFIG_INVALID: ${error.message}`);
    process.exitCode = EVAL_EXIT_CODES.NOT_MEASURABLE;
  } else {
    console.error("[eval:generation] EVAL_FAILED:", error instanceof Error ? error.message : error);
    process.exitCode = EVAL_EXIT_CODES.NOT_MEASURABLE;
  }
}
