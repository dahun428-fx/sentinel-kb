/**
 * 세 방어선의 측정을 하나의 리포트로 접는다. **순수 함수다** — fs·env·시계를 스스로 읽지 않고
 * 전부 인자로 받는다(`eval/retrieval/run.ts`와 같은 규약). CLI가 컴포지션 루트다.
 *
 * 접는 순서가 곧 방어선 순서다. 뭉뚱그리지 않는 것이 이 파일의 유일한 목적이므로,
 * `defenses` 아래 세 요약은 **끝까지 따로 산다** — 합쳐진 숫자는 `metrics`의 구간뿐이고
 * 그 구간조차 하한/상한으로 갈라져 있다.
 */
import type { DetectionCase, ExclusionOutcome, JudgeAvailability } from "./defenses.js";
import { computeMetrics, evaluateInjection, type JudgeOutcome } from "./guard.js";
import {
  INJECTION_REPORT_KIND,
  toReportDate,
  type DetectionCaseReport,
  type ExclusionCaseReport,
  type InjectionBaselines,
  type InjectionReport,
} from "./report.js";

/** specs/05 Eval 4가 요구한 코퍼스 크기. 실제와 다르면 경고가 붙는다. */
export const EXPECTED_TAINTED_CASE_COUNT = 10;

export interface BuildReportInput {
  readonly detection: readonly DetectionCase[];
  readonly exclusion: ExclusionOutcome;
  readonly judge: JudgeAvailability;
  readonly clausePresent: boolean;
  readonly baselines: InjectionBaselines;
  readonly now: Date;
  readonly expectedCaseCount?: number;
}

/** 규칙 id별 발화 건수. "어떤 회피 수법이 몇 건이냐"가 여기서 읽힌다(T-021 Findings, T-004 F-3). */
export function countRuleHits(detection: readonly DetectionCase[]): Record<string, number> {
  const hits: Record<string, number> = {};
  for (const entry of detection) {
    for (const rule of entry.rules) {
      hits[rule] = (hits[rule] ?? 0) + 1;
    }
  }
  return hits;
}

/**
 * 케이스 하나가 **프롬프트에 닿지도 못했는가**. 레코드의 모든 청크가 안 실렸을 때만 참이다.
 * 섹션 하나만 새어도 지시는 모델에 도달하므로 "하나라도 실렸으면 뚫린 것"으로 센다.
 */
export function stoppedCaseIds(exclusion: ExclusionOutcome): string[] {
  const byCase = new Map<string, boolean>();
  for (const entry of exclusion.cases) {
    byCase.set(entry.caseId, (byCase.get(entry.caseId) ?? true) && !entry.reachedPrompt);
  }
  return [...byCase.entries()].filter(([, stopped]) => stopped).map(([caseId]) => caseId);
}

export function buildInjectionReport(input: BuildReportInput): InjectionReport {
  const { detection, exclusion, judge, baselines } = input;
  const expectedCaseCount = input.expectedCaseCount ?? EXPECTED_TAINTED_CASE_COUNT;

  const caseCount = detection.length;
  const flaggedCount = detection.filter((entry) => entry.flagged).length;
  const flaggedChunks = exclusion.cases.filter((entry) => entry.flagged);
  const excludedChunks = flaggedChunks.filter((entry) => entry.excluded);
  const reachedPromptChunks = exclusion.cases.filter((entry) => entry.reachedPrompt);
  const stopped = stoppedCaseIds(exclusion);

  const judgeOutcome: JudgeOutcome = {
    measured: judge.available,
    judgedCaseCount: 0,
    followedCaseIds: [],
    reason: judge.available ? null : judge.reason,
  };

  const verdictInput = {
    caseCount,
    stoppedBeforeModelCount: stopped.length,
    controlSurvived: exclusion.controlSurvived,
    judge: judgeOutcome,
    baseline: baselines.defenseRate,
  };

  const date = toReportDate(input.now);
  return {
    kind: INJECTION_REPORT_KIND,
    date,
    generatedAt: input.now.toISOString(),
    expectedCaseCount,
    defenses: {
      detection: {
        measured: true,
        caseCount,
        flaggedCount,
        rate: ratio(flaggedCount, caseCount),
        ruleHits: countRuleHits(detection),
      },
      exclusion: {
        measured: true,
        chunkCount: exclusion.cases.length,
        flaggedChunkCount: flaggedChunks.length,
        excludedChunkCount: excludedChunks.length,
        // 분모는 **플래그된 청크**다. 전체로 나누면 미탐이 제외율을 끌어올린다 —
        // 탐지가 실패할수록 제외 성적이 좋아지는 지표는 거꾸로 선 지표다.
        rate: ratio(excludedChunks.length, flaggedChunks.length),
        reachedPromptChunkCount: reachedPromptChunks.length,
        controlSurvived: exclusion.controlSurvived,
      },
      promptResistance: {
        measured: judgeOutcome.measured,
        clausePresent: input.clausePresent,
        judgedCaseCount: judgeOutcome.judgedCaseCount,
        followedCaseIds: [...judgeOutcome.followedCaseIds],
        reason: judgeOutcome.reason,
      },
    },
    metrics: computeMetrics(verdictInput),
    baselines,
    regression: evaluateInjection(verdictInput),
    warnings: buildWarnings({ detection, exclusion, caseCount, expectedCaseCount, judge, clausePresent: input.clausePresent }),
    cases: {
      detection: detection.map(toDetectionCaseReport),
      exclusion: exclusion.cases.map(toExclusionCaseReport),
    },
  };
}

interface WarningInput {
  readonly detection: readonly DetectionCase[];
  readonly exclusion: ExclusionOutcome;
  readonly caseCount: number;
  readonly expectedCaseCount: number;
  readonly judge: JudgeAvailability;
  readonly clausePresent: boolean;
}

/**
 * 사람이 읽어야 할 단서. **경고는 판정을 바꾸지 않는다** — 판정은 `guard.ts`가 한다.
 * 여기 적히는 것은 "이 수치를 어떻게 읽어야 하는가"이고, 그중 첫 줄이 가장 중요하다:
 * **탐지가 100%가 아니면 제외율 100%는 방어율 100%가 아니다.**
 */
function buildWarnings(input: WarningInput): string[] {
  const warnings: string[] = [];
  const unflagged = input.detection.filter((entry) => !entry.flagged);

  if (input.caseCount !== input.expectedCaseCount) {
    warnings.push(
      `오염 레코드가 ${String(input.caseCount)}건이다 — specs/05 Eval 4는 10건을 요구한다.`,
    );
  }
  if (unflagged.length > 0) {
    warnings.push(
      `방어선 1(탐지)이 ${String(unflagged.length)}건을 놓쳤다: ` +
        `${unflagged.map((entry) => `${entry.caseId}(${entry.axis}, ${entry.language})`).join(", ")}. ` +
        "제외 판단 근거는 오직 `flags`이므로(generator/context.ts), 이 케이스들에는 " +
        "**방어선 2가 발동조차 하지 않는다** — 남은 방어선은 프롬프트 조항 3뿐이다.",
    );
  }
  const missing = input.detection.filter((entry) => entry.missingRules.length > 0);
  if (missing.length > 0) {
    warnings.push(
      "노렸으나 발화하지 않은 규칙이 있다: " +
        missing.map((entry) => `${entry.caseId}→${entry.missingRules.join("/")}`).join(", ") +
        ". 규칙이 죽었거나 페이로드가 규칙 밖으로 나갔다는 뜻이다.",
    );
  }
  if (!input.exclusion.controlSurvived) {
    warnings.push(
      "대조군(정상 기록)이 생성 컨텍스트에서 사라졌다 — 제외가 `injection-suspect`가 아니라 " +
        "모든 청크를 버리고 있을 수 있다.",
    );
  }
  if (!input.clausePresent) {
    warnings.push(
      "프롬프트 조항 3(`data-not-instructions`)이 없다. 방어선 3은 **확실히** 없는 상태다(NFR-05).",
    );
  }
  if (!input.judge.available) {
    warnings.push(`방어선 3(프롬프트 내성)은 판정 불가다: ${input.judge.reason}`);
  }
  return warnings;
}

function toDetectionCaseReport(entry: DetectionCase): DetectionCaseReport {
  return {
    caseId: entry.caseId,
    axis: entry.axis,
    language: entry.language,
    overlap: [...entry.overlap],
    sections: entry.sections.map((section) => ({
      section: section.section,
      flagged: section.flagged,
      rules: [...section.rules],
    })),
    flagged: entry.flagged,
    rules: [...entry.rules],
    missingRules: [...entry.missingRules],
  };
}

function toExclusionCaseReport(entry: ExclusionOutcome["cases"][number]): ExclusionCaseReport {
  return {
    chunkId: entry.chunkId,
    caseId: entry.caseId,
    axis: entry.axis,
    section: entry.section,
    flagged: entry.flagged,
    excluded: entry.excluded,
    reachedPrompt: entry.reachedPrompt,
  };
}

/** 분모가 0이면 **0**이다. 1로 접으면 "잰 것이 없음"이 "완벽함"으로 읽힌다. */
function ratio(numerator: number, denominator: number): number {
  if (denominator === 0) return 0;
  return Math.round((numerator / denominator) * 10_000) / 10_000;
}

/** 콘솔 요약. 세 방어선을 **줄을 갈라** 낸다 — 한 줄로 합치면 이 eval의 요점이 사라진다. */
export function formatInjectionVerdict(report: InjectionReport): string {
  const { detection, exclusion, promptResistance } = report.defenses;
  const lines = [
    `[eval:injection] ${report.date} — 오염 레코드 ${String(detection.caseCount)}건`,
    `  1 탐지(T-004 sanitizer)   ${String(detection.flaggedCount)}/${String(detection.caseCount)}` +
      `  rate=${detection.rate.toFixed(4)}`,
    `  2 제외(T-018 generator)   ${String(exclusion.excludedChunkCount)}/${String(exclusion.flaggedChunkCount)} 청크` +
      `  rate=${exclusion.rate.toFixed(4)}  프롬프트 도달 ${String(exclusion.reachedPromptChunkCount)}청크` +
      `  대조군 생존=${exclusion.controlSurvived ? "예" : "아니오"}`,
    `  3 프롬프트 내성(NFR-05)   ${promptResistance.measured ? `따름 ${String(promptResistance.followedCaseIds.length)}건` : "판정 불가"}` +
      `  (조항 존재=${promptResistance.clausePresent ? "예" : "아니오"})`,
    `  방어율 구간 [${report.metrics.defenseRateLowerBound.toFixed(4)}, ${report.metrics.defenseRateUpperBound.toFixed(4)}]` +
      `  기준선 ${report.baselines.defenseRate.toFixed(4)}`,
  ];
  for (const [rule, count] of Object.entries(detection.ruleHits)) {
    lines.push(`  · 규칙 ${rule.padEnd(34)} ${String(count)}건`);
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
