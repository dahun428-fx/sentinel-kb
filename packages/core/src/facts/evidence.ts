/**
 * 본문에서 **기계적으로 식별 가능한** 스니펫만 원문 그대로 뽑는다.
 * 출처: specs/08-publishing.md §3("인용 후보: 에러 원문·명령어 스니펫 — 원문 그대로, flags 확인 후").
 *
 * ## 허용목록이지 차단목록이 아니다
 *
 * "산문에서 시크릿·인젝션을 걸러 낸다"는 접근은 차단목록이고, 차단목록은 항상 한 칸 뒤에서
 * 따라간다 — T-004가 여덟 라운드에 걸쳐, T-040이 일본어 축에서 확인한 그대로다.
 * 그래서 방향을 뒤집는다. **미리 정한 형상에 걸린 구간만 통과시킨다.**
 * 통과 자격은 "위험하지 않다"가 아니라 "명령어/에러/경로/수치/버전/URL로 보인다"이고,
 * 자연어 문장은 어떤 언어로 쓰여도 그 형상이 아니다. 방어가 언어 수에 의존하지 않는다.
 *
 * 각 규칙은 시작 위치를 낸 뒤 `sliceAscii`로 **인쇄 가능 ASCII 런**까지만 잘라낸다.
 * 한국어 산문 한복판에 박힌 `pnpm install --force로 재설치` 같은 표기에서 명령어가
 * 정확히 `pnpm install --force`에서 끝나는 것이 이 절단 규칙 덕이다.
 */
import type { ChunkSection } from "@sentinel/contracts";

import { compareStrings } from "./order.js";
import { isPublishableSnippet } from "./screen.js";
import type { EvidenceKind } from "./types.js";

/** 스니펫 하나의 상한. 이보다 긴 것은 스니펫이 아니라 문단이다. */
export const MAX_SNIPPET_CHARS = 300;

/** 한 (레코드, 섹션)에서 뽑힌 원시 후보. */
export interface RawSnippet {
  readonly kind: EvidenceKind;
  readonly text: string;
  readonly section: ChunkSection;
  readonly recordId: string;
  /** 본문 내 시작 위치. 정렬 안정성에만 쓰고 팩트 팩에는 싣지 않는다. */
  readonly offset: number;
}

interface Hit {
  readonly start: number;
  readonly text: string;
}

// ---------------------------------------------------------------- 절단 유틸

const PRINTABLE_ASCII_CHAR_RE = /[\x20-\x7E\t]/;

/**
 * `start`부터 인쇄 가능 ASCII가 이어지는 만큼 잘라낸다.
 * 문장 구분자(`. `·`, `·`; `)에서도 멈춘다 — 영어로만 쓰인 본문에서 명령어 규칙이
 * 문단 전체를 삼키는 것을 막는 유일한 장치다.
 */
function sliceAscii(text: string, start: number, maxChars: number): string {
  let end = start;
  const limit = Math.min(text.length, start + maxChars);
  while (end < limit) {
    const char = text.charAt(end);
    if (!PRINTABLE_ASCII_CHAR_RE.test(char)) break;
    if (
      (char === "." || char === "," || char === ";") &&
      end + 1 < text.length &&
      text.charAt(end + 1) === " "
    ) {
      break;
    }
    end += 1;
  }
  return text.slice(start, end);
}

/** 꼬리에 붙은 따옴표·구두점·공백을 턴다. 원문 인용의 경계를 정하는 것이지 내용을 고치는 게 아니다. */
const TRAILING_NOISE_RE = /[\s'"`.,;:)\]}>+&|]+$/;
/** 머리에 붙은 여는 따옴표·괄호도 같은 이유로 턴다. */
const LEADING_NOISE_RE = /^[\s'"`([{<]+/;

function trimSnippet(raw: string): string {
  return raw.replace(LEADING_NOISE_RE, "").replace(TRAILING_NOISE_RE, "");
}

// ---------------------------------------------------------------- 에러 원문

/**
 * errno·컴파일러 코드는 **허용목록**으로만 인정한다.
 * `E[A-Z]{3,}` 같은 형상 규칙을 쓰면 `EXAMPLE`·`EXPECTED` 같은 평범한 대문자 단어가
 * 에러 코드로 둔갑한다. 목록은 늘리면 되지만 오탐은 발행물에 남는다.
 */
const ERRNO_CODES = new Set([
  "EACCES",
  "EADDRINUSE",
  "EAI_AGAIN",
  "ECONNREFUSED",
  "ECONNRESET",
  "EEXIST",
  "EHOSTUNREACH",
  "EISDIR",
  "EMFILE",
  "ENETUNREACH",
  "ENOENT",
  "ENOMEM",
  "ENOSPC",
  "ENOTDIR",
  "ENOTFOUND",
  "EPERM",
  "EPIPE",
  "EPROTO",
  "ETIMEDOUT",
]);

const ERRNO_CANDIDATE_RE = /\b[A-Z][A-Z_]{2,15}\b/g;
/** `SomethingError` · `SomethingException` · 맨 `Error`. 대소문자를 구분한다. */
const ERROR_CLASS_RE = /\b(?:[A-Za-z0-9]+)?(?:Error|Exception)\b/g;
/** tsc 진단 코드. */
const TS_DIAGNOSTIC_RE = /\bTS\d{4}\b/g;
/** 따옴표로 감싼 구간. 그 안에 에러 신호가 있을 때만 인정한다. */
const QUOTED_RE = /'([^'\n]{6,300})'|"([^"\n]{6,300})"|`([^`\n]{6,300})`/g;
/** 따옴표 안이 "에러 원문"이라고 볼 근거. 하나라도 없으면 그냥 인용부호일 뿐이다. */
const ERROR_SIGNAL_RE =
  /(?:Error|Exception|error|failed|Failed|FAIL|cannot|Cannot|could not|Could not|denied|refused|timed out|not found|Unexpected|Invalid|TS\d{4})/;

/** 에러 후보의 최소 길이. `Error` 다섯 글자짜리 단독 매치는 정보가 아니다. */
const MIN_ERROR_CHARS = 6;

function collectErrors(text: string): Hit[] {
  const hits: Hit[] = [];

  for (const match of text.matchAll(QUOTED_RE)) {
    const inner = match[1] ?? match[2] ?? match[3];
    if (inner === undefined) continue;
    if (!ERROR_SIGNAL_RE.test(inner)) continue;
    // 여는 따옴표 한 글자 뒤가 내용의 시작이다.
    hits.push({ start: (match.index ?? 0) + 1, text: trimSnippet(inner) });
  }

  for (const match of text.matchAll(ERROR_CLASS_RE)) {
    const start = match.index ?? 0;
    hits.push({ start, text: trimSnippet(sliceAscii(text, start, MAX_SNIPPET_CHARS)) });
  }

  for (const match of text.matchAll(TS_DIAGNOSTIC_RE)) {
    const start = match.index ?? 0;
    hits.push({ start, text: trimSnippet(sliceAscii(text, start, MAX_SNIPPET_CHARS)) });
  }

  for (const match of text.matchAll(ERRNO_CANDIDATE_RE)) {
    const token = match[0];
    if (token === undefined || !ERRNO_CODES.has(token)) continue;
    const start = match.index ?? 0;
    hits.push({ start, text: trimSnippet(sliceAscii(text, start, MAX_SNIPPET_CHARS)) });
  }

  return hits.filter((hit) => hit.text.length >= MIN_ERROR_CHARS);
}

// ---------------------------------------------------------------- 명령어

/**
 * 명령어로 인정하는 실행 파일 이름. 허용목록인 이유는 위 서두와 같다.
 * `export`는 일부러 뺐다 — `export AWS_SECRET_ACCESS_KEY=...`가 명령어 후보가 되는 것보다
 * 그 형태를 아예 인용 대상에서 지우는 편이 낫다(스크린이 잡더라도 후보로 만들 이유가 없다).
 */
const COMMAND_TOOLS = [
  "aws",
  "cargo",
  "curl",
  "dig",
  "docker",
  "docker-compose",
  "gcloud",
  "gh",
  "git",
  "helm",
  "kubectl",
  "mongosh",
  "nc",
  "nslookup",
  "openssl",
  "pnpm",
  "psql",
  "npm",
  "npx",
  "node",
  "ping",
  "prettier",
  "redis-cli",
  "systemctl",
  "terraform",
  "tsc",
  "tsx",
  "vitest",
  "yarn",
] as const;

const COMMAND_RE = new RegExp(
  `(?<![A-Za-z0-9._/-])(?:${COMMAND_TOOLS.join("|")})(?![A-Za-z0-9._-])`,
  "g",
);

/**
 * 첫 인자는 서브커맨드·플래그·경로 중 하나여야 한다.
 *
 * 이 조건이 없으면 `pnpm 10에서만 재현된다`가 명령어 `pnpm 10`이 된다 — 실제로는
 * **버전 문자열**이고, 그런 항목이 인용 후보에 섞이면 T-031이 본문에 실행 불가능한
 * 명령을 적는다. 숫자로 시작하는 첫 인자를 거절하면 버전 규칙 쪽으로 정확히 넘어간다.
 */
const COMMAND_FIRST_ARG_RE = /^[A-Za-z@._/-]/;

function collectCommands(text: string): Hit[] {
  const hits: Hit[] = [];
  for (const match of text.matchAll(COMMAND_RE)) {
    const start = match.index ?? 0;
    const sliced = trimSnippet(sliceAscii(text, start, MAX_SNIPPET_CHARS));
    // 인자가 하나도 없는 도구 이름 단독(`pnpm`)은 명령어가 아니라 단어다.
    const space = sliced.indexOf(" ");
    if (space < 0) continue;
    if (!COMMAND_FIRST_ARG_RE.test(sliced.slice(space + 1))) continue;
    hits.push({ start, text: sliced });
  }
  return hits;
}

// ---------------------------------------------------------------- 파일 경로

/** 디렉터리 구분자가 있는 경로. `https://host/a/b.ts`의 내부는 룩비하인드가 막는다. */
const NESTED_PATH_RE = /(?<![A-Za-z0-9._/-])(?:[A-Za-z0-9._-]+\/)+[A-Za-z0-9._-]*[A-Za-z0-9_-]/g;
/** 구분자 없이 확장자만 있는 파일 이름. 확장자는 허용목록이다. */
const FILE_NAME_RE =
  /(?<![A-Za-z0-9._/-])[A-Za-z0-9._-]+\.(?:ts|tsx|js|mjs|cjs|json|ya?ml|toml|md|sh|env|lock|sql|ini|conf)(?![A-Za-z0-9-])/g;

/** 경로로 보이려면 확장자나 두 단계 이상의 구분자가 있어야 한다. `a/b` 같은 산문 표기는 뺀다. */
const PATH_QUALIFIER_RE = /\.[A-Za-z0-9]{1,10}$|^(?:[A-Za-z0-9._-]+\/){2,}/;

function collectPaths(text: string): Hit[] {
  const hits: Hit[] = [];
  for (const match of text.matchAll(NESTED_PATH_RE)) {
    const raw = match[0];
    if (raw === undefined) continue;
    if (!PATH_QUALIFIER_RE.test(raw)) continue;
    hits.push({ start: match.index ?? 0, text: raw });
  }
  for (const match of text.matchAll(FILE_NAME_RE)) {
    const raw = match[0];
    if (raw === undefined) continue;
    hits.push({ start: match.index ?? 0, text: raw });
  }
  return hits;
}

// ---------------------------------------------------------------- 수치 + 단위

/**
 * 단위 어휘는 **닫힌 집합**이다. 그래서 이 종류만 ASCII 요구를 면제할 수 있다 —
 * `<숫자><단위>` 밖의 문자가 스니펫에 들어올 구조적 여지가 없다.
 */
const METRIC_UNITS = [
  "ms",
  "µs",
  "us",
  "ns",
  "sec",
  "s",
  "KB",
  "MB",
  "GB",
  "TB",
  "KiB",
  "MiB",
  "GiB",
  "rps",
  "qps",
  "%",
  "초",
  "분",
  "시간",
  "일",
  "주",
  "개월",
  "년",
  "건",
  "회",
  "배",
  "명",
  "개",
] as const;

/**
 * 앞쪽 룩비하인드에 `=`를 넣는다. `k=60일 때`는 "60일"이 아니라 대입 뒤에 붙은 조사이고,
 * 그런 항목이 팩트로 실리면 본문에 존재하지 않는 기간이 등장한다 — §0-2가 막으려는 바로 그 사고다.
 *
 * 뒤쪽 룩어헤드에 한글을 넣지 않는다. 한국어 본문에서 단위 뒤에는 조사가 거의 항상 붙어
 * (`30초에서`·`5000 ms로`) 한글을 배제하면 규칙이 통째로 무발동한다.
 * 단위 어휘가 긴 것부터 오도록 배열돼 있어 `ms`가 `msec`의 앞부분만 삼키는 일은 없다.
 */
const METRIC_RE = new RegExp(
  `(?<![A-Za-z0-9.=])\\d{1,12}(?:\\.\\d{1,6})?\\s?(?:${METRIC_UNITS.join("|")})(?![A-Za-z0-9])`,
  "g",
);

function collectMetrics(text: string): Hit[] {
  const hits: Hit[] = [];
  for (const match of text.matchAll(METRIC_RE)) {
    const raw = match[0];
    if (raw === undefined) continue;
    hits.push({ start: match.index ?? 0, text: raw });
  }
  return hits;
}

// ---------------------------------------------------------------- 버전 문자열

/**
 * `0.62` 같은 평범한 소수를 버전으로 오인하지 않도록 셋 중 하나를 요구한다:
 * `v` 접두사, 세 자리 이상 구성요소, 또는 앞에 붙은 제품 이름.
 */
const SEMVER_RE = /(?<![A-Za-z0-9.-])v\d+\.\d+(?:\.\d+)?(?:-[0-9A-Za-z.]+)?(?![A-Za-z0-9.-])/g;
const TRIPLE_VERSION_RE = /(?<![A-Za-z0-9.-])\d+\.\d+\.\d+(?:-[0-9A-Za-z.]+)?(?![A-Za-z0-9.-])/g;
const NAMED_VERSION_RE =
  /\b(?:node|pnpm|npm|yarn|python|typescript|ts|mongodb|mongo|docker|react|next|vitest|zod|eslint)\s+v?\d+(?:\.\d+)*(?:\.x)?\b/gi;

function collectVersions(text: string): Hit[] {
  const hits: Hit[] = [];
  for (const pattern of [SEMVER_RE, TRIPLE_VERSION_RE, NAMED_VERSION_RE]) {
    for (const match of text.matchAll(pattern)) {
      const raw = match[0];
      if (raw === undefined) continue;
      hits.push({ start: match.index ?? 0, text: raw });
    }
  }
  return hits;
}

// ---------------------------------------------------------------- URL

/**
 * `http(s)` URL만. **쿼리스트링·프래그먼트·userinfo가 있으면 통째로 버린다** —
 * 토큰이 URL로 새는 전형적 경로이고(`?api_key=`·`#access_token=`), 잘라서 살리면
 * "원문 그대로"가 깨진다. 스크린이 아니라 여기서 미리 떨어뜨리는 이유는 후보 목록에
 * 애초에 올리지 않기 위해서다.
 */
const URL_RE = /https?:\/\/[^\s<>"'`)\]}]+/g;

function collectUrls(text: string): Hit[] {
  const hits: Hit[] = [];
  for (const match of text.matchAll(URL_RE)) {
    const raw = match[0];
    if (raw === undefined) continue;
    const trimmed = trimSnippet(raw);
    if (trimmed.includes("@") || trimmed.includes("?") || trimmed.includes("#")) continue;
    hits.push({ start: match.index ?? 0, text: trimmed });
  }
  return hits;
}

// ---------------------------------------------------------------- 조립

const RULES: readonly { kind: EvidenceKind; collect: (text: string) => Hit[] }[] = [
  { kind: "error", collect: collectErrors },
  { kind: "command", collect: collectCommands },
  { kind: "path", collect: collectPaths },
  { kind: "metric", collect: collectMetrics },
  { kind: "version", collect: collectVersions },
  { kind: "url", collect: collectUrls },
];

/** `metric`만 비ASCII 단위(초·건·회)를 허용한다. 근거는 `METRIC_UNITS` 주석. */
function allowsNonAscii(kind: EvidenceKind): boolean {
  return kind === "metric";
}

/**
 * 한 섹션에서 후보를 뽑아 스크린을 통과한 것만 남긴다.
 *
 * 포함 관계에 있는 후보는 **긴 쪽만 남긴다.** `... timed out after 5000 ms` 안의
 * `5000 ms`를 따로 세면 같은 사실이 두 번 계산되고, 밀도 지표(§0-2)가 부풀려진다.
 */
export function extractSnippets(
  recordId: string,
  section: ChunkSection,
  text: string,
): RawSnippet[] {
  const collected: RawSnippet[] = [];
  for (const rule of RULES) {
    for (const hit of rule.collect(text)) {
      if (hit.text.length === 0 || hit.text.length > MAX_SNIPPET_CHARS) continue;
      if (!isPublishableSnippet(hit.text, allowsNonAscii(rule.kind))) continue;
      collected.push({
        kind: rule.kind,
        text: hit.text,
        section,
        recordId,
        offset: hit.start,
      });
    }
  }

  const unique = dedupeExact(collected);
  return unique
    .filter((candidate) => !unique.some((other) => strictlyContains(other, candidate)))
    .sort(compareRawSnippets);
}

/**
 * 같은 (종류, 텍스트)는 하나로 줄인다. 여기서 정렬하지 않는 이유는 **정렬 지점을 하나로
 * 유지하기 위해서**다 — 두 곳에서 정렬하면 한 곳을 지워도 다른 곳이 결과를 덮어
 * "정렬이 사라졌다"는 사실이 어떤 테스트에도 드러나지 않는다.
 * 남길 대표를 고르는 데 순서가 필요하지도 않다: `offset`은 산출물에 실리지 않는다.
 */
function dedupeExact(snippets: readonly RawSnippet[]): RawSnippet[] {
  const seen = new Map<string, RawSnippet>();
  for (const snippet of snippets) {
    const key = `${snippet.kind}\u0000${snippet.text}`;
    if (!seen.has(key)) seen.set(key, snippet);
  }
  return [...seen.values()];
}

function strictlyContains(outer: RawSnippet, inner: RawSnippet): boolean {
  if (outer === inner) return false;
  if (outer.text === inner.text) return false;
  return outer.text.includes(inner.text);
}

/** 전순서. 같은 입력이 어떤 순서로 들어와도 같은 배열이 나오게 하는 유일한 근거다. */
function compareRawSnippets(a: RawSnippet, b: RawSnippet): number {
  return (
    compareStrings(a.recordId, b.recordId) ||
    compareStrings(a.section, b.section) ||
    compareStrings(a.kind, b.kind) ||
    a.offset - b.offset ||
    compareStrings(a.text, b.text)
  );
}
