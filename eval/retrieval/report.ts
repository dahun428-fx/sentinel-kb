/**
 * retrieval eval 리포트의 스키마와 파일명 규약. 출처: specs/05 "Eval 1: Retrieval".
 *
 * specs/05가 리포트에 요구하는 것은 셋이다:
 *   1. 경로·파일명 — `eval/reports/YYYY-MM-DD-retrieval.json`
 *   2. 지표 — **Recall@5, MRR**
 *   3. 커밋 대상 — "시계열이 곧 포트폴리오 자산"(eval-runner 스킬)
 *
 * ## 지표 키가 `baselines.json`과 **글자 그대로** 같아야 한다
 * `eval/baselines.json`의 `retrieval`은 `{"recall@5", "mrr"}`이다. 리포트가 `recall5` 같은
 * 다른 이름을 쓰면 회귀 가드는 **키를 못 찾아 조용히 통과한다** — 항상 통과하는 가드는
 * 없는 가드보다 나쁘다(있다고 믿게 만들기 때문이다). 그래서 `RETRIEVAL_METRIC_KEYS`를
 * 여기서 한 번 선언하고, `report.spec.ts`가 그것이 `baselines.json`의 키 집합과 일치하는지
 * 실제 파일을 읽어 단언한다. 한쪽만 바뀌면 그 테스트가 죽는다.
 *
 * ## `embedding.trusted`가 이 리포트의 존재 이유의 절반이다
 * `FakeEmbedder`는 해시 기반이라 서로 다른 텍스트 간 cosine ≈ 0이다(T-006 F-8, 실측 −0.00007).
 * 그 상태로 낸 수치는 검색 품질이 아니라 **BM25 단독 성능**이다(T-012 검증: 벡터 경로를
 * 융합에서 제거해도 통합 테스트 11개 전부 통과). 그런 수치가 기준선과 나란히 커밋되면
 * 다음 사람이 그것을 근거로 판단한다. 그래서 provider 출처를 리포트 안에 박고,
 * `trusted:false`인 리포트로는 **회귀 판정을 하지 않는다**(baseline-guard).
 */
import { z } from "zod";

import { QUERY_KINDS } from "./query-kind.js";

/** 리포트 종류 태그. 한 디렉터리에 generation·tools 리포트가 섞여도 구별된다. */
export const RETRIEVAL_REPORT_KIND = "retrieval";

/** specs/05가 요구하는 지표. `eval/baselines.json`의 `retrieval` 키와 글자 그대로 같다. */
export const RETRIEVAL_METRIC_KEYS = ["recall@5", "mrr"] as const;
export type RetrievalMetricKey = (typeof RETRIEVAL_METRIC_KEYS)[number];

/** specs/05의 `eval/reports/YYYY-MM-DD-retrieval.json`. */
export const RETRIEVAL_REPORT_FILE_PATTERN = /^\d{4}-\d{2}-\d{2}-retrieval\.json$/;
export const RETRIEVAL_REPORT_DIR = "eval/reports";

const IsoDate = z.string().regex(/^\d{4}-\d{2}-\d{2}$/, "YYYY-MM-DD 형식이어야 한다");

export function retrievalReportFileName(date: string): string {
  IsoDate.parse(date);
  return `${date}-${RETRIEVAL_REPORT_KIND}.json`;
}

/** `Date` → `YYYY-MM-DD`(UTC). 로컬 타임존에 따라 파일명이 하루 밀리지 않게 UTC로 고정한다. */
export function toReportDate(now: Date): string {
  return now.toISOString().slice(0, 10);
}

/** 0..1 지표. 범위를 넘는 값은 계산 버그이지 관측 결과가 아니다. */
const Ratio = z.number().min(0).max(1);

export const RetrievalMetrics = z
  .object({
    "recall@5": Ratio,
    mrr: Ratio,
  })
  .strict();
export type RetrievalMetrics = z.infer<typeof RetrievalMetrics>;

/** 질의 종류별 분해. **기준선 비교 대상이 아니다** — 진단용이다(위 query-kind.ts 참조). */
export const QueryKindBreakdown = z
  .object({
    caseCount: z.number().int().min(0),
    "recall@5": Ratio,
    mrr: Ratio,
    ambiguousTieCount: z.number().int().min(0),
  })
  .strict();
export type QueryKindBreakdown = z.infer<typeof QueryKindBreakdown>;

/**
 * 세 종류를 **전부 필수로** 적는다. `z.record(z.enum(...))`로 쓰면 zod가 Partial로 추론해서
 * 소비자가 매번 `?.`를 붙이게 되고, 케이스가 0건인 종류의 키가 조용히 사라져도 아무도 모른다.
 * 리포트 diff에서 "0건"과 "안 잼"이 섞이는 것을 막는다.
 * (`report.spec.ts`가 이 키 집합이 `QUERY_KINDS`와 같은지 단언한다 — 종류가 늘면 여기서 죽는다.)
 */
export const ByQueryKind = z
  .object({
    identifier: QueryKindBreakdown,
    "korean-prose": QueryKindBreakdown,
    other: QueryKindBreakdown,
  })
  .strict();
export type ByQueryKind = z.infer<typeof ByQueryKind>;

export const EmbeddingProvenance = z
  .object({
    provider: z.string().min(1),
    version: z.number().int(),
    dim: z.number().int().positive(),
    /**
     * 의미 있는 임베딩으로 측정했는가. `false`면 이 리포트의 수치는 검색 품질이 아니다.
     * 회귀 가드가 이 필드를 보고 판정 자체를 거부한다.
     */
    trusted: z.boolean(),
  })
  .strict();
export type EmbeddingProvenance = z.infer<typeof EmbeddingProvenance>;

export const RetrievalCaseResult = z
  .object({
    caseId: z.string().min(1),
    query: z.string().min(1),
    queryKind: z.enum(QUERY_KINDS),
    expectedRecordIds: z.array(z.string()).min(1),
    rankedRecordIds: z.array(z.string()),
    firstHitRank: z.number().int().positive().nullable(),
    hit: z.boolean(),
    reciprocalRank: Ratio,
    ambiguousTie: z.boolean(),
  })
  .strict();
export type RetrievalCaseResult = z.infer<typeof RetrievalCaseResult>;

export const BaselineViolation = z
  .object({
    metric: z.enum(RETRIEVAL_METRIC_KEYS),
    value: z.number(),
    baseline: z.number(),
    /** `value - baseline`. 음수다. 얼마나 떨어졌는지가 회귀 분석의 첫 질문이다. */
    delta: z.number(),
  })
  .strict();
export type BaselineViolation = z.infer<typeof BaselineViolation>;

/**
 * 회귀 판정. **`evaluated`와 `pass`를 나눠 둔 것이 핵심이다.**
 * "판정했고 통과"와 "판정할 수 없었다"를 같은 `pass:true`로 접으면, 자격증명 없이 돌린
 * 리포트가 기준선을 통과한 것처럼 보인다. 그건 이 태스크가 막으려는 바로 그 거짓이다.
 */
export const RegressionVerdict = z
  .object({
    evaluated: z.boolean(),
    pass: z.boolean(),
    violations: z.array(BaselineViolation),
    /** `evaluated:false`일 때 왜 판정하지 못했는지. 판정했으면 null이다. */
    reason: z.string().nullable(),
  })
  .strict();
export type RegressionVerdict = z.infer<typeof RegressionVerdict>;

export const RetrievalReport = z
  .object({
    kind: z.literal(RETRIEVAL_REPORT_KIND),
    /** 파일명의 날짜와 같아야 한다. `writeRetrievalReport`가 그 일치를 강제한다. */
    date: IsoDate,
    generatedAt: z.string().datetime(),
    embedding: EmbeddingProvenance,
    config: z
      .object({
        /** `/v1/search`에 보낸 `limit`. 스윕 대상이다(T-011 Findings). */
        limit: z.number().int().min(1).max(20),
        /** 지표 컷오프. specs/05가 Recall@**5**로 고정했다. */
        k: z.literal(5),
        caseCount: z.number().int().min(0),
        /** specs/05의 "query 30개". 실제 케이스 수와 다르면 경고가 붙는다. */
        expectedCaseCount: z.number().int().positive(),
      })
      .strict(),
    metrics: RetrievalMetrics,
    byQueryKind: ByQueryKind,
    /** 비교에 쓴 기준선 사본. 리포트만 보고도 판정을 재현할 수 있어야 한다. */
    baselines: RetrievalMetrics,
    regression: RegressionVerdict,
    /** 사람이 읽어야 할 단서. 비어 있지 않으면 콘솔에도 그대로 나온다. */
    warnings: z.array(z.string()),
    cases: z.array(RetrievalCaseResult),
  })
  .strict();
export type RetrievalReport = z.infer<typeof RetrievalReport>;
