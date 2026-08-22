/**
 * 검색 결과 목록.
 *
 * 표기 규칙 두 가지가 이 파일의 존재 이유다.
 * 1) 점수는 **순위**로 읽힌다. RRF 융합 점수를 백분율로 바꾸지 않는다(`lib/display.ts` 참조).
 * 2) `injection-suspect` 결과는 감추지 않고 **경고와 함께** 노출한다(specs/03 §2).
 *    요약문은 React 텍스트 노드로만 들어간다 — HTML로 해석될 경로가 없다.
 */
import type { SearchHit } from "@sentinel/contracts";

import {
  FUSION_SCORE_NOTE,
  formatFusionScore,
  rankLabel,
  recordSectionHref,
  sectionLabel,
  typeLabel,
} from "../lib/display";

import { FlagNotices } from "./flag-notices";

const SCORE_NOTE_ID = "fusion-score-note";

export function ResultList({ results }: { results: readonly SearchHit[] }) {
  if (results.length === 0) {
    return (
      <p data-testid="empty-results">
        조건에 맞는 기록이 없다. 질의를 넓히거나 필터를 풀어보라.
      </p>
    );
  }

  return (
    <>
      <p className="muted" id={SCORE_NOTE_ID}>
        {FUSION_SCORE_NOTE}
      </p>
      <ol className="result-list" data-testid="result-list">
        {results.map((hit, index) => (
          <li className="result-item" key={`${hit.recordId}-${hit.section}`}>
            <p className="result-meta">
              <span className="rank">{rankLabel(index)}</span>
              <span className="badge" data-testid="result-type">
                {typeLabel(hit.type)}
              </span>
              <span className="badge">{hit.project}</span>
              <span className="badge">{sectionLabel(hit.section)}</span>
              <span className="badge" aria-describedby={SCORE_NOTE_ID}>
                {formatFusionScore(hit.score)}
              </span>
            </p>

            <h3>
              <a href={recordSectionHref(hit.recordId, hit.section)} data-testid="result-link">
                {hit.title}
              </a>
            </h3>

            <FlagNotices flags={hit.flags} context="검색 결과" />

            <p className="summary">{hit.summary}</p>
          </li>
        ))}
      </ol>
    </>
  );
}
