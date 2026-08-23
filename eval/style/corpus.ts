/**
 * 블라인드 판정에 들어가는 세 종류의 글. 출처: specs/08-publishing.md §6, T-034 Scope.
 *
 * ```
 * generated  파이프라인(T-031 draftArticle)이 이번 실행에서 쓴 아티클
 * human      사람이 쓴 글 — §6이 "3편"을 요구한다. 지어내지 않는다.
 * control    의도적으로 상투 표현을 넣은 대조군(양성 대조). T-034 Acceptance 2.
 * ```
 *
 * ## 대조군은 "정답"이 아니라 **계기 교정용 양성 대조**다
 *
 * §6의 지표는 판별 정확도이고 **낮을수록 좋다**. 그런데 낮은 정확도에는 두 원인이 있다:
 * (a) 아티클이 실제로 사람 글과 구별되지 않는다, (b) **judge가 애초에 판별을 못 한다.**
 * 둘을 가르지 않으면 "판별 못 하는 judge를 붙이는 것"이 이 eval을 통과시키는 가장 싼 방법이
 * 된다. 대조군은 그 구멍을 막는다 — **누가 봐도 AI가 쓴 글**을 섞어 두고, judge가 그것마저
 * 놓치면 그 실행의 수치는 통과가 아니라 **판정 불가**다(`guard.ts`).
 *
 * ## 대조군을 린터 규칙에서 만들지 않았다
 *
 * `packages/core/src/publisher/lint.ts`의 `BANNED_PHRASES`를 import해서 조립하면
 * 이 eval은 "린터가 잡는 것을 judge도 잡는가"를 재게 되고, T-031이 F-2에서 지적한
 * 굿하트 표면을 **그대로 되풀이한다**. 그래서 대조군은 §0의 정의 — "AI 냄새의 공통점은
 * 문체가 아니라 **내용 없음**" — 에서 직접 썼다. 각 항목의 1차 신호는 금지어가 아니라
 * **구체가 하나도 없다는 사실**이다. 규칙 목록과 겹치는 표현이 섞이는 것은 결과이지 재료가 아니다.
 * (`judge-independence.spec.ts`가 judge 프롬프트 쪽의 독립성을 기계로 잠근다.)
 */
import { readFile, readdir } from "node:fs/promises";
import { join } from "node:path";

import { CreateRecordInput, RecordSchema } from "@sentinel/contracts";

/** 글 한 편의 출처. **judge에게는 절대 넘어가지 않는다**(`blind.ts`). */
export const STYLE_ORIGINS = ["generated", "human", "control"] as const;
export type StyleOrigin = (typeof STYLE_ORIGINS)[number];

/**
 * 판정 대상 한 편. `sourceRef`는 **재현 좌표**다 — 리포트에 본문 대신 이것이 실린다
 * (T-021 report.ts가 페이로드 대신 `caseId`+`axis`를 실은 것과 같은 규약).
 */
export interface StylePiece {
  readonly origin: StyleOrigin;
  /** 레포 안에서 이 글을 다시 찾을 수 있는 좌표(파일 경로 또는 코퍼스 상수 이름). */
  readonly sourceRef: string;
  readonly text: string;
}

// ------------------------------------------------------------------ 사람 글

/**
 * §6: "사람이 쓴 글 3편". **여기 적힌 것만 사람 글로 센다.**
 *
 * 지금 이 레포에 실재하는 사람 글은 **한 편뿐이다**. 나머지 둘을 채우려고 글을 지어내면
 * 그 순간 이 eval은 "AI가 쓴 사람 글 흉내"와 "AI가 쓴 아티클"을 비교하게 되고,
 * 판별 정확도가 낮게 나오는 것이 **당연해진다** — 지표가 아니라 자기 확인이 된다.
 * 그래서 부족분은 채우지 않고 **판정 불가로 남긴다**(`guard.ts`, README).
 */
export interface HumanSource {
  /** 레포 루트 기준 경로. */
  readonly path: string;
  /** 왜 이것이 사람 글인가. 근거 없이 목록에 올리지 않는다. */
  readonly provenance: string;
}

export const HUMAN_SOURCES: readonly HumanSource[] = [
  {
    path: "docs/analysis/T-004-POSTMORTEM.md",
    provenance:
      "T-031이 `prompts/style/01-t004-postmortem.md`에 발췌하며 '이 레포에서 사람이 실제로 쓴 글'로 " +
      "명시한 문서다(specs/08 §0-4의 스타일 표본 원본).",
  },
];

/** §6 "사람이 쓴 글 3편". 스펙 문면이지 튜닝 값이 아니다. */
export const REQUIRED_HUMAN_PIECES = 3;

/**
 * 사람 글 상한. judge 한 번에 보내는 양을 문서 전체로 두면 원고 길이 자체가 신호가 된다
 * (사람 글만 5만 자, 아티클은 3천 자면 judge는 문체가 아니라 **길이**를 재게 된다).
 * 그래서 모든 글을 같은 상한으로 자른다 — `blind.ts`가 아니라 로더에서 자르는 이유는
 * 자르기가 코퍼스의 성질이지 블라인딩의 성질이 아니기 때문이다.
 */
export const PIECE_MAX_CHARS = 4000;

export interface HumanCorpus {
  readonly pieces: readonly StylePiece[];
  /** 목록에 있으나 파일이 없거나 비어 있는 것. 조용히 빠지지 않는다. */
  readonly missing: readonly { readonly path: string; readonly reason: string }[];
}

export async function loadHumanCorpus(
  rootDir: string,
  sources: readonly HumanSource[] = HUMAN_SOURCES,
): Promise<HumanCorpus> {
  const pieces: StylePiece[] = [];
  const missing: { path: string; reason: string }[] = [];

  for (const source of sources) {
    let raw: string;
    try {
      raw = await readFile(join(rootDir, source.path), "utf8");
    } catch (error) {
      missing.push({ path: source.path, reason: message(error) });
      continue;
    }
    const text = clip(raw);
    if (text.trim().length === 0) {
      missing.push({ path: source.path, reason: "빈 파일" });
      continue;
    }
    pieces.push({ origin: "human", sourceRef: source.path, text });
  }

  return { pieces, missing };
}

/** 앞부분을 자른다. 문서 첫머리가 그 사람의 문체를 가장 진하게 담는다. */
export function clip(text: string, maxChars: number = PIECE_MAX_CHARS): string {
  return text.length <= maxChars ? text : text.slice(0, maxChars);
}

/**
 * **오염 검사: 사람 글이 초안의 문체 few-shot으로도 쓰였는가.**
 *
 * §0-4는 작성자의 글 2~3편을 초안 프롬프트에 넣으라고 하고, §6은 사람 글 3편과 섞어
 * 블라인드 판정을 하라고 한다. **같은 글이 양쪽에 쓰이면** 아티클은 바로 그 글을 흉내 내어
 * 쓰였고 judge는 그 글과 아티클을 비교하게 된다 — 판별 정확도가 낮게 나오는 것이
 * 문체 이식의 성과인지 표본 재사용의 산물인지 갈 수 없다.
 *
 * 지금 이 레포가 정확히 그 상태다: `prompts/style/01-t004-postmortem.md`는
 * `docs/analysis/T-004-POSTMORTEM.md`의 발췌다. 그래서 **경고로 남긴다** —
 * 게이트로 올릴지는 사람 글 3편이 실제로 갖춰진 뒤에 판단할 일이다(태스크 Findings).
 */
export function detectStyleSampleOverlap(
  humanPieces: readonly StylePiece[],
  sampleTexts: readonly string[],
  probeChars = 120,
): string[] {
  const overlapped: string[] = [];
  for (const piece of humanPieces) {
    const haystack = normalize(piece.text);
    // 표본은 머리말이 붙은 **발췌**인 경우가 많다(prompts/style/01-t004-postmortem.md).
    // 앞머리만 보면 그 머리말 때문에 언제나 빗나가므로 여러 지점을 훑는다.
    const hit = sampleTexts.some((sample) =>
      probes(normalize(sample), probeChars).some((probe) => haystack.includes(probe)),
    );
    if (hit) overlapped.push(piece.sourceRef);
  }
  return overlapped;
}

function probes(text: string, probeChars: number): string[] {
  const out: string[] = [];
  for (let start = 0; start + probeChars <= text.length; start += probeChars) {
    out.push(text.slice(start, start + probeChars));
  }
  return out;
}

/** 공백 차이로 비교가 빗나가지 않게 한다. 발췌는 줄바꿈이 바뀐 채로 복사되는 일이 흔하다. */
function normalize(text: string): string {
  return text.replace(/\s+/gu, " ").trim();
}

// ------------------------------------------------------------------ 대조군

export interface ControlPiece {
  readonly id: string;
  /** 이 항목이 겨냥하는 "AI 티"의 축. 리포트에 실려 실패 진단의 좌표가 된다. */
  readonly axis: string;
  readonly text: string;
}

/**
 * 대조군. **전부 내용이 없다** — 수치·에러 원문·날짜·명령어가 없거나, 있어도 아무 사건도
 * 가리키지 않는다. §0의 정의를 그대로 실물로 만든 것이다.
 */
export const CONTROL_PIECES: readonly ControlPiece[] = [
  {
    id: "CTL-01",
    axis: "meta-opening + 일반론 대칭",
    text: `이 글에서는 개발 과정에서 마주치는 다양한 문제와 그 해결 방안에 대해 다루어 보겠습니다.

소프트웨어 개발에서 문제 해결은 매우 중요한 과정입니다. 문제를 정확히 파악하고, 원인을 분석하고, 적절한 해결책을 적용하는 것이 중요합니다. 이러한 과정을 체계적으로 수행하면 더 나은 결과를 얻을 수 있습니다.

먼저 문제를 파악하는 단계가 있습니다. 이 단계에서는 현상을 관찰하고, 재현 조건을 확인하고, 영향 범위를 파악합니다. 정확한 파악이 이루어져야 다음 단계로 넘어갈 수 있습니다.

다음으로 원인을 분석하는 단계입니다. 로그를 확인하고, 코드를 검토하고, 환경을 점검합니다. 이 과정에서 근본 원인에 접근하게 됩니다.

마지막으로 해결책을 적용하는 단계입니다. 수정을 반영하고, 테스트를 수행하고, 결과를 검증합니다. 결론적으로 체계적인 접근이 문제 해결의 핵심이라고 할 수 있습니다.`,
  },
  {
    id: "CTL-02",
    axis: "과장 수식 + 이모지 + 성과 서사",
    text: `우리 팀은 최근 굉장히 놀라운 성과를 거두었습니다. 🎉

이번에 도입한 새로운 아키텍처는 정말 혁신적인 접근이었습니다. 기존 방식의 한계를 뛰어넘는 압도적인 개선을 이루어냈으며, 팀 전체의 생산성이 크게 향상되었습니다.

주목할 만한 점은 이 변화가 단순한 기술적 개선에 그치지 않았다는 것입니다. 개발 문화 자체가 바뀌었고, 협업 방식이 개선되었고, 코드 품질이 향상되었습니다. 이것은 진정한 게임체인저였습니다. ✨

앞으로도 지속적인 개선을 통해 더 나은 결과를 만들어 나가는 것이 중요합니다. 여러분의 프로젝트에도 이러한 접근을 적용해 보시기 바랍니다. 🚀`,
  },
  {
    id: "CTL-03",
    axis: "소제목마다 불릿 + 동일 어미 반복",
    text: `## 배경

- 시스템이 점점 복잡해지고 있습니다
- 유지보수 비용이 증가하고 있습니다
- 개선이 필요한 시점입니다

## 접근

- 먼저 현황을 분석했습니다
- 그다음 우선순위를 정했습니다
- 마지막으로 실행 계획을 세웠습니다

## 결과

- 성능이 개선되었습니다
- 안정성이 향상되었습니다
- 팀 만족도가 높아졌습니다

이러한 개선을 지속하는 것이 중요합니다.`,
  },
  {
    /**
     * **린터를 통과하도록 쓴 대조군.** T-031 F-2("린터 통과는 품질의 증거가 아니다")를
     * 주장이 아니라 **관측 가능한 항목**으로 바꾼 자리다: 수치·날짜·코드 블록을 밀도 하한
     * 이상으로 깔고 금지 표현을 피하되, 그 숫자들은 **아무 사건도 가리키지 않는다.**
     * 린터가 통과시키고 judge가 AI로 집으면, 두 계기가 서로 다른 것을 재고 있다는 증거다.
     */
    id: "CTL-04",
    axis: "린터 우회 — 형상은 갖췄으나 사건이 없다",
    text: `2026-01-15 배포 이후 시스템 지표를 관찰했다.

\`\`\`
[metrics] p50=95ms p95=210ms p99=480ms error_rate=0.02
\`\`\`

관측된 값은 위와 같다. 응답 시간은 120ms에서 95ms로 바뀌었다. 개선 폭은 20% 수준이며 안정적인 범위 안에 있다고 판단된다. 2026-01-20 시점의 재측정에서도 유사한 경향이 유지되었다.

운영 관점에서 이 수치는 긍정적으로 해석할 여지가 있다. \`monitoring.enabled\` 설정은 기본값을 그대로 두었다.

다만 부하 조건이 달라지면 결과 또한 달라질 수 있으므로 지속적인 관찰이 필요한 영역으로 남는다. 향후 과제로는 지표 수집 범위의 확대와 알림 임계값의 재조정을 검토할 수 있다. 3개 분기에 걸친 추세를 확보하면 더 신뢰할 만한 판단이 가능해질 것으로 보인다.`,
  },
];

export function controlPieces(entries: readonly ControlPiece[] = CONTROL_PIECES): StylePiece[] {
  return entries.map((entry) => ({
    origin: "control",
    sourceRef: `eval/style/corpus.ts:${entry.id}`,
    text: entry.text,
  }));
}

// ------------------------------------------------------------------ 생성 소스 레코드

/**
 * 아티클을 만들 재료. **`packages/core/seed/incidents/`를 실행 시점에 읽는다** —
 * 사본을 이 파일에 박지 않는 이유는 T-016이 도구 카탈로그를 스냅샷하지 않은 이유와 같다:
 * 사본은 원본이 바뀌어도 조용히 낡고, 그러면 eval이 재는 것은 현재의 파이프라인이 아니라
 * 과거의 사본이 된다.
 *
 * ## 시드에 없는 것을 러너가 채운다 — 그리고 그 사실을 숨기지 않는다
 *
 * 시드 JSON은 `CreateRecordInput`이라 `_id`·`createdAt`·`project`·`summary`가 없다.
 * 팩트 팩의 기간·타임라인은 그 타임스탬프에서 나오므로 러너가 **고정 간격으로 정한다.**
 * 즉 발행물의 날짜는 실제 사건 시각이 아니다. 이 eval이 재는 것은 **문체**이고 날짜의
 * 사실성이 아니므로 정당하지만, 이 리포트의 아티클을 "실제 사건 기록"으로 읽으면 안 된다.
 */
export const ARTICLE_SOURCE_DIR = "packages/core/seed/incidents";
/** 패턴 아티클(§1 B)의 하한이 3건이다. 넉넉히 4건을 쓴다. */
export const ARTICLE_SOURCE_COUNT = 4;
export const ARTICLE_SOURCE_BASE_AT = "2026-03-02T09:00:00.000Z";
export const ARTICLE_SOURCE_INTERVAL_DAYS = 7;
const DAY_MS = 86_400_000;
/** `summary`는 서버가 만드는 필드다(contracts). 여기서는 증상 앞부분을 쓴다. */
const SUMMARY_MAX_CHARS = 200;

export async function loadArticleSources(
  rootDir: string,
  count: number = ARTICLE_SOURCE_COUNT,
): Promise<RecordSchema[]> {
  const dir = join(rootDir, ARTICLE_SOURCE_DIR);
  const files = (await readdir(dir)).filter((name) => name.endsWith(".json")).sort();
  const chosen = files.slice(0, count);

  const records: RecordSchema[] = [];
  for (const [index, file] of chosen.entries()) {
    // BOM은 JSON 규격이 허용하지 않는데 편집기가 붙일 수 있다(`scripts/seed.ts`와 같은 처리).
    const raw: unknown = JSON.parse((await readFile(join(dir, file), "utf8")).replace(/^\uFEFF/u, ""));
    const input = CreateRecordInput.parse(raw);
    if (input.type !== "incident") continue;
    const at = new Date(Date.parse(ARTICLE_SOURCE_BASE_AT) + index * ARTICLE_SOURCE_INTERVAL_DAYS * DAY_MS);
    records.push(
      RecordSchema.parse({
        ...input,
        _id: sourceObjectId(index),
        project: "sentinel-kb",
        summary: input.symptom.slice(0, SUMMARY_MAX_CHARS),
        sanitizeFlags: [],
        relations: [],
        embeddingVersion: 1,
        createdAt: at,
        updatedAt: at,
      }),
    );
  }
  return records;
}

/** 결정론적 24-hex. 같은 순서면 같은 id — 리포트 diff가 실행마다 흔들리지 않는다. */
export function sourceObjectId(index: number): string {
  return `e0a1${"0".repeat(16)}${String(index + 1).padStart(4, "0")}`;
}

function message(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
