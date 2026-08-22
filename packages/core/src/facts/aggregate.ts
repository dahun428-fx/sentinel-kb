/**
 * 집계 — specs/08-publishing.md §3의 앞 네 항목.
 * "기간·건수·태그 분포, 심각도 분포, 프로젝트 분포 / 타임라인 / 반복 지표 / divergence 집계".
 *
 * 전부 구조화된 필드값 위의 산술이다. 본문 산문은 이 파일에서 단 한 번,
 * `classifyCorrection`에서만 읽는데 거기서도 **경로 토큰의 존재 여부**만 본다.
 */
import type { DivergenceRecord, RecordSchema, RelationType, Severity } from "@sentinel/contracts";

import { compareByCountThenKey, compareStrings, round } from "./order.js";
import { isPublishableLabel, isPublishableSnippet } from "./screen.js";
import {
  CORRECTION_CATEGORIES,
  type CorrectionCategory,
  type FactCell,
  type FactCorrection,
  type FactCount,
  type FactDivergence,
  type FactPeriod,
  type FactRecurrence,
  type FactRecurrenceLink,
  type FactTimelineEntry,
} from "./types.js";

const MS_PER_DAY = 86_400_000;

/** specs/02가 정한 심각도 순서. 빈도순이 아니라 **의미 순서**로 낸다. */
const SEVERITY_ORDER: readonly Severity[] = ["SEV1", "SEV2", "SEV3", "NOTE"];

/** 분포 배열의 상한. 아티클 하나의 소스 집합에서 이보다 많은 키가 나오면 그건 분포가 아니다. */
const MAX_DISTRIBUTION_KEYS = 50;

function tally(keys: Iterable<string>): FactCount[] {
  const counts = new Map<string, number>();
  for (const key of keys) {
    if (!isPublishableLabel(key)) continue;
    const trimmed = key.trim();
    counts.set(trimmed, (counts.get(trimmed) ?? 0) + 1);
  }
  return [...counts]
    .map(([key, count]) => ({ key, count }))
    .sort(compareByCountThenKey)
    .slice(0, MAX_DISTRIBUTION_KEYS);
}

/** 한 레코드가 같은 태그를 두 번 달아도 분포를 부풀리지 못하게 한다(T-029와 같은 규약). */
function distinctTags(record: RecordSchema): string[] {
  return [...new Set(record.tags)];
}

export function tagDistribution(records: readonly RecordSchema[]): FactCount[] {
  return tally(records.flatMap(distinctTags));
}

export function projectDistribution(records: readonly RecordSchema[]): FactCount[] {
  return tally(records.map((record) => record.project));
}

/** 네 등급을 **전부** 낸다. "SEV3 0건"도 팩트다 — 없는 칸을 지우면 분포가 아니라 목록이 된다. */
export function severityDistribution(records: readonly RecordSchema[]): FactCount[] {
  return SEVERITY_ORDER.map((severity) => ({
    key: severity,
    count: records.filter((record) => record.severity === severity).length,
  }));
}

/** 소스 레코드 전부에 붙은 태그. 교집합이므로 레코드가 1건이면 그 레코드의 태그 전부다. */
export function commonTags(records: readonly RecordSchema[]): string[] {
  if (records.length === 0) return [];
  const [first, ...rest] = records;
  if (first === undefined) return [];
  const shared = new Set(distinctTags(first).filter(isPublishableLabel));
  for (const record of rest) {
    const tags = new Set(distinctTags(record));
    for (const tag of [...shared]) {
      if (!tags.has(tag)) shared.delete(tag);
    }
  }
  return [...shared].sort(compareStrings);
}

export function period(records: readonly RecordSchema[]): FactPeriod {
  const times = records.map((record) => record.createdAt.getTime()).sort((a, b) => a - b);
  const first = times[0] ?? 0;
  const last = times[times.length - 1] ?? first;
  return {
    firstAt: new Date(first).toISOString(),
    lastAt: new Date(last).toISOString(),
    spanDays: round((last - first) / MS_PER_DAY, 2),
  };
}

/**
 * specs/08 §3: "레코드 createdAt + incident timeline 필드 병합".
 *
 * **`incident timeline` 필드는 specs/02에 없다.** records 스키마에 있는 시각은
 * `createdAt`·`updatedAt` 둘뿐이므로 병합 대상도 그 둘이다. 없는 필드를 있는 척
 * 자리를 만들어 두면 T-031이 그 자리가 늘 비어 있는 이유를 다시 알아내야 한다. (Findings)
 */
export function timeline(records: readonly RecordSchema[]): FactTimelineEntry[] {
  const entries: FactTimelineEntry[] = [];
  for (const record of records) {
    entries.push({
      at: record.createdAt.toISOString(),
      recordId: record._id,
      event: "created",
      type: record.type,
      severity: record.severity,
    });
    if (record.updatedAt.getTime() !== record.createdAt.getTime()) {
      entries.push({
        at: record.updatedAt.toISOString(),
        recordId: record._id,
        event: "updated",
        type: record.type,
        severity: record.severity,
      });
    }
  }
  return entries.sort(
    (a, b) =>
      compareStrings(a.at, b.at) ||
      compareStrings(a.recordId, b.recordId) ||
      compareStrings(a.event, b.event),
  );
}

/** 기록자가 직접 연결한 관계만 본다. ADR-07 단계 0 — 관계 추론은 금지다. */
function isRecurrenceRelation(
  type: RelationType,
): type is "recurrence_of" | "same_root_cause" {
  return type === "recurrence_of" || type === "same_root_cause";
}

export function recurrence(records: readonly RecordSchema[]): FactRecurrence {
  const times = records.map((record) => record.createdAt.getTime()).sort((a, b) => a - b);
  const intervals: number[] = [];
  for (let index = 1; index < times.length; index += 1) {
    const previous = times[index - 1];
    const current = times[index];
    if (previous === undefined || current === undefined) continue;
    intervals.push(round((current - previous) / MS_PER_DAY, 2));
  }

  const sourceIds = new Set(records.map((record) => record._id));
  const links: FactRecurrenceLink[] = [];
  for (const record of records) {
    for (const relation of record.relations) {
      if (!isRecurrenceRelation(relation.type)) continue;
      links.push({
        recordId: record._id,
        type: relation.type,
        targetRecordId: relation.targetRecordId,
        withinSourceSet: sourceIds.has(relation.targetRecordId),
      });
    }
  }
  links.sort(
    (a, b) =>
      compareStrings(a.recordId, b.recordId) ||
      compareStrings(a.type, b.type) ||
      compareStrings(a.targetRecordId, b.targetRecordId),
  );

  const first = times[0] ?? 0;
  const last = times[times.length - 1] ?? first;
  const sum = intervals.reduce((total, value) => total + value, 0);

  return {
    occurrences: records.length,
    spanDays: round((last - first) / MS_PER_DAY, 2),
    intervalsDays: intervals,
    meanIntervalDays: intervals.length === 0 ? null : round(sum / intervals.length, 2),
    maxIntervalDays: intervals.length === 0 ? null : Math.max(...intervals),
    minIntervalDays: intervals.length === 0 ? null : Math.min(...intervals),
    links,
  };
}

// ---------------------------------------------------------------- divergence

/**
 * `correction`이 무엇을 고쳤는가 — **본문에 실재하는 경로 토큰만** 근거로 삼는다.
 *
 * §3은 "correction 유형 분류"를 요구하지만 유형 목록을 정의하지 않는다. 의미로 분류하려면
 * 산문을 읽어야 하고 그건 LLM이거나 키워드 사전인데, 키워드 사전은 언어·표현마다 갈라지고
 * 개정할 때마다 같은 레코드가 다른 분류를 받는다 — 결정론의 반대다.
 * 그래서 **"고쳐진 대상이 본문에 파일 경로로 남아 있는가"**만 본다. 근거가 없으면
 * `unclassified`다. 분류되지 않은 것이 많다는 사실 자체가 T-031에 유용한 신호다.
 *
 * 우선순위는 `CORRECTION_CATEGORIES` 순서이며 한 레코드는 정확히 한 칸에 들어간다
 * (합 = divergence 건수). 스펙 문서를 고친 것이 테스트 파일을 함께 건드린 것보다
 * 상위 사실이라고 보기 때문이다 — 스펙이 소스 오브 트루스라는 이 레포의 원칙 1과 같은 순서다.
 */
const CATEGORY_MARKERS: readonly { category: CorrectionCategory; pattern: RegExp }[] = [
  { category: "spec", pattern: /(?<![A-Za-z0-9._/-])specs?\/[A-Za-z0-9._/-]+/ },
  {
    category: "test",
    pattern: /(?<![A-Za-z0-9._/-])[A-Za-z0-9._/-]*\.(?:spec|test)\.[a-z]{1,4}\b|__tests__\//,
  },
  {
    category: "config",
    pattern:
      /(?<![A-Za-z0-9._/-])[A-Za-z0-9._/-]+\.(?:json|ya?ml|toml|ini|conf|lock|env)\b|(?<![A-Za-z0-9._/-])\.env\b/,
  },
  {
    category: "code",
    pattern: /(?<![A-Za-z0-9._/-])[A-Za-z0-9._/-]+\.(?:ts|tsx|js|mjs|cjs|py|go|rs|java|sh)\b/,
  },
];

export function classifyCorrection(recordId: string, correction: string): FactCorrection {
  for (const { category, pattern } of CATEGORY_MARKERS) {
    const match = pattern.exec(correction);
    const marker = match?.[0];
    if (marker === undefined) continue;
    // 근거 토큰 자체도 발행물에 실린다 — 스크린을 통과하지 못하면 근거로 쓰지 않는다.
    if (!isPublishableSnippet(marker)) continue;
    return { recordId, category, marker };
  }
  return { recordId, category: "unclassified" };
}

export function divergenceFacts(records: readonly RecordSchema[]): FactDivergence | undefined {
  const divergences = records.filter(
    (record): record is DivergenceRecord => record.type === "divergence",
  );
  if (divergences.length === 0) return undefined;

  const corrections = divergences
    .map((record) => classifyCorrection(record._id, record.correction))
    .sort((a, b) => compareStrings(a.recordId, b.recordId));

  const categoryByRecord = new Map(corrections.map((entry) => [entry.recordId, entry.category]));

  const cells = new Map<string, FactCell>();
  for (const record of divergences) {
    const model = record.context.model?.trim();
    if (model === undefined || !isPublishableLabel(model)) continue;
    const category = categoryByRecord.get(record._id) ?? "unclassified";
    const key = `${model}\u0000${category}`;
    const existing = cells.get(key);
    cells.set(key, {
      row: model,
      column: category,
      count: (existing?.count ?? 0) + 1,
    });
  }

  return {
    count: divergences.length,
    byModel: tally(divergences.flatMap((record) => optionalKey(record.context.model))),
    byTool: tally(divergences.flatMap((record) => optionalKey(record.context.tool))),
    byFramework: tally(divergences.flatMap((record) => optionalKey(record.context.framework))),
    // 심각도 분포와 같은 규약 — 0인 칸도 남긴다. 지우면 분포가 아니라 목록이 된다.
    correctionCategories: CORRECTION_CATEGORIES.map((category) => ({
      key: category,
      count: corrections.filter((entry) => entry.category === category).length,
    })),
    modelByCorrection: [...cells.values()].sort(
      (a, b) => compareStrings(a.row, b.row) || compareStrings(a.column, b.column),
    ),
    corrections,
  };
}

function optionalKey(value: string | undefined): string[] {
  const trimmed = value?.trim();
  return trimmed === undefined || trimmed.length === 0 ? [] : [trimmed];
}
