/**
 * 스타일 eval 리포트 스키마. 출처: specs/08-publishing.md §6, T-034 Acceptance 1.
 *
 * `eval/injection/report.ts`·`eval/retrieval/report.ts`의 규약을 그대로 따른다:
 *   - 파일명 `eval/reports/YYYY-MM-DD-style.json`, `kind`로 종류를 구별
 *   - `evaluated`와 `pass`를 **나눈다** — "판정 불가"를 "통과"로 접지 않는다
 *   - 비교에 쓴 기준선 사본을 리포트 안에 박아 판정을 재현 가능하게 한다
 *
 * ## ⚠️ 리포트에 글 전문을 싣지 않는다
 *
 * 리포트는 커밋되고 PR 본문에 붙는다. 판정 대상에는 **아직 사람이 편집하지 않은 초안**과
 * 사람이 쓴 글이 섞여 있고, 발행은 사람 승인 뒤에만 한다(§0-5·§7). 전문을 리포트에 실으면
 * 이 eval이 **미승인 초안의 배포 경로**가 된다. T-021이 인젝션 페이로드에 대해 내린 결론과
 * 같은 판단이며, 같은 방식으로 강제한다: 본문 문자열을 담을 수 있는 필드가 스키마에
 * **아예 없고** `.strict()`가 그것을 지킨다.
 *
 * Acceptance 1("글별 판별 결과와 근거")은 그래서 전문 대신 이렇게 채운다:
 *   `itemId` + `origin` + `sourceRef`(재현 좌표) + `verdict` + `correct` + `reason`(judge의 한 문장).
 * `reason`은 judge가 쓴 문장이지 글에서 오려 낸 것이 아니고, 240자에서 잘린다.
 */
import { z } from "zod";

import { STYLE_ORIGINS } from "./corpus.js";
import { STYLE_VERDICTS } from "./judge.js";

export const STYLE_REPORT_KIND = "style";
export const STYLE_REPORT_DIR = "eval/reports";
export const STYLE_REPORT_FILE_PATTERN = /^\d{4}-\d{2}-\d{2}-style\.json$/;

const IsoDate = z.string().regex(/^\d{4}-\d{2}-\d{2}$/, "YYYY-MM-DD 형식이어야 한다");
const Ratio = z.number().min(0).max(1);

export function styleReportFileName(date: string): string {
  IsoDate.parse(date);
  return `${date}-${STYLE_REPORT_KIND}.json`;
}

/** `Date` → `YYYY-MM-DD`(UTC). 로컬 타임존으로 파일명이 하루 밀리지 않게 고정한다. */
export function toReportDate(now: Date): string {
  return now.toISOString().slice(0, 10);
}

/** 글 한 편의 판정. **본문 필드가 없다.** */
export const StylePieceReport = z
  .object({
    itemId: z.string().min(1),
    origin: z.enum(STYLE_ORIGINS),
    /** 재현 좌표(파일 경로 또는 코퍼스 상수). 본문 대신 이것으로 되짚는다. */
    sourceRef: z.string().min(1),
    chars: z.number().int().min(0),
    verdict: z.enum(STYLE_VERDICTS),
    correct: z.boolean(),
    confidence: z.number().min(1).max(5),
    /** judge가 쓴 한 문장. 글에서 오려 낸 것이 아니다. */
    reason: z.string().max(240),
  })
  .strict();
export type StylePieceReport = z.infer<typeof StylePieceReport>;

/** 아티클 1건의 파이프라인 결과. 린트·팩트 대조는 judge와 **무관하게** 결정론으로 잰다. */
export const PipelineReport = z
  .object({
    articleId: z.string().min(1),
    accepted: z.boolean(),
    rejection: z.string().nullable(),
    /** 모델을 부르지 않았으면 `null`. `false`와 다르다. */
    lintPassed: z.boolean().nullable(),
    lintViolationRules: z.array(z.string()),
    factCheckViolations: z.number().int().min(0).nullable(),
    attempts: z.number().int().min(0),
    /** §0-4 표본 수. 0이면 스타일 주입이 작동하지 않은 실행이다(T-031 F-8). */
    styleSamples: z.number().int().min(0),
  })
  .strict();
export type PipelineReport = z.infer<typeof PipelineReport>;

export const StyleMetricsReport = z
  .object({
    discriminationAccuracy: Ratio,
    chanceLevel: Ratio,
    aiDetectionRate: Ratio,
    humanFalseAiRate: Ratio,
    controlAccuracy: Ratio,
    lintPassRate: Ratio,
    factCheckViolations: z.number().int().min(0),
    /** `null` = 재지 못했다. 0이 아니다. */
    publicationRate: Ratio.nullable(),
    degenerate: z.boolean(),
  })
  .strict();
export type StyleMetricsReport = z.infer<typeof StyleMetricsReport>;

/** §6의 상한. **하한이 아니다** — 판별 정확도는 낮을수록 좋다. */
export const StyleBaselines = z.object({ discriminationAccuracy: Ratio }).strict();
export type StyleBaselines = z.infer<typeof StyleBaselines>;

export const StyleVerdictReport = z
  .object({
    evaluated: z.boolean(),
    pass: z.boolean(),
    reason: z.string().nullable(),
  })
  .strict();
export type StyleVerdictReport = z.infer<typeof StyleVerdictReport>;

/** 판정에 쓴 judge의 출처. `trusted:false`면 그 실행은 측정이 아니다. */
export const StyleJudgeProvenance = z
  .object({
    provider: z.string().min(1),
    model: z.string().min(1),
    trusted: z.boolean(),
  })
  .strict();

export const StyleReport = z
  .object({
    kind: z.literal(STYLE_REPORT_KIND),
    date: IsoDate,
    generatedAt: z.string().datetime(),
    judge: StyleJudgeProvenance,
    /** 블라인딩 시드. 같은 값이면 같은 배치가 재현된다(`blind.ts`). */
    blindSeed: z.string().min(1),
    corpus: z
      .object({
        generated: z.number().int().min(0),
        human: z.number().int().min(0),
        control: z.number().int().min(0),
        /** §6이 요구하는 사람 글 편수. 실제와 다르면 경고가 붙고 판정이 서지 않는다. */
        requiredHuman: z.number().int().positive(),
      })
      .strict(),
    metrics: StyleMetricsReport,
    baselines: StyleBaselines,
    regression: StyleVerdictReport,
    warnings: z.array(z.string()),
    pieces: z.array(StylePieceReport),
    pipeline: z.array(PipelineReport),
  })
  .strict();
export type StyleReport = z.infer<typeof StyleReport>;
