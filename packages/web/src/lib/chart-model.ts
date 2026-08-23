/**
 * `ChartSpec` → 렌더 가능한 기하. specs/08 §5.1
 * "팩트 추출기가 `{type, data, caption}` 형태로 산출하고 **프론트(web)가 렌더한다**."
 *
 * ## 왜 여기서 다시 검사하는가
 * `ChartSpec.data`는 계약에서 `z.unknown()`이다 — 차트 종류마다 형상이 다르고,
 * 그 형상을 좁히는 것은 팩트 추출기(T-030)의 몫이라고 `packages/contracts/src/article.ts`가
 * 적어 뒀다. 좁혀진 형상은 `@sentinel/core`의 `FactSeriesData`·`FactHeatmapData`·
 * `FactTimelineData`이며 **여기서 재정의하지 않고 그 타입을 그대로 가져온다**(CLAUDE.md).
 * 다만 타입은 런타임 검사가 아니므로, HTTP를 건너온 `unknown`을 그 형상으로 **좁히는 일**은
 * 웹이 해야 한다. 그 좁히기가 실패하면 화면을 터뜨리지 않고 `invalid` 모델로 떨어뜨린다 —
 * §5.2가 "깨진 다이어그램이 실리는 것보다 없는 편이 낫다"고 한 것과 같은 태도다.
 *
 * ## 기하만 만들고 마크업은 만들지 않는다
 * 이 파일은 숫자(좌표·크기·강도)만 낸다. `<svg>`는 컴포넌트가 React 엘리먼트로 그린다 —
 * SVG 문자열을 만들면 그것을 DOM에 넣는 순간 `dangerouslySetInnerHTML`이 필요해지고,
 * 그 길은 T-023이 테스트로 막아 둔 길이다.
 */
import type { ChartKind, ChartSpec } from "@sentinel/contracts";
import type {
  FactChartPoint,
  FactHeatmapData,
  FactSeriesData,
  FactTimelineData,
} from "@sentinel/core";

// ---------------------------------------------------------------- 지원 종류

/**
 * 웹이 그릴 줄 아는 차트 종류. **`ChartKind`의 4종 전부**여야 한다 —
 * 하나라도 빠지면 팩트 추출기가 낸 차트가 화면에서 조용히 사라진다(T-033 Acceptance 2).
 * `chart-model.spec.ts`가 `ChartKind.options` 전건이 여기 있는지 관측한다.
 */
const SUPPORTED_KINDS = ["bar", "heatmap", "line", "timeline"] as const;

export function supportedChartKinds(): readonly string[] {
  return SUPPORTED_KINDS;
}

export function isSupportedChartKind(kind: ChartKind): boolean {
  return SUPPORTED_KINDS.some((supported) => supported === kind);
}

// ---------------------------------------------------------------- 뷰박스

/**
 * 고정 viewBox. SVG는 `viewBox`로 스케일되므로 픽셀 크기를 여기서 정해도
 * 화면 폭에 맞춰 늘어난다(`max-width: 100%`).
 */
export const CHART_VIEW = { width: 640, height: 220 } as const;
const PADDING = { left: 48, right: 12, top: 12, bottom: 44 } as const;
const PLOT = {
  width: CHART_VIEW.width - PADDING.left - PADDING.right,
  height: CHART_VIEW.height - PADDING.top - PADDING.bottom,
} as const;

/** 한 화면에 라벨이 겹치지 않고 들어가는 점의 수. 넘으면 라벨만 솎는다(값은 그대로 그린다). */
const MAX_LABELS = 12;

// ---------------------------------------------------------------- 모델

export interface BarGeometry {
  readonly label: string;
  readonly value: number;
  readonly x: number;
  readonly y: number;
  readonly width: number;
  readonly height: number;
  readonly showLabel: boolean;
}

export interface LinePointGeometry {
  readonly label: string;
  readonly value: number;
  readonly x: number;
  readonly y: number;
  readonly showLabel: boolean;
}

export interface HeatmapCellGeometry {
  readonly row: string;
  readonly column: string;
  readonly count: number;
  readonly x: number;
  readonly y: number;
  readonly width: number;
  readonly height: number;
  /** 0..1. 색이 아니라 강도다 — 색은 CSS 변수로 컴포넌트가 정한다. */
  readonly intensity: number;
}

export interface TimelineEntry {
  readonly at: string;
  readonly recordId: string;
  readonly label: string;
}

export type ChartModel =
  | { readonly kind: "bar"; readonly bars: readonly BarGeometry[]; readonly maxValue: number }
  | {
      readonly kind: "line";
      readonly points: readonly LinePointGeometry[];
      readonly polyline: string;
      readonly maxValue: number;
    }
  | {
      readonly kind: "heatmap";
      readonly rows: readonly string[];
      readonly columns: readonly string[];
      readonly cells: readonly HeatmapCellGeometry[];
      readonly maxCount: number;
    }
  | { readonly kind: "timeline"; readonly entries: readonly TimelineEntry[] }
  /** 데이터가 계약된 형상이 아니거나 비었다. 화면은 캡션과 사유만 보여준다. */
  | { readonly kind: "invalid"; readonly reason: string };

// ---------------------------------------------------------------- 좁히기

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** `{points: [{label, value}]}`인가. 하나라도 형상이 어긋나면 전체를 거절한다. */
export function narrowSeriesData(data: unknown): FactSeriesData | null {
  if (!isRecord(data)) return null;
  const points: unknown = data["points"];
  if (!Array.isArray(points)) return null;

  const narrowed: FactChartPoint[] = [];
  for (const point of points) {
    if (!isRecord(point)) return null;
    const label: unknown = point["label"];
    const value: unknown = point["value"];
    if (typeof label !== "string" || typeof value !== "number" || !Number.isFinite(value)) {
      return null;
    }
    narrowed.push({ label, value });
  }
  return { points: narrowed };
}

export function narrowHeatmapData(data: unknown): FactHeatmapData | null {
  if (!isRecord(data)) return null;
  const rows: unknown = data["rows"];
  const columns: unknown = data["columns"];
  const cells: unknown = data["cells"];
  if (!Array.isArray(rows) || !Array.isArray(columns) || !Array.isArray(cells)) return null;
  if (!rows.every((row) => typeof row === "string")) return null;
  if (!columns.every((column) => typeof column === "string")) return null;

  const narrowed: { row: string; column: string; count: number }[] = [];
  for (const cell of cells) {
    if (!isRecord(cell)) return null;
    const row: unknown = cell["row"];
    const column: unknown = cell["column"];
    const count: unknown = cell["count"];
    if (typeof row !== "string" || typeof column !== "string") return null;
    if (typeof count !== "number" || !Number.isFinite(count)) return null;
    narrowed.push({ row, column, count });
  }
  return { rows, columns, cells: narrowed };
}

/**
 * `at`이 `Date`로도 올 수 있다. `lib/json-dates.ts`가 `editHistory[].at`(계약상 `z.date()`)을
 * 되살리려고 `at` 키를 전부 훑기 때문이다 — 그 순회는 `charts[].data.events[].at`에도 닿는다.
 * 여기서 두 형태를 모두 받아 ISO 문자열로 되돌린다. 되살리기 규칙을 좁히는 대신 여기서
 * 흡수하는 이유는, 계약이 `ChartSpec.data`를 `unknown`으로 열어 둔 이상 **어떤 형상이
 * 오더라도 화면이 죽지 않아야** 하기 때문이다.
 */
function isoString(value: unknown): string | null {
  if (typeof value === "string") return value;
  if (value instanceof Date && !Number.isNaN(value.getTime())) return value.toISOString();
  return null;
}

export function narrowTimelineData(data: unknown): FactTimelineData | null {
  if (!isRecord(data)) return null;
  const events: unknown = data["events"];
  if (!Array.isArray(events)) return null;

  const narrowed: TimelineEntry[] = [];
  for (const event of events) {
    if (!isRecord(event)) return null;
    const at = isoString(event["at"]);
    const recordId: unknown = event["recordId"];
    const label: unknown = event["label"];
    if (at === null || typeof recordId !== "string" || typeof label !== "string") {
      return null;
    }
    narrowed.push({ at, recordId, label });
  }
  return { events: narrowed };
}

// ---------------------------------------------------------------- 기하

/** 라벨을 몇 개마다 하나씩 보일지. 축이 글자로 덮이면 그림이 아니라 얼룩이 된다. */
function labelStride(count: number): number {
  return count <= MAX_LABELS ? 1 : Math.ceil(count / MAX_LABELS);
}

/**
 * 값 축의 상한. **0을 바닥으로 고정한다** — 바닥을 최솟값에 맞추면 3과 4의 차이가
 * 두 배로 보인다. 빈도 차트에서 그건 사실 왜곡이다.
 */
function axisMax(values: readonly number[]): number {
  const max = Math.max(0, ...values);
  return max === 0 ? 1 : max;
}

export function barGeometry(data: FactSeriesData): {
  bars: BarGeometry[];
  maxValue: number;
} {
  const points = data.points;
  const maxValue = axisMax(points.map((point) => point.value));
  const slot = points.length === 0 ? PLOT.width : PLOT.width / points.length;
  const width = Math.max(1, slot * 0.7);
  const stride = labelStride(points.length);

  const bars = points.map((point, index) => {
    const height = Math.max(0, (point.value / maxValue) * PLOT.height);
    return {
      label: point.label,
      value: point.value,
      x: PADDING.left + slot * index + (slot - width) / 2,
      y: PADDING.top + PLOT.height - height,
      width,
      height,
      showLabel: index % stride === 0,
    };
  });
  return { bars, maxValue };
}

export function lineGeometry(data: FactSeriesData): {
  points: LinePointGeometry[];
  polyline: string;
  maxValue: number;
} {
  const source = data.points;
  const maxValue = axisMax(source.map((point) => point.value));
  const span = source.length <= 1 ? 1 : source.length - 1;
  const stride = labelStride(source.length);

  const points = source.map((point, index) => ({
    label: point.label,
    value: point.value,
    x: PADDING.left + (source.length <= 1 ? PLOT.width / 2 : (PLOT.width * index) / span),
    y: PADDING.top + PLOT.height - (point.value / maxValue) * PLOT.height,
    showLabel: index % stride === 0,
  }));

  const polyline = points
    .map((point) => `${point.x.toFixed(2)},${point.y.toFixed(2)}`)
    .join(" ");
  return { points, polyline, maxValue };
}

export function heatmapGeometry(data: FactHeatmapData): {
  cells: HeatmapCellGeometry[];
  maxCount: number;
} {
  const maxCount = axisMax(data.cells.map((cell) => cell.count));
  const cellWidth = data.columns.length === 0 ? PLOT.width : PLOT.width / data.columns.length;
  const cellHeight = data.rows.length === 0 ? PLOT.height : PLOT.height / data.rows.length;

  const cells: HeatmapCellGeometry[] = [];
  for (const cell of data.cells) {
    const columnIndex = data.columns.indexOf(cell.column);
    const rowIndex = data.rows.indexOf(cell.row);
    // 축에 없는 셀은 그리지 않는다 — 좌표가 없는 값을 0,0에 찍으면 거짓말이 된다.
    if (columnIndex === -1 || rowIndex === -1) continue;
    cells.push({
      row: cell.row,
      column: cell.column,
      count: cell.count,
      x: PADDING.left + cellWidth * columnIndex,
      y: PADDING.top + cellHeight * rowIndex,
      width: cellWidth,
      height: cellHeight,
      intensity: cell.count / maxCount,
    });
  }
  return { cells, maxCount };
}

// ---------------------------------------------------------------- 진입점

/** `ChartSpec` 하나를 렌더 모델로. 어떤 입력에도 던지지 않는다. */
export function toChartModel(spec: ChartSpec): ChartModel {
  switch (spec.type) {
    case "bar": {
      const data = narrowSeriesData(spec.data);
      if (data === null) return { kind: "invalid", reason: "bar 차트 데이터 형상이 아니다" };
      if (data.points.length === 0) return { kind: "invalid", reason: "데이터가 비어 있다" };
      const { bars, maxValue } = barGeometry(data);
      return { kind: "bar", bars, maxValue };
    }
    case "line": {
      const data = narrowSeriesData(spec.data);
      if (data === null) return { kind: "invalid", reason: "line 차트 데이터 형상이 아니다" };
      if (data.points.length === 0) return { kind: "invalid", reason: "데이터가 비어 있다" };
      const { points, polyline, maxValue } = lineGeometry(data);
      return { kind: "line", points, polyline, maxValue };
    }
    case "heatmap": {
      const data = narrowHeatmapData(spec.data);
      if (data === null) return { kind: "invalid", reason: "heatmap 데이터 형상이 아니다" };
      if (data.cells.length === 0) return { kind: "invalid", reason: "데이터가 비어 있다" };
      const { cells, maxCount } = heatmapGeometry(data);
      return { kind: "heatmap", rows: data.rows, columns: data.columns, cells, maxCount };
    }
    case "timeline": {
      const data = narrowTimelineData(spec.data);
      if (data === null) return { kind: "invalid", reason: "timeline 데이터 형상이 아니다" };
      if (data.events.length === 0) return { kind: "invalid", reason: "데이터가 비어 있다" };
      return { kind: "timeline", entries: [...data.events] };
    }
  }
}
