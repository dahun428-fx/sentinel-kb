/**
 * 레코드 상세 (T-023 Scope). `GET /v1/records/:id`의 본문 포함 응답을 렌더한다.
 *
 * 각 본문 섹션에 `section-<ChunkSection>` 앵커를 단다 — 검색 결과와 인용이 같은
 * 규칙으로 링크를 만들기 때문에(`lib/display.ts`) 이 앵커가 점프의 착지점이다.
 * 본문은 전부 React 텍스트 노드다. `injection-suspect` 레코드도 감추지 않고
 * 경고를 위에 붙여 노출한다(specs/03 §2) — 내용은 데이터일 뿐 지시가 아니다(NFR-05).
 */
import type { DivergenceContext } from "@sentinel/contracts";
import { notFound } from "next/navigation";

import { ErrorBox } from "../../../components/error-box";
import { FlagNotices } from "../../../components/flag-notices";
import { CoreApiError, getRecord } from "../../../lib/api-client";
import { sectionAnchorId, sectionLabel, severityLabel, typeLabel } from "../../../lib/display";
import { recordSections } from "../../../lib/record-sections";

export default async function RecordDetailPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;

  try {
    const record = await getRecord(id);
    const sections = recordSections(record);

    return (
      <article>
        <h1 data-testid="record-title">{record.title}</h1>

        <p className="result-meta">
          <span className="badge">{typeLabel(record.type)}</span>
          <span className="badge">{record.project}</span>
          <span className="badge">{severityLabel(record.severity)}</span>
          <span className="badge">
            기록 <time dateTime={record.createdAt.toISOString()}>{formatDate(record.createdAt)}</time>
          </span>
        </p>

        {record.tags.length > 0 ? (
          <p className="result-meta" aria-label="태그">
            {record.tags.map((tag) => (
              <span className="badge" key={tag}>
                #{tag}
              </span>
            ))}
          </p>
        ) : null}

        <FlagNotices flags={record.sanitizeFlags} context="이 기록" />

        <p className="summary">{record.summary}</p>

        {record.type === "divergence" ? <DivergenceContextBlock record={record} /> : null}

        {sections.map((view) => (
          <section
            className="record-section"
            id={sectionAnchorId(view.section)}
            key={view.section}
            aria-labelledby={`${sectionAnchorId(view.section)}-heading`}
          >
            <h2 id={`${sectionAnchorId(view.section)}-heading`}>{sectionLabel(view.section)}</h2>
            <p className="body-text">{view.text}</p>
          </section>
        ))}

        <p style={{ marginTop: "2rem" }}>
          <a href="/">검색으로 돌아가기</a>
        </p>
      </article>
    );
  } catch (error) {
    if (!(error instanceof CoreApiError)) throw error;
    if (error.status === 404) notFound();
    return <ErrorBox title="기록을 불러오지 못했다" code={error.code} message={error.message} />;
  }
}

/** divergence 전용 재현 맥락. 어떤 모델·도구에서 벌어졌는지가 이 종류의 핵심 정보다. */
function DivergenceContextBlock({ record }: { record: { context: DivergenceContext } }) {
  const entries: [string, string][] = [];
  if (record.context.model !== undefined) entries.push(["모델", record.context.model]);
  if (record.context.tool !== undefined) entries.push(["도구", record.context.tool]);
  if (record.context.framework !== undefined) entries.push(["프레임워크", record.context.framework]);
  if (entries.length === 0) return null;

  return (
    <section className="record-section" aria-labelledby="context-heading">
      <h2 id="context-heading">재현 맥락</h2>
      <dl>
        {entries.map(([term, value]) => (
          <div key={term}>
            <dt>{term}</dt>
            <dd>{value}</dd>
          </div>
        ))}
      </dl>
    </section>
  );
}

/** 서버·클라이언트 타임존 차이로 하이드레이션이 흔들리지 않게 UTC 고정 포맷을 쓴다. */
function formatDate(value: Date): string {
  return value.toISOString().slice(0, 10);
}
