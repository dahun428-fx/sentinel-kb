/**
 * generation eval 리포트의 스키마와 파일명 규약. 출처: specs/05 "Eval 2: Generation", T-020.
 *
 * T-013(`eval/retrieval/report.ts`)·T-016(`eval/tools/report.ts`)이 세운 규약을 그대로 따른다.
 * **되풀이하지 않고 여기서만 다른 점**을 적는다.
 *
 * ## 1. 지표 키는 `baselines.json`의 `generation`과 **글자 그대로** 같아야 한다
 * 커밋된 `eval/baselines.json`의 `generation`은
 * `{citationRuleCheck: 1.0, faithfulness: 4.0, usefulness: 3.5}`다. 리포트가 다른 이름을 쓰면
 * 회귀 가드는 키를 못 찾아 **조용히 통과한다** — 항상 통과하는 가드는 없는 가드보다 나쁘다.
 * `report.spec.ts`가 실제 파일을 읽어 이 집합의 일치를 단언한다.
 * **이 태스크는 그 숫자를 건드리지 않는다.** 한 번도 측정하지 않았고, 측정 없이 쓴 기준선은 거짓이다.
 *
 * ## 2. 척도가 둘이다 — 섞으면 감사 B-1과 같은 종류의 사고가 난다
 * `citationRuleCheck`는 **비율(0..1)**이고 `faithfulness`·`usefulness`는 specs/05가 정한
 * **1–5 점수**다. 하나의 `Ratio`로 묶으면 4.0이 스키마에서 죽거나, 0..1로 정규화한 값이
 * 4.0 기준선과 비교되어 전 리포트가 회귀로 찍힌다. 그래서 필드별로 범위를 따로 건다.
 *
 * ## 3. 답변 본문은 리포트에 싣지 않는다
 * `cases[]`에는 길이·판정·위반 종류만 남는다. 커밋되는 파일이라 답변 전문을 실으면 (a) 파일이
 * 부풀고 (b) 사용자가 붙여 넣은 텍스트가 인용으로 되비쳐 리포트 경유로 샌다. T-016이
 * `args` 값을 통째로 싣지 않은 것과 같은 판단이다. judge의 짧은 근거만 상한을 두고 남긴다.
 *
 * ## 4. `generator.trusted`·`judge.trusted`가 이 리포트의 존재 이유의 절반이다
 * 답변은 **실제 모델**이 만들어야 하고 판정은 **실제 judge**가 해야 한다
 * (specs/05: "실제 모델 호출은 eval 계층에서만"). 픽스처로 낸 수치는 생성 품질이 아니라
 * 픽스처의 자기 확인이므로 `trusted:false`가 되고, 회귀 판정 자체가 막힌다.
 */
import { z } from "zod";

/** 리포트 종류 태그. 한 디렉터리에 retrieval·tools 리포트가 섞여도 구별된다. */
export const GENERATION_REPORT_KIND = "generation";

/** specs/05가 요구하는 지표. `eval/baselines.json`의 `generation` 키와 글자 그대로 같다. */
export const GENERATION_METRIC_KEYS = [
  "citationRuleCheck",
  "faithfulness",
  "usefulness",
] as const;
export type GenerationMetricKey = (typeof GENERATION_METRIC_KEYS)[number];

export const GENERATION_REPORT_FILE_PATTERN = /^\d{4}-\d{2}-\d{2}-generation\.json$/;
export const GENERATION_REPORT_DIR = "eval/reports";

const IsoDate = z.string().regex(/^\d{4}-\d{2}-\d{2}$/, "YYYY-MM-DD 형식이어야 한다");

export function generationReportFileName(date: string): string {
  IsoDate.parse(date);
  return `${date}-${GENERATION_REPORT_KIND}.json`;
}

/** `Date` → `YYYY-MM-DD`(UTC). 로컬 타임존에 따라 파일명이 하루 밀리지 않게 UTC로 고정한다. */
export function toReportDate(now: Date): string {
  return now.toISOString().slice(0, 10);
}

const Ratio = z.number().min(0).max(1);

/**
 * specs/05의 1–5 judge 점수. **하한이 0인 것은 "잰 것이 없다"를 표현하기 위해서다** —
 * 답변이 0건이면 평균이 정의되지 않고, 그때 이 필드는 0이며 `regression.evaluated`가
 * `false`가 된다(`baseline-guard.ts`). 0을 "아주 나쁜 점수"로 읽으면 안 된다.
 */
const JudgeScore = z.number().min(0).max(5);

export const GenerationMetrics = z
  .object({
    /**
     * specs/05 Eval 2(a): "모든 주장 문장에 유효 `[REC-...]` — 자동, **100% 요구**".
     * 분모는 **답을 낸 케이스 수**다. `found:false`로 끝난 케이스는 답변이 없으므로 분모에
     * 넣지 않는다 — 넣으면 임계값 게이트가 잘 동작할수록 인용 통과율이 떨어진다.
     */
    citationRuleCheck: Ratio,
    faithfulness: JudgeScore,
    usefulness: JudgeScore,
  })
  .strict();
export type GenerationMetrics = z.infer<typeof GenerationMetrics>;

/**
 * 기준선 비교 대상이 **아닌** 진단 지표. 회귀가 났을 때 "검색이 나빠졌나, 게이트가 세졌나,
 * 모델이 인용을 안 붙이나"를 가르는 데 쓴다.
 */
export const GenerationDiagnostics = z
  .object({
    caseCount: z.number().int().min(0),
    /** 답을 낸 케이스 수. `citationRuleCheck`의 분모다. */
    answeredCount: z.number().int().min(0),
    notFoundCount: z.number().int().min(0),
    /** specs/05 Eval 2(c): 무관한 쿼리 시나리오 수와 그중 `found:false`가 나온 수. */
    thresholdScenarioCount: z.number().int().min(0),
    thresholdScenarioPass: z.number().int().min(0),
    /** specs/03 §5의 `groundingViolation`이 몇 건 났는가. 0이 아니면 그 자체가 사건이다. */
    groundingViolations: z.number().int().min(0),
    claimSentences: z.number().int().min(0),
    citedSentences: z.number().int().min(0),
    /** 컨텍스트에 없는데 인용된 ID의 총 개수. 모델이 지어낸 것이다. */
    unknownCitations: z.number().int().min(0),
  })
  .strict();
export type GenerationDiagnostics = z.infer<typeof GenerationDiagnostics>;

/** 케이스가 무엇을 가르는가. `irrelevant`는 specs/05 Eval 2(c)의 무관한 쿼리다. */
export const CASE_KINDS = ["grounded", "irrelevant"] as const;
export const CaseKind = z.enum(CASE_KINDS);
export type CaseKind = z.infer<typeof CaseKind>;

export const CaseJudgement = z
  .object({
    faithfulness: z.number().min(1).max(5),
    usefulness: z.number().min(1).max(5),
    /** judge의 짧은 근거. 상한을 둔다 — 리포트는 커밋되고 무한히 자라면 안 된다. */
    note: z.string().max(240),
  })
  .strict();
export type CaseJudgement = z.infer<typeof CaseJudgement>;

export const GenerationCaseResult = z
  .object({
    caseId: z.string().min(1),
    query: z.string().min(1),
    kind: CaseKind,
    /** 이 케이스가 무슨 경계를 가르는지. 리포트만 읽는 사람에게 오답의 의미를 준다. */
    boundary: z.string().min(1),
    /** `irrelevant`면 false를 기대한다. */
    expectFound: z.boolean(),
    found: z.boolean(),
    /** 답변 **길이만** 남긴다. 본문은 싣지 않는다(모듈 주석 3). */
    answerChars: z.number().int().min(0),
    citationCount: z.number().int().min(0),
    /** 인용 룰체크 통과 여부. 답이 없으면 `null`(판정 대상 아님)이다 — `false`가 아니다. */
    citationRuleCheck: z.boolean().nullable(),
    claimSentences: z.number().int().min(0),
    citedSentences: z.number().int().min(0),
    /** 위반 종류별 건수. 문장 원문은 남기지 않는다. */
    missingCitationSentences: z.number().int().min(0),
    unknownCitationSentences: z.number().int().min(0),
    /** 지어낸 인용 ID. **ID는 답변 본문이 아니라 식별자**라 그대로 남긴다 — 추적에 필요하다. */
    unknownCitations: z.array(z.string()),
    judgement: CaseJudgement.nullable(),
  })
  .strict();
export type GenerationCaseResult = z.infer<typeof GenerationCaseResult>;

export const BaselineViolation = z
  .object({
    metric: z.enum(GENERATION_METRIC_KEYS),
    value: z.number(),
    baseline: z.number(),
    /** `value - baseline`. 음수다. */
    delta: z.number(),
  })
  .strict();
export type BaselineViolation = z.infer<typeof BaselineViolation>;

/** `evaluated`와 `pass`를 나눠 둔 근거는 T-013·T-016과 같다. */
export const RegressionVerdict = z
  .object({
    evaluated: z.boolean(),
    pass: z.boolean(),
    violations: z.array(BaselineViolation),
    reason: z.string().nullable(),
  })
  .strict();
export type RegressionVerdict = z.infer<typeof RegressionVerdict>;

/** 무엇이 답을 만들었는가 / 무엇이 채점했는가. 하나라도 `trusted:false`면 판정하지 않는다. */
export const ModelProvenance = z
  .object({
    provider: z.string().min(1),
    model: z.string().min(1),
    trusted: z.boolean(),
  })
  .strict();
export type ModelProvenance = z.infer<typeof ModelProvenance>;

export const GenerationReport = z
  .object({
    kind: z.literal(GENERATION_REPORT_KIND),
    date: IsoDate,
    generatedAt: z.string().datetime(),
    /** 답변을 만든 경로(core-api 뒤의 실 모델인가, 픽스처인가). */
    generator: ModelProvenance,
    /** specs/05 Eval 2(b): "소형 모델 사용". 어느 모델로 쟀는지가 점수의 의미를 정한다. */
    judge: ModelProvenance,
    config: z
      .object({
        caseCount: z.number().int().min(0),
        expectedCaseCount: z.number().int().positive(),
      })
      .strict(),
    metrics: GenerationMetrics,
    diagnostics: GenerationDiagnostics,
    /** 비교에 쓴 기준선 사본. 리포트만 보고도 판정을 재현할 수 있어야 한다. */
    baselines: GenerationMetrics,
    regression: RegressionVerdict,
    /** 사람이 읽어야 할 단서. 비어 있지 않으면 콘솔에도 그대로 나온다. */
    warnings: z.array(z.string()),
    cases: z.array(GenerationCaseResult),
  })
  .strict();
export type GenerationReport = z.infer<typeof GenerationReport>;
