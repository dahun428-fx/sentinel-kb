/**
 * 검색 콘솔 폼.
 *
 * 클라이언트 컴포넌트가 아니다. 평범한 `<form method="get">`이라 JS 없이도 동작하고,
 * 상태가 전부 URL에 남아 결과를 공유할 수 있다. 클라이언트 JS가 0이라는 것은
 * "API 키가 클라이언트 번들에 없다"를 구조적으로 보장한다는 뜻이기도 하다(NFR-04).
 */
import type { ConsoleQuery } from "../lib/search-params";

export function SearchForm({
  action,
  query,
  submitLabel,
}: {
  /** 폼이 향하는 경로. 검색 콘솔은 `/`, 답변 화면은 `/answer`. */
  action: string;
  query: ConsoleQuery;
  submitLabel: string;
}) {
  return (
    <form className="search-form" method="get" action={action} role="search">
      <div className="field">
        <label htmlFor="q">질의</label>
        <input
          id="q"
          name="q"
          type="search"
          defaultValue={query.q}
          placeholder="예: 결제 웹훅 타임아웃"
          minLength={2}
          required
          autoComplete="off"
        />
      </div>

      <div className="field-row">
        <div className="field">
          <label htmlFor="type">종류</label>
          <select id="type" name="type" defaultValue={query.type ?? ""}>
            <option value="">전체</option>
            <option value="incident">장애 (incident)</option>
            <option value="divergence">이격 (divergence)</option>
          </select>
        </div>

        <div className="field">
          <label htmlFor="project">프로젝트</label>
          <input
            id="project"
            name="project"
            type="text"
            defaultValue={query.project ?? ""}
            placeholder="전체"
            autoComplete="off"
          />
        </div>
      </div>

      <button type="submit">{submitLabel}</button>
    </form>
  );
}
