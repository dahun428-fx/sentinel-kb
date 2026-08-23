/**
 * 판정 결과를 리포트 하나로 접는다. **순수 함수다** — fs·env·시계·모델을 스스로 읽지 않고
 * 전부 인자로 받는다(`eval/injection/run.ts`와 같은 규약). CLI가 컴포지션 루트다.
 *
 * `judgeAll`만 async인데, 그것은 judge 호출이 I/O이기 때문이지 이 모듈이 I/O를 아는 것은
 * 아니다 — judge는 주입된다. 한 편씩 순차로 부르는 이유는 `blind.ts` 서두에 있다.
 */
import { toJudgeInput, type BlindItem } from "./blind.js";
import { REQUIRED_HUMAN_PIECES, type HumanCorpus } from "./corpus.js";
import type { StyleJudge } from "./judge.js";
import { computeStyleMetrics, isCorrect, type JudgedPiece, type PipelineOutcome } from "./metrics.js";
import { evaluateStyle, type StyleRegressionVerdict } from "./guard.js";
import {
  STYLE_REPORT_KIND,
  toReportDate,
  type StyleBaselines,
  type StylePieceReport,
  type StyleReport,
} from "./report.js";

/**
 * 블라인드 판정. **한 편에 한 호출이다** — 묶어서 보내면 judge가 서로 비교해서 답하고,
 * 그때 재는 것은 "이 글이 AI 같은가"가 아니라 "이 묶음에서 어느 쪽이 더 AI 같은가"다.
 */
export async function judgeAll(
  items: readonly BlindItem[],
  judge: StyleJudge,
): Promise<JudgedPiece[]> {
  const judged: JudgedPiece[] = [];
  for (const item of items) {
    const result = await judge.judge(toJudgeInput(item));
    judged.push({
      itemId: item.itemId,
      // 판정이 끝난 **뒤에** 다시 붙인다. judge는 이 값을 본 적이 없다.
      origin: item.origin,
      sourceRef: item.sourceRef,
      verdict: result.verdict,
      confidence: result.confidence,
      reason: result.reason,
      chars: item.text.length,
    });
  }
  return judged;
}

export interface BuildStyleReportInput {
  readonly judged: readonly JudgedPiece[];
  readonly pipeline: readonly PipelineOutcome[];
  readonly judge: StyleJudge;
  readonly baselines: StyleBaselines;
  readonly blindSeed: string;
  readonly now: Date;
  /** §6의 발행률. 잴 수 없으면 `null`이다 — 0이 아니다. */
  readonly publicationRate: number | null;
  /** 사람 글 로더가 놓친 것. 경고로 실린다. */
  readonly humanMissing?: HumanCorpus["missing"];
  /**
   * 초안의 문체 few-shot으로도 쓰인 사람 글의 `sourceRef`. 비어 있지 않으면 판별 정확도가
   * 문체 이식의 성과인지 표본 재사용의 산물인지 갈 수 없다(`corpus.ts` `detectStyleSampleOverlap`).
   */
  readonly styleSampleOverlap?: readonly string[];
}

export function buildStyleReport(input: BuildStyleReportInput): StyleReport {
  const { judged, pipeline, judge, baselines } = input;

  const counts = {
    generated: judged.filter((piece) => piece.origin === "generated").length,
    human: judged.filter((piece) => piece.origin === "human").length,
    control: judged.filter((piece) => piece.origin === "control").length,
    requiredHuman: REQUIRED_HUMAN_PIECES,
  };

  const metrics = computeStyleMetrics({
    judged,
    pipeline,
    publicationRate: input.publicationRate,
  });

  const regression: StyleRegressionVerdict = evaluateStyle({
    metrics,
    generatedCount: counts.generated,
    humanCount: counts.human,
    controlCount: counts.control,
    judgeTrusted: judge.trusted,
    baseline: baselines.discriminationAccuracy,
  });

  return {
    kind: STYLE_REPORT_KIND,
    date: toReportDate(input.now),
    generatedAt: input.now.toISOString(),
    judge: { provider: judge.provider, model: judge.model, trusted: judge.trusted },
    blindSeed: input.blindSeed,
    corpus: counts,
    metrics,
    baselines,
    regression,
    warnings: buildWarnings({ ...input, counts, metrics }),
    // **판정 순서 그대로 싣는다.** 출처별로 정렬하면 리포트를 읽는 사람이 배치를 재구성할 수
    // 있고, 그러면 다음 실행의 시드 배치를 사람이 미리 아는 상태가 된다.
    pieces: judged.map(toPieceReport),
    pipeline: pipeline.map((entry) => ({
      articleId: entry.articleId,
      accepted: entry.accepted,
      rejection: entry.rejection,
      lintPassed: entry.lintPassed,
      lintViolationRules: [...entry.lintViolationRules],
      factCheckViolations: entry.factCheckViolations,
      attempts: entry.attempts,
      styleSamples: entry.styleSamples,
    })),
  };
}

interface WarningInput extends BuildStyleReportInput {
  readonly counts: { readonly generated: number; readonly human: number; readonly control: number };
  readonly metrics: ReturnType<typeof computeStyleMetrics>;
}

/**
 * 사람이 읽어야 할 단서. **경고는 판정을 바꾸지 않는다** — 판정은 `guard.ts`가 한다.
 * 여기 적히는 것은 "이 수치를 어떻게 읽어야 하는가"이다.
 */
function buildWarnings(input: WarningInput): string[] {
  const warnings: string[] = [];

  if (input.counts.human < REQUIRED_HUMAN_PIECES) {
    warnings.push(
      `사람 글이 ${String(input.counts.human)}편이다 — specs/08 §6은 3편을 요구한다. ` +
        "eval/style/README.md의 '사람 글을 채우는 법'을 보라. **지어내지 않는다.**",
    );
  }
  for (const missing of input.humanMissing ?? []) {
    warnings.push(`사람 글 목록의 ${missing.path}을(를) 읽지 못했다: ${missing.reason}`);
  }
  const overlap = input.styleSampleOverlap ?? [];
  if (overlap.length > 0) {
    warnings.push(
      `사람 글 ${overlap.join(", ")}이(가) 초안의 문체 few-shot으로도 쓰였다(§0-4). ` +
        "아티클이 바로 그 글을 흉내 내 쓰였으므로, 낮은 판별 정확도가 문체 이식의 성과인지 " +
        "표본 재사용의 산물인지 이 실행으로는 가를 수 없다.",
    );
  }
  if (input.metrics.publicationRate === null) {
    warnings.push(
      "발행률(§6)은 재지 못했다. 아티클을 저장·발행하는 경로가 아직 없어서(T-031 F-5) " +
        "후보 대비 발행 비율의 모수가 존재하지 않는다. **0이 아니라 null이다.**",
    );
  }
  const noSamples = input.pipeline.filter((entry) => entry.styleSamples === 0);
  if (noSamples.length > 0) {
    warnings.push(
      `스타일 표본 0편으로 생성된 아티클이 ${String(noSamples.length)}건이다 — §0-4의 문체 주입이 ` +
        "작동하지 않은 실행이다. 이 실행의 판별 정확도는 '문체가 나쁜가'가 아니라 " +
        "'표본이 없었나'를 재고 있을 수 있다(T-031 F-8).",
    );
  }
  const rejected = input.pipeline.filter((entry) => !entry.accepted);
  if (rejected.length > 0) {
    warnings.push(
      `반려된 초안이 ${String(rejected.length)}건이다: ` +
        rejected.map((entry) => `${entry.articleId}=${entry.rejection ?? "?"}`).join(", ") +
        ". 반려분은 블라인드 코퍼스에 들어가지 않으므로 판별 정확도의 분모가 그만큼 작다.",
    );
  }
  if (input.metrics.lintPassRate < 1 && input.pipeline.some((entry) => entry.lintPassed !== null)) {
    warnings.push(
      `린트 통과율이 ${input.metrics.lintPassRate.toFixed(4)}다 — §6은 100%를 요구한다.`,
    );
  }
  if (input.metrics.factCheckViolations > 0) {
    warnings.push(
      `팩트 대조 위반이 ${String(input.metrics.factCheckViolations)}건이다 — §6은 0건을 요구한다.`,
    );
  }
  if (input.metrics.discriminationAccuracy < input.metrics.chanceLevel) {
    warnings.push(
      "판별 정확도가 우연 수준보다 **낮다**. 이것은 '더 좋다'가 아니라 judge가 체계적으로 " +
        "거꾸로 답하고 있다는 신호일 수 있다 — 계기를 먼저 의심하라.",
    );
  }
  if (!input.judge.trusted) {
    warnings.push("judge가 fixture다. 이 리포트의 수치는 측정이 아니다.");
  }
  return warnings;
}

function toPieceReport(piece: JudgedPiece): StylePieceReport {
  return {
    itemId: piece.itemId,
    origin: piece.origin,
    sourceRef: piece.sourceRef,
    chars: piece.chars,
    verdict: piece.verdict,
    correct: isCorrect(piece),
    confidence: piece.confidence,
    reason: piece.reason.slice(0, 240),
  };
}

/** 콘솔 요약. 지표를 한 줄로 뭉치지 않는다 — 대조군 정확도가 가려지면 요점이 사라진다. */
export function formatStyleVerdict(report: StyleReport): string {
  const { metrics, corpus } = report;
  const lines = [
    `[eval:style] ${report.date} — 생성 ${String(corpus.generated)}편 / 사람 ${String(corpus.human)}편(요구 ${String(corpus.requiredHuman)}편) / 대조군 ${String(corpus.control)}편`,
    `  judge  ${report.judge.provider}:${report.judge.model} trusted=${report.judge.trusted ? "예" : "아니오"}  seed=${report.blindSeed}`,
    `  판별 정확도   ${metrics.discriminationAccuracy.toFixed(4)}  (상한 ${report.baselines.discriminationAccuracy.toFixed(4)}, 우연 수준 ${metrics.chanceLevel.toFixed(4)}) — 낮을수록 좋다`,
    `  대조군 정확도 ${metrics.controlAccuracy.toFixed(4)}  — 계기 교정값. 낮으면 위 숫자는 성적이 아니라 고장이다`,
    `  아티클→ai ${metrics.aiDetectionRate.toFixed(4)}   사람 글→ai ${metrics.humanFalseAiRate.toFixed(4)}   한쪽으로만 답함=${metrics.degenerate ? "예" : "아니오"}`,
    `  린트 통과율 ${metrics.lintPassRate.toFixed(4)}  팩트 대조 위반 ${String(metrics.factCheckViolations)}건  발행률 ${metrics.publicationRate === null ? "판정 불가" : metrics.publicationRate.toFixed(4)}`,
  ];
  for (const piece of report.pieces) {
    lines.push(
      `  · ${piece.itemId} ${piece.origin.padEnd(9)} → ${piece.verdict.padEnd(5)} ${piece.correct ? "적중" : "빗나감"}  ${piece.reason}`,
    );
  }
  for (const warning of report.warnings) lines.push(`  ⚠️ ${warning}`);
  if (!report.regression.evaluated) {
    lines.push(`  판정 불가: ${report.regression.reason ?? ""}`);
  } else if (report.regression.pass) {
    lines.push("  기준선 통과.");
  } else {
    lines.push(`  ✗ 실패: ${report.regression.reason ?? ""}`);
  }
  return lines.join("\n");
}
