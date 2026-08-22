/**
 * generation eval 러너. 출처: specs/05 "Eval 2: Generation", T-020 Scope.
 *
 * **순수 조립이다** — env를 읽지 않고 파일을 쓰지 않으며 `process.exit`을 부르지 않는다.
 * 케이스·답변기·judge·기준선을 받아 리포트 하나를 돌려준다(T-013·T-016과 같은 규약).
 * 그래서 단위 테스트가 실제 모델 없이 집계·경고·판정 경로를 전부 때릴 수 있다.
 *
 * ## 인용 룰체크를 여기서 다시 구현하지 않는다
 * `verifyAnswerCitations`는 `packages/core`의 것이고, 프로덕션 파이프라인(`generateAnswer`)이
 * 쓰는 바로 그 함수다. eval이 자기 판정기를 따로 들면 **둘이 갈라지는 순간 eval이 초록인데
 * 프로덕션이 새는** 상태가 만들어진다. 같은 함수를 쓰므로 이 지표는 "프로덕션 검증기가
 * 실제 답변에서 위반을 몇 건 잡는가"를 그대로 잰다.
 */
import { verifyAnswerCitations } from "@sentinel/core";

import type { AnswerFn, FetchSourcesFn } from "./answerer.js";
import { evaluateRegression } from "./baseline-guard.js";
import { caseWarnings, expectsFound, type GenerationCase } from "./cases.js";
import type { Judge } from "./judge.js";
import {
  toReportDate,
  GENERATION_REPORT_KIND,
  type GenerationCaseResult,
  type GenerationDiagnostics,
  type GenerationMetrics,
  type GenerationReport,
  type ModelProvenance,
} from "./report.js";

export interface RunInput {
  readonly cases: readonly GenerationCase[];
  readonly answer: AnswerFn;
  readonly fetchSources: FetchSourcesFn;
  readonly judge: Judge;
  readonly generator: ModelProvenance;
  readonly baselines: GenerationMetrics;
  readonly now: Date;
  readonly expectedCaseCount: number;
}

/** 소수 4자리. 리포트끼리 diff할 때 부동소수 꼬리가 잡음이 되지 않게 한다(T-013 규약). */
export function round4(value: number): number {
  return Math.round(value * 10_000) / 10_000;
}

export async function runGenerationEval(input: RunInput): Promise<GenerationReport> {
  const results: GenerationCaseResult[] = [];

  for (const item of input.cases) {
    const expectFound = expectsFound(item);
    const answered = await input.answer(item.query);

    if (!answered.found) {
      results.push(notFoundResult(item, expectFound));
      continue;
    }

    const verification = verifyAnswerCitations(answered.answer, answered.allowedCitations);
    // judge는 **답이 있을 때만** 부른다. found:false에 점수를 매기면 게이트가 잘 동작할수록
    // 평균이 흔들리고, 그 흔들림은 생성 품질이 아니다.
    const sources = await input.fetchSources(answered.citations);
    const judgement = await input.judge.judge({
      query: item.query,
      answer: answered.answer,
      sources,
    });

    results.push({
      caseId: item.caseId,
      query: item.query,
      kind: item.kind,
      boundary: item.boundary,
      expectFound,
      found: true,
      answerChars: answered.answer.length,
      citationCount: answered.citations.length,
      citationRuleCheck: verification.ok,
      claimSentences: verification.claimCount,
      citedSentences: verification.citedClaimCount,
      missingCitationSentences: verification.violations.filter((v) => v.kind === "missing").length,
      unknownCitationSentences: verification.violations.filter((v) => v.kind === "unknown").length,
      unknownCitations: verification.unknownCitations,
      judgement,
    });
  }

  const diagnostics = aggregateDiagnostics(input.cases, results);
  const metrics = aggregateMetrics(results);
  const warnings = buildWarnings(input, results, diagnostics);

  return {
    kind: GENERATION_REPORT_KIND,
    date: toReportDate(input.now),
    generatedAt: input.now.toISOString(),
    generator: input.generator,
    judge: input.judge.provenance,
    config: { caseCount: input.cases.length, expectedCaseCount: input.expectedCaseCount },
    metrics,
    diagnostics,
    baselines: input.baselines,
    regression: evaluateRegression({
      metrics,
      baselines: input.baselines,
      generatorTrusted: input.generator.trusted,
      judgeTrusted: input.judge.provenance.trusted,
      answeredCount: diagnostics.answeredCount,
    }),
    warnings,
    cases: results,
  };
}

function notFoundResult(item: GenerationCase, expectFound: boolean): GenerationCaseResult {
  return {
    caseId: item.caseId,
    query: item.query,
    kind: item.kind,
    boundary: item.boundary,
    expectFound,
    found: false,
    answerChars: 0,
    citationCount: 0,
    // **`false`가 아니라 `null`이다.** 답이 없으면 인용 룰을 어길 수도 없다.
    citationRuleCheck: null,
    claimSentences: 0,
    citedSentences: 0,
    missingCitationSentences: 0,
    unknownCitationSentences: 0,
    unknownCitations: [],
    judgement: null,
  };
}

function aggregateDiagnostics(
  cases: readonly GenerationCase[],
  results: readonly GenerationCaseResult[],
): GenerationDiagnostics {
  const answered = results.filter((result) => result.found);
  const irrelevant = results.filter((result) => result.kind === "irrelevant");
  return {
    caseCount: cases.length,
    answeredCount: answered.length,
    notFoundCount: results.length - answered.length,
    thresholdScenarioCount: irrelevant.length,
    thresholdScenarioPass: irrelevant.filter((result) => !result.found).length,
    // specs/03 §5의 위반은 "룰체크를 통과하지 못한 답변"으로 관측된다.
    // 재생성·문장 제거는 core 안에서 끝나고 HTTP 표면에 노출되지 않으므로(로그에만 있다),
    // 여기서 세는 것은 **최종 응답에 남은** 위반이다 — 그게 사용자가 받는 것이다.
    groundingViolations: answered.filter((result) => result.citationRuleCheck === false).length,
    claimSentences: sum(answered.map((result) => result.claimSentences)),
    citedSentences: sum(answered.map((result) => result.citedSentences)),
    unknownCitations: sum(answered.map((result) => result.unknownCitations.length)),
  };
}

function aggregateMetrics(results: readonly GenerationCaseResult[]): GenerationMetrics {
  const answered = results.filter((result) => result.found);
  if (answered.length === 0) {
    // 0/0을 1.0으로 접으면 "답을 하나도 못 냈다"가 만점이 된다.
    // 0으로 두고 `evaluateRegression`이 `evaluated:false`로 막는다.
    return { citationRuleCheck: 0, faithfulness: 0, usefulness: 0 };
  }
  const judged = answered.filter((result) => result.judgement !== null);
  return {
    citationRuleCheck: round4(
      answered.filter((result) => result.citationRuleCheck === true).length / answered.length,
    ),
    faithfulness: mean(judged.map((result) => result.judgement?.faithfulness ?? 0)),
    usefulness: mean(judged.map((result) => result.judgement?.usefulness ?? 0)),
  };
}

function buildWarnings(
  input: RunInput,
  results: readonly GenerationCaseResult[],
  diagnostics: GenerationDiagnostics,
): string[] {
  const warnings = [...caseWarnings(input.cases, input.expectedCaseCount)];

  const missedThreshold = results.filter(
    (result) => result.kind === "irrelevant" && result.found,
  );
  if (missedThreshold.length > 0) {
    warnings.push(
      `specs/05 Eval 2(c) 위반: 무관한 쿼리 ${String(missedThreshold.length)}건이 답을 만들었다 ` +
        `(${missedThreshold.map((result) => result.caseId).join(", ")}). ` +
        "임계값 게이트가 뚫린 것이므로 지표보다 이쪽을 먼저 본다(NFR-02).",
    );
  }

  const silentGrounded = results.filter((result) => result.kind === "grounded" && !result.found);
  if (silentGrounded.length > 0) {
    warnings.push(
      `근거가 있어야 할 케이스 ${String(silentGrounded.length)}건이 found:false다 ` +
        `(${silentGrounded.map((result) => result.caseId).join(", ")}). ` +
        "검색이 못 찾은 것인지 게이트가 과하게 조인 것인지는 retrieval eval과 대조해야 한다.",
    );
  }

  if (diagnostics.unknownCitations > 0) {
    warnings.push(
      `모델이 컨텍스트에 없는 인용 ID를 ${String(diagnostics.unknownCitations)}건 만들어 냈다. ` +
        "형식만 검사하는 구현이었다면 전부 통과했을 것들이다(specs/03 §5).",
    );
  }

  return warnings;
}

function sum(values: readonly number[]): number {
  return values.reduce((total, value) => total + value, 0);
}

function mean(values: readonly number[]): number {
  if (values.length === 0) return 0;
  return round4(sum(values) / values.length);
}
