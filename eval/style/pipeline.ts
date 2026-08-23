/**
 * 판정 대상 아티클을 **실제 파이프라인으로** 만든다 — `extractFacts`(T-030) → `draftArticle`(T-031).
 *
 * ## 왜 아티클을 코퍼스에 박아 두지 않는가
 *
 * 박아 두면 이 eval이 재는 것은 **오늘의 파이프라인이 아니라 어제 뜬 사본**이다.
 * 프롬프트가 바뀌고 템플릿이 늘고 린터 규칙이 조정돼도 수치는 그대로다 —
 * T-016이 도구 카탈로그를 스냅샷하지 않고 `createMcpServer` 실물에서 읽은 것과 같은 이유다.
 * 그래서 실행마다 실제로 쓴다. 대가는 자격증명이 필요하다는 것이고, 없으면 78이다.
 *
 * ## 린트·팩트 대조 결과는 **judge에게 넘어가지 않는다**
 *
 * 여기서 나온 `PipelineOutcome`은 §6의 결정론 지표(린트 통과율·팩트 대조 위반 수)로만 쓰이고,
 * `StylePiece`에는 본문만 실려 judge에게 간다. 두 계기를 섞으면 T-034가 재려던 것이
 * 린터의 사본이 된다(`judge.ts` 서두).
 *
 * ## 반려된 초안은 코퍼스에 넣지 않는다
 *
 * 반려분은 발행 후보가 아니다(§0-5). 그것을 섞으면 "발행될 리 없는 글"의 AI 티까지 평균에
 * 들어가고, 그 평균은 독자가 볼 글에 대해 아무것도 말하지 않는다. 대신 `PipelineOutcome`에
 * 남아 리포트의 경고가 된다 — **조용히 사라지지는 않는다.**
 */
import type { ArticleKind, RecordSchema } from "@sentinel/contracts";
import { draftArticle, extractFacts, type ChatModel } from "@sentinel/core";

import type { StylePiece } from "./corpus.js";
import type { PipelineOutcome } from "./metrics.js";

/** §1 B 패턴 아티클. 시드 사건 여러 건을 한 편으로 묶는 유형이다. */
export const ARTICLE_KIND: ArticleKind = "pattern";

export interface GenerateArticlesInput {
  readonly records: readonly RecordSchema[];
  readonly model: ChatModel;
  /** 스타일 표본 디렉터리. 기본값은 `prompts/style/`(publisher config). */
  readonly styleDir?: string;
  readonly kind?: ArticleKind;
  readonly articleId?: string;
}

export interface GeneratedArticles {
  readonly pieces: StylePiece[];
  readonly outcomes: PipelineOutcome[];
}

export async function generateArticles(input: GenerateArticlesInput): Promise<GeneratedArticles> {
  const kind = input.kind ?? ARTICLE_KIND;
  const articleId = input.articleId ?? `ART-${kind}-01`;
  const { facts, charts } = extractFacts({ kind, records: input.records });

  const outcome = await draftArticle({
    kind,
    facts,
    charts,
    records: input.records,
    model: input.model,
    ...(input.styleDir === undefined ? {} : { styleDir: input.styleDir }),
  });

  const report = outcome.report;
  const summary: PipelineOutcome = {
    articleId,
    accepted: outcome.accepted,
    rejection: report.rejection,
    lintPassed: report.lint === null ? null : report.lint.passed,
    // **규칙 id만 싣는다.** `detail`에는 본문에서 오려 낸 문자열이 들어 있다(lint.ts).
    lintViolationRules: report.lint === null ? [] : report.lint.violations.map((entry) => entry.rule),
    // 위반 **건수만** 싣는다. `FactViolation.value`는 본문 조각이다(factcheck.ts).
    factCheckViolations: report.factCheck === null ? null : report.factCheck.violations.length,
    attempts: report.attempts,
    styleSamples: report.style.samples,
  };

  return {
    pieces: outcome.accepted
      ? [{ origin: "generated", sourceRef: articleId, text: outcome.patch.body }]
      : [],
    outcomes: [summary],
  };
}
