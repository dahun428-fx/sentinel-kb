/**
 * 검색 콘솔의 URL 상태(`?q=&type=&project=`) 해석.
 *
 * 상태를 URL에 두는 이유: 서버 컴포넌트만으로 검색 경로가 완성되고(T-023 Scope
 * "서버 컴포넌트 우선"), 결과 링크를 그대로 공유·북마크할 수 있으며, 폼이
 * JS 없이 `<form method="get">`으로 동작해 접근성 기본값이 좋아진다.
 */
import { RecordType } from "@sentinel/contracts";

/** Next.js가 넘겨주는 `searchParams`의 모양. */
export type RawSearchParams = Record<string, string | string[] | undefined>;

/** 해석된 콘솔 질의. 값이 없거나 계약에 없는 값이면 필드가 빠진다. */
export interface ConsoleQuery {
  readonly q: string;
  readonly type?: RecordType;
  readonly project?: string;
}

/** contracts의 `SearchRequest.query`가 요구하는 최소 길이. 그보다 짧으면 부르지 않는다. */
export const MIN_QUERY_LENGTH = 2;

function firstValue(raw: string | string[] | undefined): string | undefined {
  const value = Array.isArray(raw) ? raw[0] : raw;
  const trimmed = value?.trim();
  return trimmed === undefined || trimmed === "" ? undefined : trimmed;
}

/**
 * 잘못된 `type`은 400으로 튕기지 않고 **무시한다**.
 * 사용자가 URL을 손댔다고 콘솔 전체가 에러 화면이 될 이유는 없다 —
 * 필터가 안 걸린 결과를 보여주는 편이 읽기 UI로서 옳다.
 */
export function parseConsoleQuery(params: RawSearchParams): ConsoleQuery {
  const q = firstValue(params["q"]) ?? "";
  const typeCandidate = firstValue(params["type"]);
  const parsedType = typeCandidate === undefined ? undefined : RecordType.safeParse(typeCandidate);
  const project = firstValue(params["project"]);

  return {
    q,
    ...(parsedType?.success === true ? { type: parsedType.data } : {}),
    ...(project === undefined ? {} : { project }),
  };
}

/** core-api를 부를 만한 질의인지. 짧은 입력으로 검색을 때리지 않는다. */
export function isSearchable(query: ConsoleQuery): boolean {
  return query.q.length >= MIN_QUERY_LENGTH;
}

/** 같은 질의를 다른 화면(검색 ↔ 답변)으로 옮길 때 쓰는 링크. */
export function consoleHref(basePath: string, query: ConsoleQuery): string {
  const search = new URLSearchParams();
  if (query.q !== "") search.set("q", query.q);
  if (query.type !== undefined) search.set("type", query.type);
  if (query.project !== undefined) search.set("project", query.project);
  const suffix = search.toString();
  return suffix === "" ? basePath : `${basePath}?${suffix}`;
}
