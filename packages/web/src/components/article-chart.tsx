/**
 * 차트 렌더. specs/08 §5.1 "팩트 추출기가 산출하고 **프론트(web)가 렌더한다**".
 *
 * `<svg>`를 **React 엘리먼트로** 그린다 — SVG 문자열을 만들어 넣지 않는다.
 * 좌표·크기는 전부 `lib/chart-model.ts`가 계산하며(단위 테스트로 잠겨 있다),
 * 여기서는 그 숫자를 속성으로 옮기고 색·라벨만 정한다.
 *
 * 캡션과 라벨은 팩트 추출기가 만든 문자열이지만(코드 산출물, LLM 아님) 그래도
 * 텍스트 노드로만 들어간다 — 예외를 하나 두면 그 예외가 다음 사고의 자리가 된다.
 */
import type { ChartSpec } from "@sentinel/contracts";
import type { ReactNode } from "react";

import { CHART_VIEW, toChartModel } from "../lib/chart-model";

const VIEW_BOX = `0 0 ${String(CHART_VIEW.width)} ${String(CHART_VIEW.height)}`;
/** 값 축 라벨을 붙일 위치(왼쪽 여백 안). `chart-model.ts`의 PADDING.left와 맞춘다. */
const AXIS_X = 44;

function ChartFrame({
  caption,
  kind,
  children,
}: {
  caption: string;
  kind: string;
  children: ReactNode;
}) {
  return (
    <figure className="chart" data-testid="article-chart" data-chart-kind={kind}>
      {children}
      <figcaption className="muted">{caption}</figcaption>
    </figure>
  );
}

export function ArticleChart({ spec }: { spec: ChartSpec }) {
  const model = toChartModel(spec);

  if (model.kind === "invalid") {
    // 빈 축을 그리는 대신 사유를 적는다 — §5.2의 "없는 편이 낫다"와 같은 판단이다.
    return (
      <figure className="chart chart-invalid" data-testid="article-chart" data-chart-kind="invalid">
        <p className="muted">차트를 그리지 못했다: {model.reason}</p>
        <figcaption className="muted">{spec.caption}</figcaption>
      </figure>
    );
  }

  if (model.kind === "bar") {
    return (
      <ChartFrame caption={spec.caption} kind="bar">
        <svg
          className="chart-svg"
          viewBox={VIEW_BOX}
          role="img"
          aria-label={spec.caption}
          preserveAspectRatio="xMidYMid meet"
        >
          <text className="chart-axis" x={AXIS_X} y={20} textAnchor="end">
            {model.maxValue}
          </text>
          <text className="chart-axis" x={AXIS_X} y={CHART_VIEW.height - 44} textAnchor="end">
            0
          </text>
          {model.bars.map((bar) => (
            <g key={`${bar.label}-${String(bar.x)}`}>
              <rect
                className="chart-bar"
                x={bar.x}
                y={bar.y}
                width={bar.width}
                height={bar.height}
              />
              {bar.showLabel ? (
                <text
                  className="chart-label"
                  x={bar.x + bar.width / 2}
                  y={CHART_VIEW.height - 24}
                  textAnchor="middle"
                >
                  {bar.label}
                </text>
              ) : null}
            </g>
          ))}
        </svg>
      </ChartFrame>
    );
  }

  if (model.kind === "line") {
    return (
      <ChartFrame caption={spec.caption} kind="line">
        <svg
          className="chart-svg"
          viewBox={VIEW_BOX}
          role="img"
          aria-label={spec.caption}
          preserveAspectRatio="xMidYMid meet"
        >
          <text className="chart-axis" x={AXIS_X} y={20} textAnchor="end">
            {model.maxValue}
          </text>
          <polyline className="chart-line" points={model.polyline} fill="none" />
          {model.points.map((point) => (
            <g key={`${point.label}-${String(point.x)}`}>
              <circle className="chart-dot" cx={point.x} cy={point.y} r={3} />
              {point.showLabel ? (
                <text
                  className="chart-label"
                  x={point.x}
                  y={CHART_VIEW.height - 24}
                  textAnchor="middle"
                >
                  {point.label}
                </text>
              ) : null}
            </g>
          ))}
        </svg>
      </ChartFrame>
    );
  }

  if (model.kind === "heatmap") {
    return (
      <ChartFrame caption={spec.caption} kind="heatmap">
        <svg
          className="chart-svg"
          viewBox={VIEW_BOX}
          role="img"
          aria-label={spec.caption}
          preserveAspectRatio="xMidYMid meet"
        >
          {model.cells.map((cell) => (
            <g key={`${cell.row}-${cell.column}`}>
              <rect
                className="chart-cell"
                x={cell.x}
                y={cell.y}
                width={cell.width}
                height={cell.height}
                /* 강도는 모델이 낸 0..1이다. 색상은 CSS 변수(--accent)가 정한다. */
                fillOpacity={0.15 + cell.intensity * 0.85}
              />
              <text
                className="chart-label"
                x={cell.x + cell.width / 2}
                y={cell.y + cell.height / 2 + 4}
                textAnchor="middle"
              >
                {cell.count}
              </text>
            </g>
          ))}
          {model.rows.map((row, index) => (
            <text
              className="chart-axis"
              key={`row-${row}`}
              x={AXIS_X}
              y={12 + ((CHART_VIEW.height - 56) / model.rows.length) * (index + 0.5) + 4}
              textAnchor="end"
            >
              {row}
            </text>
          ))}
          {model.columns.map((column, index) => (
            <text
              className="chart-label"
              key={`column-${column}`}
              x={48 + ((CHART_VIEW.width - 60) / model.columns.length) * (index + 0.5)}
              y={CHART_VIEW.height - 24}
              textAnchor="middle"
            >
              {column}
            </text>
          ))}
        </svg>
      </ChartFrame>
    );
  }

  /**
   * timeline. 축 위의 점으로 그리면 라벨이 겹쳐 읽을 수 없다 —
   * 사건 목록은 **표**가 정직하다. 스크린리더에도 이쪽이 낫다.
   */
  return (
    <ChartFrame caption={spec.caption} kind="timeline">
      <ol className="timeline">
        {model.entries.map((entry) => (
          <li key={`${entry.at}-${entry.recordId}`}>
            <time dateTime={entry.at}>{entry.at.slice(0, 10)}</time> <span>{entry.label}</span>
          </li>
        ))}
      </ol>
    </ChartFrame>
  );
}

/** 아티클의 차트 묶음. `charts`가 없거나 비면 아무것도 그리지 않는다. */
export function ArticleCharts({ charts }: { charts?: readonly ChartSpec[] | undefined }) {
  if (charts === undefined || charts.length === 0) return null;
  return (
    <section aria-labelledby="charts-heading">
      <h2 id="charts-heading">그림</h2>
      {charts.map((spec, index) => (
        <ArticleChart key={`${spec.type}-${String(index)}`} spec={spec} />
      ))}
    </section>
  );
}
