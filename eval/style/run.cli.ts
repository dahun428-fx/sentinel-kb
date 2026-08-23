/**
 * `pnpm eval:style` 진입점 (specs/08-publishing.md §6, T-034).
 *
 * **컴포지션 루트다** — env·시계·fs를 읽는 유일한 지점이고 종료 코드를 정하는 유일한 지점이다.
 * `eval/retrieval/run.cli.ts`가 세우고 generation·tools·injection이 따른 규약을 그대로 쓴다:
 * 라이브러리는 `process.exit`을 부르지 않는다.
 *
 * ## ⚠️ 잴 수 없으면 재지 않는다 (EX_CONFIG 78로 거절)
 *
 * 이 eval은 넷이 모두 있어야 성립한다.
 *   1. **`style` 기준선** — 없다. 이 태스크가 쓰지 않았다(`baselines.ts` 서두의 충돌 기록).
 *   2. **초안 모델** — 아티클을 실제로 써야 판정할 대상이 생긴다.
 *   3. **judge 모델** — §6의 블라인드 판정. 고정 응답으로 대신하지 않는다.
 *   4. **사람 글 3편** — §6 문면. 부족분을 지어내면 지표가 자기 확인이 된다.
 * 하나라도 없으면 **아무것도 재지 않고 78로 끝난다.** 판별 정확도는 낮을수록 좋은 지표라,
 * 고장 난 실행일수록 좋은 점수가 나온다 — 그래서 이 거절이 다른 러너보다 더 중요하다.
 *
 * 종료 코드:
 *   0  판정했고 기준선 통과
 *   1  **기준선 하락** — 판별 정확도가 상한을 넘었다 (specs/05 G4: 머지 금지)
 *   69 EX_UNAVAILABLE — 모델 호출이 실패해 재지 못함
 *   78 EX_CONFIG — 잴 수 없는 조건(기준선·자격증명·코퍼스 부재, 인자 오설정)
 */
import { createChatModel, loadStyleSamples } from "@sentinel/core";

import { EVAL_EXIT_CODES } from "../retrieval/baseline-guard.js";

import { readStyleBaselines, StyleBaselineMissingError } from "./baselines.js";
import { BLIND_SEED, blindCorpus } from "./blind.js";
import {
  clip,
  controlPieces,
  detectStyleSampleOverlap,
  loadArticleSources,
  loadHumanCorpus,
  type StylePiece,
} from "./corpus.js";
import { exitCodeForStyle } from "./guard.js";
import { resolveStyleJudge, StyleJudgeCallError, StyleJudgeUnavailableError } from "./judge.js";
import { generateArticles } from "./pipeline.js";
import { REPO_ROOT, writeStyleReport } from "./report-io.js";
import { buildStyleReport, formatStyleVerdict, judgeAll } from "./run.js";

const EXIT_UNAVAILABLE = 69;

/** 초안 모델을 세울 수 없다. 품질 회귀가 아니라 오설정이므로 78이다. */
class DraftModelUnavailableError extends Error {
  constructor(message: string, cause?: unknown) {
    super(message, cause === undefined ? undefined : { cause });
    this.name = "DraftModelUnavailableError";
  }
}

async function main(): Promise<number> {
  if (process.argv.slice(2).length > 0) {
    console.error("[eval:style] 인자를 받지 않는다. 사용법: pnpm eval:style");
    return EVAL_EXIT_CODES.NOT_MEASURABLE;
  }

  // 기준선을 **모델보다 먼저** 읽는다. 판정 기준이 없는 상태라면 아티클을 쓰고 나서
  // 알아채는 것보다 지금 죽는 편이 싸다(그 사이에 모델 호출이 여러 번 일어난다).
  const baselines = (await readStyleBaselines()).style;

  const judge = resolveStyleJudge(process.env);
  const draftModel = (() => {
    try {
      return createChatModel({ env: process.env });
    } catch (error) {
      throw new DraftModelUnavailableError(
        "초안 모델을 세울 수 없다 — 판정할 아티클을 만들 수 없다(specs/08 §4). " +
          `사유: ${error instanceof Error ? error.message : String(error)}\n` +
          "손으로 쓴 아티클로 대신하지 않는다. 그러면 이 eval은 파이프라인이 아니라 " +
          "사람이 쓴 사본을 재게 된다.",
        error,
      );
    }
  })();

  const human = await loadHumanCorpus(REPO_ROOT);
  const records = await loadArticleSources(REPO_ROOT);
  const generated = await generateArticles({ records, model: draftModel });

  const pieces: StylePiece[] = [
    ...generated.pieces.map((piece) => ({ ...piece, text: clip(piece.text) })),
    ...human.pieces,
    ...controlPieces(),
  ];

  const judged = await judgeAll(blindCorpus(pieces, BLIND_SEED), judge);

  const report = buildStyleReport({
    judged,
    pipeline: generated.outcomes,
    judge,
    baselines,
    blindSeed: BLIND_SEED,
    now: new Date(),
    // §6의 발행률. 아티클 저장·발행 경로가 없어(T-031 F-5) 모수가 존재하지 않는다.
    publicationRate: null,
    humanMissing: human.missing,
    // 초안에 실린 문체 표본과 판정 대상 사람 글이 같은 글인지 본다(§0-4 × §6).
    styleSampleOverlap: detectStyleSampleOverlap(
      human.pieces,
      loadStyleSamples().samples.map((sample) => sample.text),
    ),
  });

  const path = await writeStyleReport(report, REPO_ROOT);
  console.log(formatStyleVerdict(report));
  console.log(`[eval:style] 리포트: ${path}`);
  return exitCodeForStyle(report.regression);
}

try {
  process.exitCode = await main();
} catch (error) {
  if (error instanceof StyleBaselineMissingError) {
    console.error(`[eval:style] BASELINE_MISSING: ${error.message}`);
    process.exitCode = EVAL_EXIT_CODES.NOT_MEASURABLE;
  } else if (error instanceof StyleJudgeUnavailableError) {
    console.error(`[eval:style] JUDGE_UNAVAILABLE: ${error.message}`);
    process.exitCode = EVAL_EXIT_CODES.NOT_MEASURABLE;
  } else if (error instanceof DraftModelUnavailableError) {
    console.error(`[eval:style] DRAFT_MODEL_UNAVAILABLE: ${error.message}`);
    process.exitCode = EVAL_EXIT_CODES.NOT_MEASURABLE;
  } else if (error instanceof StyleJudgeCallError) {
    // 판정을 못 한 채로 낸 정확도는 "좋아졌다"가 아니라 "재지 못했다"이다.
    console.error(`[eval:style] JUDGE_CALL_FAILED: ${error.message}`);
    process.exitCode = EXIT_UNAVAILABLE;
  } else {
    console.error("[eval:style] EVAL_FAILED:", error instanceof Error ? error.message : error);
    process.exitCode = EVAL_EXIT_CODES.NOT_MEASURABLE;
  }
}
