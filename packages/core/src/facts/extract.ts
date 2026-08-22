/**
 * 팩트 추출기 — specs/08-publishing.md §3·§5.1. **LLM 미사용, 순수 함수.**
 *
 * ## 왜 결정론이 이 태스크의 이름인가
 *
 * T-029는 아티클의 멱등성을 **소스 집합 해시**에 걸었다(`articleId`). 같은 레코드 집합이면
 * 같은 `_id`이고, 그래서 야간 배치를 몇 번 돌려도 후보가 쌓이지 않는다. 그 위에서 팩트가
 * 실행마다 달라지면 멱등성이 껍데기만 남는다 — `_id`는 같은데 내용이 다른 아티클이 생기고,
 * "이미 있으니 건너뛴다"는 판단이 **어느 쪽 내용을 남길지 모르는 판단**이 된다.
 * 그래서 여기에는 `Date.now()`도 `Math.random()`도 없고, 모든 시각은 입력 레코드의
 * 타임스탬프에서만 나오며, 모든 배열은 전순서로 정렬된다(`order.ts`).
 *
 * ## 재료 게이트 — 두 번 거른다
 *
 * 1. **저장된 플래그**로 거른다. `injection-suspect`는 재료가 되지 못한다.
 *    T-029가 트리거 단계에서 이미 그렇게 했고(§7, NFR-05) 여기서도 같은 규약을 지킨다.
 * 2. **지금 다시 판정**한다. 플래그는 레코드를 **저장하던 시점의** 탐지기가 남긴 값이다.
 *    T-040이 탐지 축을 늘렸고 그때 이미 저장돼 있던 레코드는 재판정되지 않았다.
 *    발행은 저장보다 늦으므로, 발행 직전에 현재 탐지기로 한 번 더 보는 것이 옳다.
 *
 * 그래도 남는 축이 있다 — T-040 기준 탐지는 9/10이고 **일본어 축이 미탐**이다.
 * 그 축은 탐지로 닫지 않는다. `types.ts` 서두에 적은 대로 **산문을 팩트로 만들지 않는 것**,
 * 그리고 스니펫에 ASCII 형상을 요구하는 것(`screen.ts`)으로 경로 자체를 없앤다.
 */
import type { ArticleKind, ChartSpec, ChunkSection, RecordSchema } from "@sentinel/contracts";

import { detectInjection } from "../sanitizer/injection.js";

import {
  commonTags,
  divergenceFacts,
  period,
  projectDistribution,
  recurrence,
  severityDistribution,
  tagDistribution,
  timeline,
} from "./aggregate.js";
import { buildCharts } from "./charts.js";
import { extractSnippets, type RawSnippet } from "./evidence.js";
import { compareStrings } from "./order.js";
import {
  CITATION_KINDS,
  EVIDENCE_KINDS,
  type ArticleFacts,
  type EvidenceKind,
  type FactEvidence,
  type FactExclusion,
} from "./types.js";

/** 인용 후보 상한. 본문에 실릴 후보이므로 T-031이 고르기 좋은 크기까지만 낸다. */
export const MAX_CITATIONS = 20;
/** 부가 신호 상한. 밀도 근거로 쓰이며 인용되지 않는다. */
export const MAX_SIGNALS = 30;

export interface ExtractFactsInput {
  /** 어떤 유형의 아티클을 위한 팩트인가. 차트 구성이 여기서 갈린다(§5.1). */
  readonly kind: ArticleKind;
  /** 소스 레코드. 순서는 결과에 영향을 주지 않는다. */
  readonly records: readonly RecordSchema[];
}

export interface FactExtraction {
  readonly facts: ArticleFacts;
  readonly charts: ChartSpec[];
}

export const FACT_ERROR_CODES = {
  /** 소스 레코드가 없다. */
  NO_RECORDS: "no-records",
  /** 전부 게이트에 걸려 재료가 하나도 남지 않았다. */
  NO_MATERIAL: "no-material",
} as const;

export type FactErrorCode = (typeof FACT_ERROR_CODES)[keyof typeof FACT_ERROR_CODES];

/**
 * 팩트를 만들 수 없는 상태.
 *
 * **빈 팩트 팩을 성공으로 돌려주지 않는다.** 빈 객체를 반환하면 호출부는 그것을 정상 산출로
 * 받아 아티클을 만들고, 그 아티클은 §0-2가 금지한 "구체 팩트 없는 글"이 된다.
 * 재료가 없다는 것은 계산 결과가 아니라 **파이프라인을 멈춰야 하는 조건**이다.
 */
export class FactExtractionError extends Error {
  constructor(
    readonly code: FactErrorCode,
    message: string,
  ) {
    super(message);
    this.name = "FactExtractionError";
  }
}

/** 재료 판정 결과. 제외된 레코드는 사유와 함께 남는다 — 조용히 사라지면 안 된다. */
export interface MaterialScreen {
  readonly material: RecordSchema[];
  readonly excluded: FactExclusion[];
}

/**
 * 아티클 재료가 될 자격. worker의 `isArticleMaterial`(T-029)과 같은 규약이며,
 * 여기에 **발행 직전 재판정**이 하나 더 붙는다. (Findings: 두 판정을 한 곳으로 모으는 것은
 * 패키지 경계를 건드리는 변경이라 이 태스크에서 하지 않았다.)
 */
export function screenMaterial(records: readonly RecordSchema[]): MaterialScreen {
  const material: RecordSchema[] = [];
  const excluded: FactExclusion[] = [];

  for (const record of records) {
    if (record.status !== "published") {
      excluded.push({ recordId: record._id, reason: "not-published" });
      continue;
    }
    if (record.sanitizeFlags.includes("injection-suspect")) {
      excluded.push({ recordId: record._id, reason: "injection-suspect" });
      continue;
    }
    if (detectInjection(bodyText(record)).length > 0) {
      excluded.push({ recordId: record._id, reason: "injection-detected" });
      continue;
    }
    material.push(record);
  }

  material.sort((a, b) => compareStrings(a._id, b._id));
  excluded.sort((a, b) => compareStrings(a.recordId, b.recordId));
  return { material, excluded };
}

/**
 * 원문을 인용해도 되는 레코드인가. specs/08 §7: "sanitizeFlags 있는 레코드의 원문 인용 금지".
 *
 * `secret-masked`는 재료로는 쓴다(통계에는 들어간다) — 마스킹이 실제로 일어났다는 것은
 * 그 레코드에 시크릿이 **있었다**는 뜻이고, 라벨 주변 원문을 발행물에 옮길 이유가 없다.
 * 세는 것과 인용하는 것은 위험이 다르므로 문턱도 달라야 한다.
 */
export function isQuotable(record: RecordSchema): boolean {
  return record.sanitizeFlags.length === 0;
}

/** 인용 가능한 본문 섹션. `ChunkSection`과 같은 집합이라 `[REC-{id}#{section}]` 형식으로 그대로 인용된다. */
function sections(record: RecordSchema): { section: ChunkSection; text: string }[] {
  if (record.type === "incident") {
    return [
      { section: "symptom", text: record.symptom },
      ...(record.rootCause === undefined
        ? []
        : [{ section: "rootCause" as ChunkSection, text: record.rootCause }]),
      { section: "resolution", text: record.resolution },
      ...(record.prevention === undefined
        ? []
        : [{ section: "prevention" as ChunkSection, text: record.prevention }]),
    ];
  }
  return [
    { section: "expected", text: record.expected },
    { section: "actual", text: record.actual },
    { section: "correction", text: record.correction },
  ];
}

/** 인젝션 재판정의 대상. 제목·요약까지 포함한다 — 어느 칸에 심겼든 재료 자격을 잃는다. */
function bodyText(record: RecordSchema): string {
  return [record.title, record.summary, ...sections(record).map((part) => part.text)].join("\n");
}

/**
 * 팩트 팩과 차트를 만든다.
 *
 * @throws {FactExtractionError} 소스가 없거나 전부 게이트에 걸렸을 때.
 */
export function extractFacts(input: ExtractFactsInput): FactExtraction {
  if (input.records.length === 0) {
    throw new FactExtractionError(
      FACT_ERROR_CODES.NO_RECORDS,
      "소스 레코드가 없다 — 팩트 없는 아티클은 만들지 않는다 (specs/08 §0-2).",
    );
  }

  const { material, excluded } = screenMaterial(input.records);
  if (material.length === 0) {
    throw new FactExtractionError(
      FACT_ERROR_CODES.NO_MATERIAL,
      `소스 ${String(input.records.length)}건이 전부 재료 게이트에 걸렸다: ` +
        excluded.map((entry) => `${entry.recordId}=${entry.reason}`).join(", "),
    );
  }

  const snippets = material
    .filter(isQuotable)
    .flatMap((record) =>
      sections(record).flatMap((part) =>
        extractSnippets(record._id, part.section, part.text),
      ),
    );

  const evidence = groupEvidence(snippets);
  const citations = evidence
    .filter((item) => CITATION_KINDS.includes(item.kind))
    .slice(0, MAX_CITATIONS);
  const signals = evidence
    .filter((item) => !CITATION_KINDS.includes(item.kind))
    .slice(0, MAX_SIGNALS);

  const recordsWithEvidence = new Set(snippets.map((snippet) => snippet.recordId));
  const entries = timeline(material);
  const divergence = divergenceFacts(material);

  const facts: ArticleFacts = {
    factsVersion: 1,
    sourceRecordIds: material.map((record) => record._id),
    counts: {
      records: material.length,
      incidents: material.filter((record) => record.type === "incident").length,
      divergences: material.filter((record) => record.type === "divergence").length,
    },
    period: period(material),
    distributions: {
      tags: tagDistribution(material),
      severity: severityDistribution(material),
      project: projectDistribution(material),
    },
    commonTags: commonTags(material),
    timeline: entries,
    recurrence: recurrence(material),
    ...(divergence === undefined ? {} : { divergence }),
    citations,
    signals,
    density: {
      records: material.length,
      citations: citations.length,
      signals: signals.length,
      timelineEntries: entries.length,
      recordsWithoutEvidence: material.filter((record) => !recordsWithEvidence.has(record._id))
        .length,
    },
    excluded,
  };

  return { facts, charts: buildCharts(input.kind, facts) };
}

/**
 * 같은 텍스트의 스니펫을 하나로 묶고 출처를 모은다.
 *
 * 세 레코드에 같은 에러 원문이 등장하면 그것은 세 개의 팩트가 아니라 **빈도 3의 팩트 하나**다
 * (specs/08 §3의 "여러 레코드에 걸친 교집합"이 여기서 나온다). 묶으면서 `recordIds`를
 * 전부 보존하므로 인용 시 세 레코드를 모두 근거로 댈 수 있다 — 출처를 하나로 줄이면
 * 나머지 둘은 발행물에서 영영 되짚을 수 없게 된다.
 */
function groupEvidence(snippets: readonly RawSnippet[]): FactEvidence[] {
  interface Bucket {
    readonly kind: EvidenceKind;
    readonly text: string;
    readonly recordIds: Set<string>;
    readonly sections: Set<ChunkSection>;
  }

  const grouped = new Map<string, Bucket>();
  for (const snippet of snippets) {
    // 구분자는 NUL이다. 스니펫 본문에는 공백이 들어 있으므로 공백으로 이으면 서로 다른
    // (종류, 텍스트) 쌍이 같은 키가 될 수 있다 — T-029 `articleId`가 같은 이유로 NUL을 쓴다.
    // 키를 되파싱하지 않고 종류·텍스트를 버킷에 그대로 들고 있는 것도 같은 이유다.
    const key = `${snippet.kind}\u0000${snippet.text}`;
    const bucket = grouped.get(key) ?? {
      kind: snippet.kind,
      text: snippet.text,
      recordIds: new Set<string>(),
      sections: new Set<ChunkSection>(),
    };
    bucket.recordIds.add(snippet.recordId);
    bucket.sections.add(snippet.section);
    grouped.set(key, bucket);
  }

  const evidence: FactEvidence[] = [];
  for (const bucket of grouped.values()) {
    const recordIds = [...bucket.recordIds].sort(compareStrings);
    evidence.push({
      kind: bucket.kind,
      text: bucket.text,
      recordIds,
      sections: [...bucket.sections].sort(compareStrings),
      recordCount: recordIds.length,
    });
  }

  return evidence.sort(
    (a, b) =>
      b.recordCount - a.recordCount ||
      EVIDENCE_KINDS.indexOf(a.kind) - EVIDENCE_KINDS.indexOf(b.kind) ||
      compareStrings(a.text, b.text),
  );
}
