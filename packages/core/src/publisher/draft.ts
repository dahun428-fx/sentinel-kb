/**
 * 작문 파이프라인 — specs/08-publishing.md §4.
 *
 * ```
 * 아웃라인 → 초안(facts + 스타일 few-shot 주입) → 문체 린트
 *   → (위반 시 지적사항 포함 재작성, 최대 2회) → 팩트 대조 → draft 저장
 * ```
 *
 * **순서가 계약이다.** 아웃라인은 코드가 만들고(`templates.ts`), 초안은 모델이 쓰고,
 * 린트는 규칙이 하고(`lint.ts`), 팩트 대조는 린트 루프가 끝난 **뒤에** 한다(`factcheck.ts`).
 *
 * ## 왜 팩트 위반은 재작성이 아니라 반려인가
 *
 * §4의 화살표가 그렇게 그려져 있고(`재작성 루프 → 팩트 대조`), §3이 "facts에 없는 숫자는
 * **반려 사유**"라고 못박았기 때문이다. 재작성 루프에 팩트 위반을 넣으면 상한 2회가
 * 두 종류의 실패를 나눠 쓰게 되고, 스펙이 정한 문면("최대 2회"가 문체 재작성에 붙은 것)이
 * 조용히 다른 뜻이 된다. 스펙을 고치는 것이 먼저다(CLAUDE.md 최우선 원칙 1).
 *
 * ## 상한 2회의 비용 — NFR-01과의 관계 (숨기지 않는다)
 *
 * 모델 호출은 최악 **3회**(초안 1 + 재작성 2)다. T-020이 재생성 1회로 최악값을 2배로
 * 만들었다고 기록했고, 여기서는 3배다. 다만 **NFR-01의 대상 표면이 아니다**:
 * NFR-01은 "검색 API p95 < 1.5s / MCP 도구 p95 < 2s"이고, 아티클 생성은 §7이
 * "검색·기록 경로와 리소스 격리(야간 배치)"로 못박은 별도 경로다. 사용자 요청이 이 3회를
 * 기다리는 일은 설계상 없다.
 *
 * 그렇다고 공짜는 아니다. T-039 F-1이 이미 NFR-01을 **미성립**으로 보고했고(시도당 8s ×
 * 2시도), 그 값이 그대로면 아티클 1건의 최악 지연은 3 × 16s = **48s**다. 배치 창이
 * 그 값을 견디는지는 배치를 실제로 돌려 본 태스크가 판정할 일이며, 이 태스크는
 * **판정하지 않았다.** API 키가 없어 실제 호출을 한 번도 하지 않았기 때문이다.
 *
 * ## 발행하지 않는다
 *
 * 이 파이프라인의 산출물은 `status: "draft"` 리터럴이 박힌 패치 하나뿐이고 `publishedAt`
 * **필드가 존재하지 않는다.** T-029가 후보 단계에서 `candidate`만 쓴 것과 같은 규약이며
 * (§0-5·§7 전자동 발행 금지), 반려되면 패치 자체가 만들어지지 않아 저장할 것이 없다.
 */
import type { ArticleKind, ChartSpec, RecordSchema } from "@sentinel/contracts";

import type { ArticleFacts } from "../facts/types.js";
import type { ChatMessage, ChatModel } from "../llm/types.js";
import { LLM_ERROR_CODES, LlmError } from "../llm/types.js";

import { readPublisherConfig, type PublisherConfig } from "./config.js";
import { crossCheckFacts, type FactCheckReport } from "./factcheck.js";
import { lintDraft, type LintReport } from "./lint.js";
import {
  buildNarrativeSource,
  renderNarrativeSource,
  summarizeNarrative,
  type NarrativeReport,
} from "./narrative.js";
import { loadDraftPrompt } from "./prompt.js";
import { loadStyleSamples, renderStyleSamples } from "./style.js";
import { buildOutline, selectTemplate } from "./templates.js";

/**
 * specs/08 §4가 정한 재작성 횟수. **"최대 2회"는 스펙 문면이지 튜닝 값이 아니다** —
 * env로 열면 0으로 꺼서 린터를 무력화할 수 있다(`generator`의 `MAX_REGENERATIONS`와 같은 규약).
 */
export const MAX_REWRITES = 2;

export const DRAFT_REJECTION_REASONS = [
  /** 서사 재료가 하나도 남지 않았다. 모델을 **부르지 않는다.** */
  "no-narrative",
  /** 재작성 상한까지 갔는데도 문체 위반이 남았다. */
  "lint",
  /** 본문의 수치·날짜·인용이 팩트 팩에 없다 (§3). */
  "fact-check",
] as const;

export type DraftRejectionReason = (typeof DRAFT_REJECTION_REASONS)[number];

export interface StyleReport {
  readonly dirExists: boolean;
  readonly samples: number;
  readonly rejected: readonly { readonly name: string; readonly reason: string }[];
}

/**
 * `articles.lintReport`에 그대로 저장되는 감사 기록(specs/08 §2). 린트 결과만이 아니라
 * **파이프라인이 무엇을 했는지 전부**를 담는다 — 어느 골격을 골랐고, 몇 번 다시 썼고,
 * 어떤 산문을 모델에게 보여 줬고 무엇을 걸렀는지. 이 기록이 없으면 나중에 나쁜 아티클을
 * 보고도 원인을 되짚을 수 없다.
 *
 * `interface`가 아니라 `type`인 것은 의도적이다 — `ArticleSchema.lintReport`가
 * `z.record(z.unknown())`이라 **암시적 인덱스 시그니처**가 필요하고, TS는 그것을 타입
 * 별칭에만 준다. `interface`로 쓰면 저장 시점마다 `as Record<string, unknown>` 캐스팅을
 * 강요하고, 그 캐스팅은 리포트 형상이 바뀌어도 조용히 통과한다.
 */
// eslint-disable-next-line @typescript-eslint/consistent-type-definitions -- 위 주석 참조: 계약(z.record)에 실리려면 타입 별칭이어야 한다.
export type DraftReport = {
  readonly reportVersion: 1;
  readonly templateId: string;
  readonly templateName: string;
  /** 모델 호출 횟수(초안 + 재작성). 최악 `1 + MAX_REWRITES`. */
  readonly attempts: number;
  readonly rewrites: number;
  readonly maxRewrites: number;
  readonly model: string | null;
  /** 모델을 부르지 않았으면 `null`. "위반이 없었다"가 아니다. */
  readonly lint: LintReport | null;
  /** 린트 단계에서 끝났으면 `null`. **`passed:false`와 다르다** (T-020 로그 필드의 그 교훈). */
  readonly factCheck: FactCheckReport | null;
  readonly narrative: NarrativeReport;
  readonly style: StyleReport;
  readonly accepted: boolean;
  readonly rejection: DraftRejectionReason | null;
};

/**
 * 아티클 문서에 덮어쓸 패치. **`publishedAt`이 없고 `status`는 리터럴 `"draft"`다** —
 * 타입에 없는 필드는 쓸 수 없으므로 이 경로로 발행되는 일이 없다.
 */
export interface ArticleDraftPatch {
  readonly status: "draft";
  readonly body: string;
  readonly charts: readonly ChartSpec[];
  readonly lintReport: DraftReport;
}

export type DraftOutcome =
  | { readonly accepted: true; readonly patch: ArticleDraftPatch; readonly report: DraftReport }
  | {
      readonly accepted: false;
      readonly reason: DraftRejectionReason;
      readonly report: DraftReport;
      /** 반려된 본문. 저장하지 않지만 진단에는 필요하다. 모델을 안 불렀으면 `null`. */
      readonly body: string | null;
    };

export interface DraftArticleOptions {
  readonly kind: ArticleKind;
  /** T-030 `extractFacts`의 산출물. */
  readonly facts: ArticleFacts;
  /** 같은 산출물의 차트. 패치에 그대로 실린다 — LLM이 만들지 않는다(§5.1). */
  readonly charts?: readonly ChartSpec[];
  /** 서사 재료의 원본. `facts.sourceRecordIds` 밖은 `narrative.ts`가 잘라낸다. */
  readonly records: readonly RecordSchema[];
  readonly model: ChatModel;
  readonly config?: PublisherConfig;
  /** 스타일 표본 디렉터리 override. 테스트·eval이 표본을 갈아 끼우는 지점이다. */
  readonly styleDir?: string;
}

export async function draftArticle(options: DraftArticleOptions): Promise<DraftOutcome> {
  const config = options.config ?? readPublisherConfig();
  const template = selectTemplate(options.kind, options.facts.sourceRecordIds);

  const source = buildNarrativeSource({
    records: options.records,
    facts: options.facts,
    partMaxChars: config.narrativePartMaxChars,
  });
  const narrative = summarizeNarrative(source);

  const loaded = loadStyleSamples({
    dir: options.styleDir ?? config.styleSamplesDir,
    maxChars: config.styleSampleMaxChars,
  });
  const style: StyleReport = {
    dirExists: loaded.dirExists,
    samples: loaded.samples.length,
    rejected: loaded.rejected.map((entry) => ({ name: entry.name, reason: entry.reason })),
  };

  const base = {
    reportVersion: 1,
    templateId: template.id,
    templateName: template.name,
    maxRewrites: MAX_REWRITES,
    narrative,
    style,
  } as const;

  /*
   * 재료가 없으면 **모델을 부르지 않는다.** T-018 Acceptance 1의 "부르고 버리는 것과
   * 부르지 않는 것은 다르다"와 같은 판단이다 — 서사 재료 없이 부르면 모델은 팩트 팩만 보고
   * 인과를 지어내고, 그 날조는 팩트 대조가 잡지 못한다(`factcheck.ts` 서두).
   */
  if (source.records.length === 0) {
    return {
      accepted: false,
      reason: "no-narrative",
      body: null,
      report: {
        ...base,
        attempts: 0,
        rewrites: 0,
        model: null,
        lint: null,
        factCheck: null,
        accepted: false,
        rejection: "no-narrative",
      },
    };
  }

  const system = loadDraftPrompt();
  const userMessage = renderDraftRequest({
    facts: options.facts,
    outline: buildOutline(template, options.facts),
    records: renderNarrativeSource(source),
    styleSamples: renderStyleSamples(loaded.samples),
  });

  const first = await complete(options.model, system, [{ role: "user", content: userMessage }], config);
  let body = first.text;
  let lint = lintDraft(body);
  let attempts = 1;
  let rewrites = 0;

  /*
   * 재작성. 직전 초안을 대화에 되싣고 **무엇을 어겼는지** 알려 다시 쓰게 한다.
   * 같은 프롬프트로 한 번 더 부르는 것은 재작성이 아니라 재추첨이다(T-020의 그 문장).
   * 지시문에는 레코드 산문이 다시 들어가지 않는다 — 바로 위 턴에 그대로 있다.
   */
  while (!lint.passed && rewrites < MAX_REWRITES) {
    rewrites += 1;
    const retry = await complete(
      options.model,
      system,
      [
        { role: "user", content: userMessage },
        { role: "assistant", content: body },
        { role: "user", content: rewriteInstruction(lint) },
      ],
      config,
    );
    attempts += 1;
    body = retry.text;
    lint = lintDraft(body);
  }

  const withModel = { ...base, attempts, rewrites, model: first.model, lint } as const;

  if (!lint.passed) {
    return {
      accepted: false,
      reason: "lint",
      body,
      report: { ...withModel, factCheck: null, accepted: false, rejection: "lint" },
    };
  }

  // §4의 마지막 게이트. 여기서 걸리면 재작성하지 않고 반려한다(파일 서두 참조).
  const factCheck = crossCheckFacts(body, options.facts);
  if (!factCheck.passed) {
    return {
      accepted: false,
      reason: "fact-check",
      body,
      report: { ...withModel, factCheck, accepted: false, rejection: "fact-check" },
    };
  }

  const report: DraftReport = {
    ...withModel,
    factCheck,
    accepted: true,
    rejection: null,
  };

  return {
    accepted: true,
    report,
    patch: {
      status: "draft",
      body,
      charts: options.charts ?? [],
      lintReport: report,
    },
  };
}

/** 모델 1회 호출 + 빈 응답 거부. `generator/generate.ts`의 `complete`와 같은 규약이다. */
async function complete(
  model: ChatModel,
  system: string,
  messages: ChatMessage[],
  config: PublisherConfig,
): Promise<{ text: string; model: string }> {
  const response = await model.complete({ system, messages, maxTokens: config.draftMaxTokens });
  const text = response.text.trim();
  if (text.length === 0) {
    throw new LlmError(
      LLM_ERROR_CODES.RESPONSE_EMPTY,
      "모델이 빈 초안을 돌려줬다 — 빈 본문은 아티클이 아니다.",
    );
  }
  return { text, model: response.model };
}

interface DraftRequestParts {
  readonly facts: ArticleFacts;
  readonly outline: string;
  readonly records: string;
  readonly styleSamples: string;
}

/**
 * 초안 요청 1건. 블록마다 태그를 붙이는 것은 장식이 아니라 **데이터 프레이밍**이다(NFR-05):
 * 시스템 프롬프트 조항 2가 `<record>`·`<style-sample>`을 이름으로 지목할 수 있어야 한다.
 */
export function renderDraftRequest(parts: DraftRequestParts): string {
  const blocks = [
    `<facts>\n${renderFactsBlock(parts.facts)}\n</facts>`,
    `<outline>\n${parts.outline}\n</outline>`,
    `<records>\n${parts.records}\n</records>`,
  ];
  if (parts.styleSamples.length > 0) {
    blocks.push(`<style-samples>\n${parts.styleSamples}\n</style-samples>`);
  }
  blocks.push("위 재료로 아티클 본문을 써라. Markdown 본문만 출력한다.");
  return blocks.join("\n\n");
}

/**
 * 팩트 팩을 프롬프트용 텍스트로 편다. **결정론이다** — 배열 순서가 이미 전순서로 정렬돼
 * 있으므로(T-030 `order.ts`) 같은 팩트 팩이면 같은 문자열이 나온다.
 * JSON을 그대로 싣지 않는 이유는 토큰이다: 중괄호와 키 반복이 팩트보다 길어진다.
 */
export function renderFactsBlock(facts: ArticleFacts): string {
  const lines: string[] = [
    `records=${String(facts.counts.records)} incidents=${String(facts.counts.incidents)} divergences=${String(facts.counts.divergences)}`,
    `period=${facts.period.firstAt.slice(0, 10)}..${facts.period.lastAt.slice(0, 10)} spanDays=${String(facts.period.spanDays)}`,
    `tags=${facts.distributions.tags.map((entry) => `${entry.key}:${String(entry.count)}`).join(" ")}`,
    `severity=${facts.distributions.severity.map((entry) => `${entry.key}:${String(entry.count)}`).join(" ")}`,
    `project=${facts.distributions.project.map((entry) => `${entry.key}:${String(entry.count)}`).join(" ")}`,
    `commonTags=${facts.commonTags.join(" ")}`,
    `recurrence occurrences=${String(facts.recurrence.occurrences)} spanDays=${String(facts.recurrence.spanDays)} intervalsDays=${facts.recurrence.intervalsDays.join(",")}`,
  ];

  lines.push("timeline:");
  for (const entry of facts.timeline) {
    lines.push(`  ${entry.at.slice(0, 10)} ${entry.recordId} ${entry.event} ${entry.type} ${entry.severity}`);
  }

  if (facts.divergence !== undefined) {
    lines.push(`divergence count=${String(facts.divergence.count)}`);
    lines.push(`  byModel=${facts.divergence.byModel.map((entry) => `${entry.key}:${String(entry.count)}`).join(" ")}`);
    lines.push(`  byTool=${facts.divergence.byTool.map((entry) => `${entry.key}:${String(entry.count)}`).join(" ")}`);
    lines.push(
      `  corrections=${facts.divergence.correctionCategories.map((entry) => `${entry.key}:${String(entry.count)}`).join(" ")}`,
    );
  }

  lines.push("citations (원문 그대로 인용해도 되는 것):");
  for (const evidence of facts.citations) {
    lines.push(`  [${evidence.kind}] ${evidence.text}`);
  }
  lines.push("signals (밀도 근거):");
  for (const evidence of facts.signals) {
    lines.push(`  [${evidence.kind}] ${evidence.text}`);
  }

  return lines.join("\n");
}

/**
 * 재작성 지시문. **결정론이다** — 같은 위반이면 같은 문장이 나가야 eval이 재현된다.
 * 위반 규칙과 사유만 싣고 본문 원문은 싣지 않는다(바로 위 턴에 있다).
 */
export function rewriteInstruction(lint: LintReport): string {
  return [
    "직전 초안이 문체 규칙(시스템 프롬프트 5항, specs/08 §4)을 어겼다. 아래를 고쳐서 다시 써라.",
    ...lint.violations.map((violation) => `- [${violation.rule}] ${violation.detail}`),
    "고치면서 수치·날짜·인용을 새로 만들지 마라 — 팩트 팩에 있는 것만 쓴다.",
    "분량을 줄여 규칙을 피하지 마라. 팩트를 더 넣어서 통과시켜라.",
  ].join("\n");
}
