/**
 * tool-selection eval 리포트의 스키마와 파일명 규약. 출처: specs/05 "Eval 3: Tool-selection".
 *
 * T-013(`eval/retrieval/report.ts`)이 세운 규약을 그대로 따른다. 되풀이하지 않기 위해
 * **여기서만 다른 점**을 적는다.
 *
 * ## 1. 지표 키는 `baselines.json`의 `tools`와 **글자 그대로** 같아야 한다
 * `eval/baselines.json`의 `tools`는 `{"selectionAccuracy"}` 하나다. 리포트가 `accuracy` 같은
 * 다른 이름을 쓰면 회귀 가드는 키를 못 찾아 **조용히 통과한다** — 항상 통과하는 가드는 없는
 * 가드보다 나쁘다. `report.spec.ts`가 실제 파일을 읽어 이 집합의 일치를 단언한다.
 *
 * ## 2. `selector.trusted`가 이 리포트의 존재 이유의 절반이다
 * 시나리오 판정은 **도구 목록을 주고 모델이 무엇을 고르는지 보는 것**이라 실제 모델 호출이
 * 필요하다(specs/05 "실제 모델 호출은 eval 계층에서만"). 오라클·스크립트 selector로 낸 수치는
 * 도구 선택률이 아니라 **테스트 픽스처의 자기 확인**이다. 그래서 provenance를 리포트 안에 박고,
 * `trusted:false`인 리포트로는 회귀 판정을 하지 않는다(`baseline-guard.ts`).
 *
 * ## 3. `catalog.descriptionSha256`이 G6를 실제로 이행 가능하게 만든다
 * specs/07은 "description 변경은 계약 변경이다 → tool-selection eval 재실행 필수(G6)"라고
 * 못박는다. 그런데 리포트가 **무엇을 재고 있었는지** 남기지 않으면, description이 바뀐 뒤에도
 * 과거 리포트가 여전히 유효해 보인다. 이 해시는 도구 이름·description·인자 description을 전부
 * 먹는다 — 값이 달라진 순간 그 리포트는 **다른 계약을 잰 리포트**이고, 기준선 비교 대상이 아니다.
 *
 * ## 4. 오답이 무엇을 골랐는지 리포트에 남는다 (T-016 Acceptance 2)
 * `cases[].attempts[].chosenTool`이 시도마다의 원본 사실이고, `confusions[]`가 그것을 사람이
 * 읽을 수 있게 접은 것이다. 둘 다 있는 이유: 집계만 남기면 3회 반복 중 **어느 회차가** 틀렸는지가
 * 사라지고(안정성 진단 불가), 원본만 남기면 60건을 손으로 세야 한다.
 */
import { z } from "zod";

/** 리포트 종류 태그. 한 디렉터리에 retrieval·generation 리포트가 섞여도 구별된다. */
export const TOOLS_REPORT_KIND = "tools";

/** specs/05가 요구하는 지표. `eval/baselines.json`의 `tools` 키와 글자 그대로 같다. */
export const TOOLS_METRIC_KEYS = ["selectionAccuracy"] as const;
export type ToolsMetricKey = (typeof TOOLS_METRIC_KEYS)[number];

/** T-016 Scope: 리포트 `eval/reports/{date}-tools.json`. */
export const TOOLS_REPORT_FILE_PATTERN = /^\d{4}-\d{2}-\d{2}-tools\.json$/;
export const TOOLS_REPORT_DIR = "eval/reports";

const IsoDate = z.string().regex(/^\d{4}-\d{2}-\d{2}$/, "YYYY-MM-DD 형식이어야 한다");

export function toolsReportFileName(date: string): string {
  IsoDate.parse(date);
  return `${date}-${TOOLS_REPORT_KIND}.json`;
}

/** `Date` → `YYYY-MM-DD`(UTC). 로컬 타임존에 따라 파일명이 하루 밀리지 않게 UTC로 고정한다. */
export function toReportDate(now: Date): string {
  return now.toISOString().slice(0, 10);
}

/** 0..1 지표. 범위를 넘는 값은 계산 버그이지 관측 결과가 아니다. */
const Ratio = z.number().min(0).max(1);

/** 도구 이름 또는 `null`(= 아무 도구도 부르지 않는 것이 정답/선택). */
const ToolName = z.string().min(1).nullable();

export const ToolsMetrics = z
  .object({
    /**
     * **올바른 도구 + 필수 인자**를 모두 맞춘 시도의 비율(specs/05 Eval 3).
     * 분모는 시나리오 수가 아니라 **시도 수**(시나리오 × 반복)다 — 3회 중 2회만 맞는 도구는
     * 실전에서 3분의 1의 확률로 틀리는 도구이고, 시나리오 단위로 접으면 그 사실이 사라진다.
     */
    selectionAccuracy: Ratio,
  })
  .strict();
export type ToolsMetrics = z.infer<typeof ToolsMetrics>;

/**
 * 기준선 비교 대상이 **아닌** 진단 지표. 회귀가 났을 때 "도구를 틀렸나, 인자를 빠뜨렸나,
 * 아니면 흔들리나"를 가르는 데 쓴다. 기준선에 넣지 않는 이유는 specs/05가 `selectionAccuracy`
 * 하나만 목표로 정했기 때문이다 — 재지 않은 지표에 선을 긋지 않는다.
 */
export const ToolsDiagnostics = z
  .object({
    /** 인자를 무시하고 **도구만** 맞은 비율. `selectionAccuracy`와의 차이가 곧 인자 누락분이다. */
    toolAccuracy: Ratio,
    /** 도구가 맞은 시도 중 필수 인자까지 채운 비율. 도구 정답이 0건이면 0이고 경고가 붙는다. */
    argAccuracy: Ratio,
    /** 반복 전 회차가 같은 도구를 고른 시나리오의 비율. 낮으면 description이 경계를 못 긋고 있다. */
    stability: Ratio,
    scenarioCount: z.number().int().min(0),
    repeats: z.number().int().min(1),
    attempts: z.number().int().min(0),
  })
  .strict();
export type ToolsDiagnostics = z.infer<typeof ToolsDiagnostics>;

/**
 * 기대 도구별 분해. **배열이다 — `z.record`가 아니다.**
 * record로 쓰면 zod가 Partial로 추론해 소비자가 매번 `?.`를 붙이게 되고, 시나리오가 0건인
 * 도구의 키가 조용히 사라져도 아무도 모른다(T-013 `ByQueryKind` 주석과 같은 이유).
 * 배열이면 "그 도구는 아예 재지 않았다"가 **행의 부재**로 드러나고, 러너가 경고를 붙인다.
 */
export const ExpectedToolBreakdown = z
  .object({
    /** `null`은 "아무 도구도 부르지 않는 것이 정답"인 묶음이다. */
    expectedTool: ToolName,
    scenarioCount: z.number().int().min(0),
    attempts: z.number().int().min(0),
    selectionAccuracy: Ratio,
    toolAccuracy: Ratio,
  })
  .strict();
export type ExpectedToolBreakdown = z.infer<typeof ExpectedToolBreakdown>;

/** 기대한 인자 값과 실제 값이 다른 경우. `record_knowledge(type:divergence)`가 이걸로 판정된다. */
export const WrongArg = z
  .object({
    name: z.string().min(1),
    expected: z.string(),
    /** 그 인자를 아예 안 채웠으면 `null`. "다른 값을 넣었다"와 "안 넣었다"는 다른 오답이다. */
    actual: z.string().nullable(),
  })
  .strict();
export type WrongArg = z.infer<typeof WrongArg>;

/**
 * 시도 1회. **`args`의 값을 통째로 싣지 않는다** — 모델이 채운 본문(예: `resolution` 전문)이
 * 그대로 리포트에 박히면 커밋되는 파일이 부풀고, 시크릿·인젝션 텍스트가 리포트 경유로 샌다.
 * 채운 **키 목록**과, 값까지 봐야 하는 인자(`expectedArgs`)의 값만 남긴다.
 */
export const ToolAttempt = z
  .object({
    /** 1부터. 회차를 남겨야 "3회 중 2회차만 틀렸다"를 읽을 수 있다. */
    index: z.number().int().positive(),
    /** 모델이 고른 도구. `null`은 아무 도구도 부르지 않았다는 뜻이다. */
    chosenTool: ToolName,
    argKeys: z.array(z.string()),
    /** 도구는 맞았는데 빠뜨린 필수 인자. 도구를 틀렸으면 비어 있다(그때는 인자 판정을 하지 않는다). */
    missingArgs: z.array(z.string()),
    wrongArgs: z.array(WrongArg),
    correct: z.boolean(),
  })
  .strict();
export type ToolAttempt = z.infer<typeof ToolAttempt>;

export const ToolCaseResult = z
  .object({
    scenarioId: z.string().min(1),
    prompt: z.string().min(1),
    /** 이 시나리오가 무슨 경계를 가르는지. 리포트만 읽는 사람에게 오답의 의미를 준다. */
    boundary: z.string().min(1),
    expectedTool: ToolName,
    requiredArgs: z.array(z.string()),
    expectedArgs: z.record(z.string(), z.string()),
    attempts: z.array(ToolAttempt).min(1),
    correctCount: z.number().int().min(0),
    /** 반복 전 회차가 같은 도구를 골랐는가. 정답 여부와 무관하다 — "일관되게 틀리는" 것도 안정이다. */
    stable: z.boolean(),
  })
  .strict();
export type ToolCaseResult = z.infer<typeof ToolCaseResult>;

/** 오답 집계. **Acceptance 2가 요구하는 "어떤 도구를 잘못 골랐는지"가 이 표다.** */
export const Confusion = z
  .object({
    scenarioId: z.string().min(1),
    expectedTool: ToolName,
    chosenTool: ToolName,
    /** 반복 중 이 오답이 몇 번 났는지. */
    count: z.number().int().positive(),
    /** 도구는 맞았는데 인자 때문에 틀린 경우 여기에 이유가 남는다. */
    missingArgs: z.array(z.string()),
    wrongArgs: z.array(WrongArg),
  })
  .strict();
export type Confusion = z.infer<typeof Confusion>;

export const BaselineViolation = z
  .object({
    metric: z.enum(TOOLS_METRIC_KEYS),
    value: z.number(),
    baseline: z.number(),
    /** `value - baseline`. 음수다. 얼마나 떨어졌는지가 회귀 분석의 첫 질문이다. */
    delta: z.number(),
  })
  .strict();
export type BaselineViolation = z.infer<typeof BaselineViolation>;

/**
 * 회귀 판정. **`evaluated`와 `pass`를 나눠 둔 것이 핵심이다**(T-013과 같은 규약).
 * "판정했고 통과"와 "판정할 수 없었다"를 같은 `pass:true`로 접으면, 실제 모델 없이 돌린
 * 리포트가 기준선을 통과한 것처럼 보인다.
 */
export const RegressionVerdict = z
  .object({
    evaluated: z.boolean(),
    pass: z.boolean(),
    violations: z.array(BaselineViolation),
    reason: z.string().nullable(),
  })
  .strict();
export type RegressionVerdict = z.infer<typeof RegressionVerdict>;

/** 무엇을 잰 selector였는가. `trusted:false`면 이 리포트로 판정하지 않는다. */
export const SelectorProvenance = z
  .object({
    /** 예: `anthropic`, `oracle`. 어떤 경로로 도구를 골랐는지. */
    provider: z.string().min(1),
    /** 모델 식별자. 세대가 바뀌면 같은 description도 다른 선택률을 낸다. */
    model: z.string().min(1),
    /**
     * 실제 모델이 골랐는가. `false`면 이 수치는 도구 선택률이 아니라 픽스처의 자기 확인이다.
     */
    trusted: z.boolean(),
  })
  .strict();
export type SelectorProvenance = z.infer<typeof SelectorProvenance>;

/**
 * 잰 대상(도구 계약)의 지문. **G6가 딛고 서는 필드다** — 값이 달라진 리포트끼리는
 * 기준선 비교의 의미가 없다. 스냅샷이 아니라 실물 등록 결과에서 계산된다(`catalog.ts`).
 */
export const CatalogProvenance = z
  .object({
    toolCount: z.number().int().min(0),
    toolNames: z.array(z.string().min(1)),
    /** 도구 이름 + description + 인자 이름·필수여부·description을 전부 먹는 sha256. */
    descriptionSha256: z.string().regex(/^[0-9a-f]{64}$/),
  })
  .strict();
export type CatalogProvenance = z.infer<typeof CatalogProvenance>;

export const ToolsReport = z
  .object({
    kind: z.literal(TOOLS_REPORT_KIND),
    /** 파일명의 날짜와 같아야 한다. `writeToolsReport`가 그 일치를 강제한다. */
    date: IsoDate,
    generatedAt: z.string().datetime(),
    selector: SelectorProvenance,
    catalog: CatalogProvenance,
    config: z
      .object({
        /** T-016 Scope: "각 3회 반복해 안정성 측정". */
        repeats: z.number().int().min(1),
        scenarioCount: z.number().int().min(0),
        /** specs/05의 "시나리오 20개". 실제 수와 다르면 경고가 붙는다. */
        expectedScenarioCount: z.number().int().positive(),
      })
      .strict(),
    metrics: ToolsMetrics,
    diagnostics: ToolsDiagnostics,
    byExpectedTool: z.array(ExpectedToolBreakdown),
    /** 비교에 쓴 기준선 사본. 리포트만 보고도 판정을 재현할 수 있어야 한다. */
    baselines: ToolsMetrics,
    regression: RegressionVerdict,
    confusions: z.array(Confusion),
    /** 사람이 읽어야 할 단서. 비어 있지 않으면 콘솔에도 그대로 나온다. */
    warnings: z.array(z.string()),
    cases: z.array(ToolCaseResult),
  })
  .strict();
export type ToolsReport = z.infer<typeof ToolsReport>;
