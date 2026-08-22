/**
 * ChartSpec 산출. 출처: specs/08-publishing.md §5.1
 * "팩트 추출기가 `{type, data, caption}` 형태로 산출하고 프론트(web)가 렌더한다."
 *
 * **LLM이 데이터를 만들지 않는다**는 것이 §5.1 제목의 절반이다. 여기 들어가는 숫자는
 * 전부 `ArticleFacts`에서 온다 — 차트는 팩트 팩의 **투영**이지 별도의 계산이 아니다.
 * 그래서 이 파일은 records를 다시 읽지 않고 `ArticleFacts`만 받는다. 둘이 갈라지면
 * 본문의 숫자와 그림의 숫자가 어긋나는데, 그건 §3이 막으려던 바로 그 사고다.
 *
 * 데이터가 빈 차트는 만들지 않는다. 빈 축이 그려진 그림은 없느니만 못하다 —
 * §5.2가 "깨진 다이어그램이 실리는 것보다 없는 편이 낫다"고 한 것과 같은 판단이다.
 */
import type { ArticleKind, ChartSpec } from "@sentinel/contracts";

import { compareStrings } from "./order.js";
import type { ArticleFacts, FactCell } from "./types.js";

/** bar·line의 데이터. 한 점 = (라벨, 값). */
export interface FactChartPoint {
  readonly label: string;
  readonly value: number;
}

export interface FactSeriesData {
  readonly points: readonly FactChartPoint[];
}

export interface FactHeatmapData {
  readonly rows: readonly string[];
  readonly columns: readonly string[];
  readonly cells: readonly FactCell[];
}

export interface FactTimelineData {
  readonly events: readonly {
    readonly at: string;
    readonly recordId: string;
    /** 구조화된 값만으로 만든 라벨. 레코드 제목 같은 산문은 들어가지 않는다. */
    readonly label: string;
  }[];
}

const MS_PER_DAY = 86_400_000;

/** ChartSpec.caption의 계약 상한(300자). */
const CAPTION_MAX_CHARS = 300;

function caption(text: string): string {
  return text.length <= CAPTION_MAX_CHARS ? text : `${text.slice(0, CAPTION_MAX_CHARS - 1)}…`;
}

/**
 * §5.1의 "유형별 기본 차트"를 그대로 낸다.
 * - 패턴 아티클: 태그 빈도 바, 발생 시계열, 재발 간격
 * - 이격 리포트: 모델×이격유형 히트맵, correction 유형 분포
 * - 다이제스트: 주간 기록 추이, 프로젝트별 기여
 *
 * 케이스 스터디는 §5.1 목록에 없다. 단건 서사에 빈도 차트는 의미가 없으므로,
 * §3이 요구한 타임라인 하나만 낸다(`ChartKind`에 `timeline`이 있는 이유이기도 하다).
 */
export function buildCharts(kind: ArticleKind, facts: ArticleFacts): ChartSpec[] {
  switch (kind) {
    case "case":
      return compact([timelineChart(facts)]);
    case "pattern":
      return compact([tagChart(facts), occurrenceChart(facts), intervalChart(facts)]);
    case "divergence-report":
      return compact([modelHeatmap(facts), correctionChart(facts)]);
    case "digest":
      return compact([weeklyChart(facts), projectChart(facts)]);
  }
}

function compact(charts: readonly (ChartSpec | undefined)[]): ChartSpec[] {
  return charts.filter((chart): chart is ChartSpec => chart !== undefined);
}

function timelineChart(facts: ArticleFacts): ChartSpec | undefined {
  if (facts.timeline.length === 0) return undefined;
  const data: FactTimelineData = {
    events: facts.timeline.map((entry) => ({
      at: entry.at,
      recordId: entry.recordId,
      label: `${entry.severity} ${entry.type} ${entry.event}`,
    })),
  };
  return {
    type: "timeline",
    data,
    caption: caption(
      `사건 타임라인 — ${String(facts.counts.records)}건, ` +
        `${facts.period.firstAt.slice(0, 10)} ~ ${facts.period.lastAt.slice(0, 10)}`,
    ),
  };
}

function tagChart(facts: ArticleFacts): ChartSpec | undefined {
  const points = facts.distributions.tags.map((entry) => ({
    label: entry.key,
    value: entry.count,
  }));
  if (points.length === 0) return undefined;
  const data: FactSeriesData = { points };
  return {
    type: "bar",
    data,
    caption: caption(
      `태그 빈도 — 소스 ${String(facts.counts.records)}건에서 태그 ${String(points.length)}종`,
    ),
  };
}

/** 발생 시계열. 날짜(UTC)별 신규 레코드 수. */
function occurrenceChart(facts: ArticleFacts): ChartSpec | undefined {
  const perDay = new Map<string, number>();
  for (const entry of facts.timeline) {
    if (entry.event !== "created") continue;
    const day = entry.at.slice(0, 10);
    perDay.set(day, (perDay.get(day) ?? 0) + 1);
  }
  const points = [...perDay]
    .map(([label, value]) => ({ label, value }))
    .sort((a, b) => compareStrings(a.label, b.label));
  if (points.length === 0) return undefined;
  const data: FactSeriesData = { points };
  return {
    type: "line",
    data,
    caption: caption(`발생 시계열 — 일자별 신규 기록 ${String(facts.counts.records)}건`),
  };
}

/** 재발 간격. n번째 발생과 그 직전 발생 사이의 일수. */
function intervalChart(facts: ArticleFacts): ChartSpec | undefined {
  const points = facts.recurrence.intervalsDays.map((value, index) => ({
    label: String(index + 1),
    value,
  }));
  if (points.length === 0) return undefined;
  const data: FactSeriesData = { points };
  const mean = facts.recurrence.meanIntervalDays;
  return {
    type: "line",
    data,
    caption: caption(
      `재발 간격(일) — ${String(points.length)}구간` +
        (mean === null ? "" : `, 평균 ${String(mean)}일`),
    ),
  };
}

function modelHeatmap(facts: ArticleFacts): ChartSpec | undefined {
  const cells = facts.divergence?.modelByCorrection ?? [];
  if (cells.length === 0) return undefined;
  const data: FactHeatmapData = {
    rows: [...new Set(cells.map((cell) => cell.row))].sort(compareStrings),
    columns: [...new Set(cells.map((cell) => cell.column))].sort(compareStrings),
    cells,
  };
  return {
    type: "heatmap",
    data,
    caption: caption(
      `모델 × correction 유형 — 이격 ${String(facts.divergence?.count ?? 0)}건`,
    ),
  };
}

function correctionChart(facts: ArticleFacts): ChartSpec | undefined {
  const points = (facts.divergence?.correctionCategories ?? []).map((entry) => ({
    label: entry.key,
    value: entry.count,
  }));
  if (points.length === 0) return undefined;
  const data: FactSeriesData = { points };
  return {
    type: "bar",
    data,
    caption: caption(
      `correction 유형 분포 — 이격 ${String(facts.divergence?.count ?? 0)}건, ` +
        `분류 근거는 본문의 파일 경로 토큰`,
    ),
  };
}

/** 주간 기록 추이. 주의 시작은 UTC 월요일 00:00이다(T-029 다이제스트 창과 같은 기준). */
function weeklyChart(facts: ArticleFacts): ChartSpec | undefined {
  const perWeek = new Map<string, number>();
  for (const entry of facts.timeline) {
    if (entry.event !== "created") continue;
    const week = weekStart(new Date(entry.at));
    perWeek.set(week, (perWeek.get(week) ?? 0) + 1);
  }
  const points = [...perWeek]
    .map(([label, value]) => ({ label, value }))
    .sort((a, b) => compareStrings(a.label, b.label));
  if (points.length === 0) return undefined;
  const data: FactSeriesData = { points };
  return {
    type: "line",
    data,
    caption: caption(`주간 기록 추이 — ${String(points.length)}주, 총 ${String(facts.counts.records)}건`),
  };
}

function weekStart(at: Date): string {
  const midnight = Date.UTC(at.getUTCFullYear(), at.getUTCMonth(), at.getUTCDate());
  const daysSinceMonday = (new Date(midnight).getUTCDay() + 6) % 7;
  return new Date(midnight - daysSinceMonday * MS_PER_DAY).toISOString().slice(0, 10);
}

function projectChart(facts: ArticleFacts): ChartSpec | undefined {
  const points = facts.distributions.project.map((entry) => ({
    label: entry.key,
    value: entry.count,
  }));
  if (points.length === 0) return undefined;
  const data: FactSeriesData = { points };
  return {
    type: "bar",
    data,
    caption: caption(`프로젝트별 기여 — 프로젝트 ${String(points.length)}개`),
  };
}
