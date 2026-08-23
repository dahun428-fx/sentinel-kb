/**
 * 차트 모델. T-033 Acceptance 2("차트 3종이 렌더됨")의 관측 경로다.
 *
 * `ChartKind`를 **기대값 자리에 쓰지 않는다**(T-041 래칫). 대신 좌변에 두고
 * "전건이 지원되는가"를 묻는다 — 단언의 주어는 개수가 아니라 커버리지다.
 */
import { ChartKind } from "@sentinel/contracts";
import { describe, expect, it } from "vitest";

import {
  isSupportedChartKind,
  narrowHeatmapData,
  narrowSeriesData,
  narrowTimelineData,
  supportedChartKinds,
  toChartModel,
} from "./chart-model";

const SERIES = { points: [{ label: "a", value: 3 }, { label: "b", value: 6 }] };
const HEATMAP = {
  rows: ["opus", "sonnet"],
  columns: ["api", "type"],
  cells: [
    { row: "opus", column: "api", count: 2 },
    { row: "sonnet", column: "type", count: 4 },
  ],
};
const TIMELINE = {
  events: [{ at: "2026-08-01T00:00:00.000Z", recordId: "r1", label: "SEV2 incident created" }],
};

describe("차트 종류 커버리지", () => {
  it("bar·line·heatmap·timeline을 그린다", () => {
    expect(supportedChartKinds()).toEqual(["bar", "heatmap", "line", "timeline"]);
  });

  it("계약의 ChartKind 전건이 지원된다 — 하나라도 빠지면 차트가 조용히 사라진다", () => {
    expect(ChartKind.options.every((kind) => isSupportedChartKind(kind))).toBe(true);
  });

  it("Acceptance가 이름을 부른 3종은 실제로 기하를 낸다", () => {
    expect(toChartModel({ type: "bar", data: SERIES, caption: "c" }).kind).toBe("bar");
    expect(toChartModel({ type: "line", data: SERIES, caption: "c" }).kind).toBe("line");
    expect(toChartModel({ type: "heatmap", data: HEATMAP, caption: "c" }).kind).toBe("heatmap");
  });

  it("timeline도 모델이 된다 — 케이스 아티클의 유일한 차트다", () => {
    expect(toChartModel({ type: "timeline", data: TIMELINE, caption: "c" }).kind).toBe("timeline");
  });
});

describe("데이터 좁히기 (ChartSpec.data는 계약에서 unknown이다)", () => {
  it("형상이 맞으면 좁혀진다", () => {
    expect(narrowSeriesData(SERIES)?.points).toHaveLength(2);
    expect(narrowHeatmapData(HEATMAP)?.cells).toHaveLength(2);
    expect(narrowTimelineData(TIMELINE)?.events).toHaveLength(1);
  });

  it("한 점이라도 형상이 어긋나면 전체를 거절한다 — 반쪽 그림은 거짓말이다", () => {
    expect(narrowSeriesData({ points: [{ label: "a", value: "3" }] })).toBeNull();
    expect(narrowSeriesData({ points: [{ label: 1, value: 3 }] })).toBeNull();
    expect(narrowSeriesData({ points: [{ label: "a", value: Number.NaN }] })).toBeNull();
  });

  it("아예 다른 값이면 null이다", () => {
    expect(narrowSeriesData(null)).toBeNull();
    expect(narrowSeriesData("문자열")).toBeNull();
    expect(narrowSeriesData([])).toBeNull();
    expect(narrowHeatmapData({ rows: [1], columns: [], cells: [] })).toBeNull();
    expect(narrowTimelineData({ events: [{ at: 1, recordId: "r", label: "l" }] })).toBeNull();
  });

  it("timeline의 at이 Date로 와도 받는다 — json-dates가 `at` 키를 되살리기 때문이다", () => {
    const revived = narrowTimelineData({
      events: [{ at: new Date("2026-08-01T00:00:00.000Z"), recordId: "r1", label: "l" }],
    });
    expect(revived?.events[0]?.at).toBe("2026-08-01T00:00:00.000Z");
  });

  it("형상이 아니면 던지지 않고 invalid 모델로 떨어진다", () => {
    const model = toChartModel({ type: "bar", data: { nope: true }, caption: "c" });
    expect(model.kind).toBe("invalid");
  });

  it("데이터가 비면 그리지 않는다 — 빈 축은 없느니만 못하다", () => {
    expect(toChartModel({ type: "line", data: { points: [] }, caption: "c" }).kind).toBe("invalid");
  });
});

describe("bar 기하", () => {
  const model = toChartModel({ type: "bar", data: SERIES, caption: "c" });

  it("바닥을 0에 고정한다 — 최솟값에 맞추면 3과 6의 차이가 두 배로 보인다", () => {
    if (model.kind !== "bar") throw new Error("bar 모델이 아니다");
    expect(model.maxValue).toBe(6);
    // 값 3은 값 6의 절반 높이여야 한다.
    expect((model.bars[0]?.height ?? 0) * 2).toBeCloseTo(model.bars[1]?.height ?? 0, 5);
  });

  it("막대가 뷰박스 안에 있다", () => {
    if (model.kind !== "bar") throw new Error("bar 모델이 아니다");
    for (const bar of model.bars) {
      expect(bar.x).toBeGreaterThanOrEqual(0);
      expect(bar.y).toBeGreaterThanOrEqual(0);
      expect(bar.x + bar.width).toBeLessThanOrEqual(640);
      expect(bar.y + bar.height).toBeLessThanOrEqual(220);
    }
  });

  it("값이 전부 0이어도 나눗셈이 터지지 않는다", () => {
    const zero = toChartModel({
      type: "bar",
      data: { points: [{ label: "a", value: 0 }] },
      caption: "c",
    });
    if (zero.kind !== "bar") throw new Error("bar 모델이 아니다");
    expect(zero.bars[0]?.height).toBe(0);
  });

  it("점이 많으면 라벨만 솎는다 — 값은 전부 그린다", () => {
    const many = toChartModel({
      type: "bar",
      data: { points: Array.from({ length: 40 }, (_, i) => ({ label: `p${String(i)}`, value: i })) },
      caption: "c",
    });
    if (many.kind !== "bar") throw new Error("bar 모델이 아니다");
    expect(many.bars).toHaveLength(40);
    expect(many.bars.filter((bar) => bar.showLabel).length).toBeLessThan(40);
  });
});

describe("line 기하", () => {
  it("polyline 좌표 문자열을 만든다", () => {
    const model = toChartModel({ type: "line", data: SERIES, caption: "c" });
    if (model.kind !== "line") throw new Error("line 모델이 아니다");
    expect(model.polyline.split(" ")).toHaveLength(2);
    expect(model.points[0]?.y).toBeGreaterThan(model.points[1]?.y ?? 0);
  });

  it("점이 하나면 가운데에 찍는다 — 0으로 나누지 않는다", () => {
    const model = toChartModel({
      type: "line",
      data: { points: [{ label: "only", value: 5 }] },
      caption: "c",
    });
    if (model.kind !== "line") throw new Error("line 모델이 아니다");
    expect(model.points).toHaveLength(1);
    expect(Number.isFinite(model.points[0]?.x ?? Number.NaN)).toBe(true);
  });
});

describe("heatmap 기하", () => {
  it("강도는 0..1이고 최대 셀이 1이다", () => {
    const model = toChartModel({ type: "heatmap", data: HEATMAP, caption: "c" });
    if (model.kind !== "heatmap") throw new Error("heatmap 모델이 아니다");
    expect(model.maxCount).toBe(4);
    for (const cell of model.cells) {
      expect(cell.intensity).toBeGreaterThanOrEqual(0);
      expect(cell.intensity).toBeLessThanOrEqual(1);
    }
  });

  it("축에 없는 셀은 그리지 않는다 — 좌표 없는 값을 0,0에 찍으면 거짓말이다", () => {
    const model = toChartModel({
      type: "heatmap",
      data: {
        rows: ["opus"],
        columns: ["api"],
        cells: [
          { row: "opus", column: "api", count: 1 },
          { row: "없는행", column: "api", count: 9 },
        ],
      },
      caption: "c",
    });
    if (model.kind !== "heatmap") throw new Error("heatmap 모델이 아니다");
    expect(model.cells).toHaveLength(1);
  });
});
