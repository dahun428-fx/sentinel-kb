/**
 * Atlas Search / Vector Search 인덱스 부트스트랩. 출처: specs/02-data-model.md §인덱스, T-010.
 *
 * **정의는 코드가 아니라 `./search-indexes/*.json`에 있다** (T-010 Acceptance 2).
 * 이 모듈은 그 JSON을 읽어 env 값(`EMBEDDING_DIM`)만 주입하고, 멱등하게 적용하고,
 * READY가 될 때까지 기다리는 일만 한다. 정의를 바꾸려면 JSON을 고쳐라.
 *
 * `indexes.ts`(일반 B-tree 인덱스, `pnpm db:indexes`)와는 **다른 인덱스 시스템**이다.
 * 둘 사이에 실행 순서 의존은 없다 — `createSearchIndex`는 컬렉션이 실재해야 하는데
 * (실측: `NamespaceNotFound`), 여기서 직접 컬렉션 존재를 보장하므로 `db:indexes`를
 * 먼저 돌릴 필요가 없다.
 *
 * 로컬 검증: `mongodb/mongodb-atlas-local` 컨테이너가 `$vectorSearch`·`$search`를 그대로
 * 지원한다(specs/05 정정). `mongodb-memory-server`로는 생성 자체가 불가능하다.
 */
import { readFileSync } from "node:fs";

import type { Document } from "mongodb";

import { readEmbeddingDim } from "../embedder/config.js";

/** 검색 인덱스 계층 실패 원인 코드. 호출자가 exit code·재시도 여부를 분기하는 기준이다. */
export const SEARCH_INDEX_ERROR_CODES = {
  /** JSON 정의가 기대한 형상이 아님 — 정의 파일 수정 실수. */
  DEFINITION_INVALID: "SEARCH_INDEX_DEFINITION_INVALID",
  /** 이미 존재하는 `vec_idx`의 numDimensions가 `EMBEDDING_DIM`과 다름. */
  DIM_MISMATCH: "SEARCH_INDEX_DIM_MISMATCH",
  /** 서버가 검색 인덱스를 지원하지 않음(평범한 mongod·memory-server). */
  UNSUPPORTED: "SEARCH_INDEX_UNSUPPORTED",
  /** 인덱스 빌드가 FAILED로 끝남 — 재시도 대상이 아니다. */
  BUILD_FAILED: "SEARCH_INDEX_BUILD_FAILED",
  /** 타임아웃까지 READY가 되지 않음 — 더 기다리면 될 수도 있다. */
  NOT_READY: "SEARCH_INDEX_NOT_READY",
} as const;

export type SearchIndexErrorCode =
  (typeof SEARCH_INDEX_ERROR_CODES)[keyof typeof SEARCH_INDEX_ERROR_CODES];

/** 이 계층의 모든 실패를 코드로 식별 가능하게 감싼다 (`DbConnectionError`와 같은 규약). */
export class SearchIndexError extends Error {
  readonly code: SearchIndexErrorCode;

  constructor(code: SearchIndexErrorCode, message: string, cause?: unknown) {
    super(message, cause === undefined ? undefined : { cause });
    this.name = "SearchIndexError";
    this.code = code;
  }
}

/**
 * JSON 정의 안에서 `EMBEDDING_DIM`이 들어갈 자리를 표시하는 토큰.
 *
 * 차원은 모델이 정하는 값이라 JSON에 하드코딩할 수 없다(NFR-06, specs/03 §6).
 * 그렇다고 필드를 빼 버리면 정의 파일만 읽어서는 벡터 인덱스의 형상을 알 수 없다 —
 * 자리는 JSON에 남기고 값만 env에서 주입한다.
 */
export const EMBEDDING_DIM_PLACEHOLDER = "${EMBEDDING_DIM}";

/** 정의 파일 목록. 여기 없는 파일은 적용되지 않는다. */
export const SEARCH_INDEX_DEFINITION_FILES = ["vec_idx.json", "text_idx.json"] as const;

/** Atlas가 구분하는 검색 인덱스 종류. specs/02가 요구하는 둘뿐이다. */
export const SEARCH_INDEX_TYPES = ["vectorSearch", "search"] as const;

export type SearchIndexType = (typeof SEARCH_INDEX_TYPES)[number];

/** JSON 파일 하나의 내용. `definition`은 placeholder가 살아 있는 원본이다. */
export interface SearchIndexDefinitionFile {
  readonly file: string;
  readonly name: string;
  readonly collection: string;
  readonly type: SearchIndexType;
  readonly definition: Document;
}

/** env 값이 주입되어 그대로 `createSearchIndex`에 넘길 수 있는 상태. */
export interface SearchIndexPlan {
  readonly name: string;
  readonly collection: string;
  readonly type: SearchIndexType;
  readonly definition: Document;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isSearchIndexType(value: unknown): value is SearchIndexType {
  return typeof value === "string" && (SEARCH_INDEX_TYPES as readonly string[]).includes(value);
}

function parseDefinitionFile(file: string, raw: string): SearchIndexDefinitionFile {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch (cause) {
    throw new SearchIndexError(
      SEARCH_INDEX_ERROR_CODES.DEFINITION_INVALID,
      `${file}이 올바른 JSON이 아니다.`,
      cause,
    );
  }

  if (!isRecord(parsed)) {
    throw new SearchIndexError(
      SEARCH_INDEX_ERROR_CODES.DEFINITION_INVALID,
      `${file}의 최상위가 객체가 아니다.`,
    );
  }

  const { name, collection, type, definition } = parsed;
  if (typeof name !== "string" || name === "") {
    throw new SearchIndexError(
      SEARCH_INDEX_ERROR_CODES.DEFINITION_INVALID,
      `${file}에 문자열 name이 없다.`,
    );
  }
  if (typeof collection !== "string" || collection === "") {
    throw new SearchIndexError(
      SEARCH_INDEX_ERROR_CODES.DEFINITION_INVALID,
      `${file}에 문자열 collection이 없다.`,
    );
  }
  if (!isSearchIndexType(type)) {
    throw new SearchIndexError(
      SEARCH_INDEX_ERROR_CODES.DEFINITION_INVALID,
      `${file}의 type이 ${SEARCH_INDEX_TYPES.join(" | ")} 중 하나가 아니다(받은 값: ${String(type)}).`,
    );
  }
  if (!isRecord(definition)) {
    throw new SearchIndexError(
      SEARCH_INDEX_ERROR_CODES.DEFINITION_INVALID,
      `${file}에 객체 definition이 없다.`,
    );
  }

  return { file, name, collection, type, definition };
}

/** 정의 파일을 있는 그대로 읽는다 — placeholder는 치환하지 않는다. */
export function loadSearchIndexDefinitions(): readonly SearchIndexDefinitionFile[] {
  return SEARCH_INDEX_DEFINITION_FILES.map((file) => {
    const url = new URL(`./search-indexes/${file}`, import.meta.url);
    return parseDefinitionFile(file, readFileSync(url, "utf8"));
  });
}

/** placeholder 문자열을 실제 값으로 바꾼 깊은 복사본을 만든다. */
function substitute(value: unknown, dim: number): unknown {
  if (value === EMBEDDING_DIM_PLACEHOLDER) return dim;
  if (Array.isArray(value)) return value.map((item) => substitute(item, dim));
  if (isRecord(value)) {
    return Object.fromEntries(
      Object.entries(value).map(([key, item]) => [key, substitute(item, dim)]),
    );
  }
  return value;
}

/**
 * `vectorSearch` 정의에서 벡터 필드의 numDimensions를 꺼낸다.
 * 정의 파일 검증과 **이미 존재하는 인덱스**의 차원 대조가 같은 함수를 쓴다 —
 * 읽는 방식이 갈리면 대조가 헛돈다.
 */
export function readVectorNumDimensions(definition: Document): number | undefined {
  const fields: unknown = definition["fields"];
  if (!Array.isArray(fields)) return undefined;
  for (const field of fields) {
    if (!isRecord(field) || field["type"] !== "vector") continue;
    const dim: unknown = field["numDimensions"];
    if (typeof dim === "number") return dim;
  }
  return undefined;
}

/**
 * 정의 파일 + `EMBEDDING_DIM` → 적용 가능한 계획.
 * 치환 후에도 벡터 인덱스의 numDimensions가 숫자가 아니면 placeholder 오타이므로 즉시 실패한다.
 */
export function buildSearchIndexPlans(dim: number): readonly SearchIndexPlan[] {
  return loadSearchIndexDefinitions().map((source) => {
    const definition = substitute(source.definition, dim) as Document;

    if (source.type === "vectorSearch") {
      const applied = readVectorNumDimensions(definition);
      if (applied !== dim) {
        throw new SearchIndexError(
          SEARCH_INDEX_ERROR_CODES.DEFINITION_INVALID,
          `${source.file}의 벡터 필드에 numDimensions "${EMBEDDING_DIM_PLACEHOLDER}"가 없다 — ` +
            `EMBEDDING_DIM(${dim})을 주입할 자리를 찾지 못했다(치환 결과: ${String(applied)}).`,
        );
      }
    }

    return { name: source.name, collection: source.collection, type: source.type, definition };
  });
}

/* ------------------------------------------------------------------ *
 * 적용
 * ------------------------------------------------------------------ */

/**
 * 이 모듈이 실제로 쓰는 드라이버 표면만 추린 구조적 타입.
 * `Db`/`Collection`을 그대로 받으면 단위 테스트가 mongodb 전체를 흉내내야 하고,
 * 그러면 멱등 가드 같은 로직은 컨테이너 없이는 영영 검증할 수 없다.
 */
export interface SearchIndexCursorLike {
  toArray(): Promise<Document[]>;
}

export interface SearchIndexCollectionLike {
  listSearchIndexes(name?: string): SearchIndexCursorLike;
  createSearchIndex(description: {
    name: string;
    type: SearchIndexType;
    definition: Document;
  }): Promise<string>;
}

export interface SearchIndexDbLike {
  listCollections(filter: Document): SearchIndexCursorLike;
  createCollection(name: string): Promise<unknown>;
  collection(name: string): SearchIndexCollectionLike;
}

/** `createSearchIndex`가 어떤 판단을 내렸는지 CLI·테스트가 확인하는 지점. */
export interface SearchIndexApplyResult {
  readonly name: string;
  readonly collection: string;
  readonly type: SearchIndexType;
  /** `created` = 이번에 만들었다 / `existing` = 이미 있어 건드리지 않았다. */
  readonly action: "created" | "existing";
}

/** 서버가 검색 인덱스 명령 자체를 모를 때 나는 에러를 식별한다. */
function isUnsupportedError(cause: unknown): boolean {
  const message = cause instanceof Error ? cause.message : String(cause);
  return /command not (found|supported)|not supported|CommandNotSupported|Unrecognized/i.test(
    message,
  );
}

/** MongoDB `NamespaceExists`. 동시에 두 프로세스가 부트스트랩해도 깨지지 않게 흡수한다. */
const NAMESPACE_EXISTS = 48;

function hasErrorCode(cause: unknown, code: number): boolean {
  return isRecord(cause) && cause["code"] === code;
}

/**
 * `createSearchIndex`는 컬렉션이 없으면 `NamespaceNotFound`로 죽는다(실측).
 * 빈 컬렉션을 미리 만들어 둔다 — 부트스트랩이 시드보다 먼저 도는 것이 정상 순서다.
 */
async function ensureCollection(db: SearchIndexDbLike, name: string): Promise<void> {
  const existing = await db.listCollections({ name }).toArray();
  if (existing.length > 0) return;
  try {
    await db.createCollection(name);
  } catch (cause) {
    if (!hasErrorCode(cause, NAMESPACE_EXISTS)) throw cause;
  }
}

interface ExistingSearchIndex {
  readonly name: string;
  readonly status?: string;
  readonly queryable?: boolean;
  readonly latestDefinition?: Document;
}

async function findExisting(
  collection: SearchIndexCollectionLike,
  name: string,
): Promise<ExistingSearchIndex | undefined> {
  let all: Document[];
  try {
    all = await collection.listSearchIndexes(name).toArray();
  } catch (cause) {
    if (isUnsupportedError(cause)) {
      throw new SearchIndexError(
        SEARCH_INDEX_ERROR_CODES.UNSUPPORTED,
        "이 서버는 Atlas 검색 인덱스를 지원하지 않는다. Atlas 클러스터나 " +
          "mongodb/mongodb-atlas-local 컨테이너에 연결하라(specs/05).",
        cause,
      );
    }
    throw cause;
  }
  // 드라이버가 name 필터를 서버에 넘기지만, 서버 구현에 기대지 않고 한 번 더 좁힌다.
  return all.find((index) => index["name"] === name) as ExistingSearchIndex | undefined;
}

/**
 * 이미 존재하는 `vec_idx`의 차원이 `EMBEDDING_DIM`과 다르면 **명확한 에러로 멈춘다**.
 *
 * 조용히 재생성하지 않는 이유: 차원이 바뀌었다는 것은 임베딩 세대가 바뀌었다는 뜻이고,
 * 그건 specs/02 §마이그레이션 규칙(신규 버전 삽입 → 검색 필터 스왑 → 구버전 삭제)을
 * 밟아야 하는 사건이다. 인덱스만 갈아엎으면 구버전 청크가 새 인덱스에서 통째로
 * 검색 불가가 되고 그 사실이 아무 데도 드러나지 않는다.
 *
 * embedder는 **응답 벡터의 차원**만 검사한다(T-006 F-4). 인덱스 정의와 env의 대조는
 * 이 함수가 유일한 지점이다.
 */
function assertDimMatches(plan: SearchIndexPlan, existing: ExistingSearchIndex, dim: number): void {
  if (plan.type !== "vectorSearch") return;

  const actual =
    existing.latestDefinition === undefined
      ? undefined
      : readVectorNumDimensions(existing.latestDefinition);

  if (actual === dim) return;

  throw new SearchIndexError(
    SEARCH_INDEX_ERROR_CODES.DIM_MISMATCH,
    `${plan.collection}.${plan.name}의 numDimensions(${String(actual)})가 ` +
      `EMBEDDING_DIM(${dim})과 다르다. 자동으로 재생성하지 않는다 — ` +
      `임베딩 모델을 바꿨다면 specs/02 §마이그레이션 규칙(EMBEDDING_VERSION 증가 → ` +
      `신규 버전으로 재임베딩 삽입 → 검색 필터 스왑 → 구버전 청크 삭제)을 밟아라.`,
  );
}

export interface EnsureSearchIndexesOptions {
  /** 명시하지 않으면 `EMBEDDING_DIM`에서 읽는다. */
  readonly dim?: number;
  readonly env?: NodeJS.ProcessEnv;
}

/**
 * 정의 JSON을 멱등하게 적용한다 (T-010 Acceptance 1).
 *
 * **이미 있으면 만들지 않는다.** 실제 Atlas의 `createSearchIndex`는 같은 이름이 있으면
 * `IndexAlreadyExists`로 죽는다 — 2회 실행이 배포를 막지 않으려면 이 가드가 필수다.
 * (atlas-local 컨테이너는 중복 생성을 조용히 삼키므로 컨테이너만으로는 이 가드의
 *  부재를 잡지 못한다. `search-indexes.spec.ts`가 스텁으로 잠근다.)
 *
 * READY까지 기다리지는 않는다 — `waitForSearchIndexesReady`가 그 몫이다.
 */
export async function ensureSearchIndexes(
  db: SearchIndexDbLike,
  options: EnsureSearchIndexesOptions = {},
): Promise<SearchIndexApplyResult[]> {
  const dim = options.dim ?? readEmbeddingDim(options.env ?? process.env);
  const plans = buildSearchIndexPlans(dim);
  const results: SearchIndexApplyResult[] = [];

  for (const plan of plans) {
    await ensureCollection(db, plan.collection);
    const collection = db.collection(plan.collection);
    const existing = await findExisting(collection, plan.name);

    if (existing !== undefined) {
      assertDimMatches(plan, existing, dim);
      results.push({
        name: plan.name,
        collection: plan.collection,
        type: plan.type,
        action: "existing",
      });
      continue;
    }

    await collection.createSearchIndex({
      name: plan.name,
      type: plan.type,
      definition: plan.definition,
    });
    results.push({
      name: plan.name,
      collection: plan.collection,
      type: plan.type,
      action: "created",
    });
  }

  return results;
}

/* ------------------------------------------------------------------ *
 * READY 폴링
 * ------------------------------------------------------------------ */

/**
 * 인덱스 빌드 대기 상한(ms). 생성 직후 상태는 PENDING이고, 그때 쿼리하면
 * `Index vec_idx not initialized`로 실패한다(실측). 로컬은 1초대지만 실 Atlas의
 * 대량 컬렉션은 분 단위라 넉넉히 잡는다.
 */
export const DEFAULT_SEARCH_INDEX_READY_TIMEOUT_MS = 300_000;

/** 폴링 간격(ms). 너무 짧으면 Atlas Admin 경로에 불필요한 부하가 간다. */
export const DEFAULT_SEARCH_INDEX_POLL_INTERVAL_MS = 2_000;

export interface SearchIndexWaitConfig {
  readonly readyTimeoutMs: number;
  readonly pollIntervalMs: number;
}

/** specs/03 §6: 튜닝 파라미터는 코드가 아니라 env가 소스다. */
export function readSearchIndexWaitConfig(
  env: NodeJS.ProcessEnv = process.env,
): SearchIndexWaitConfig {
  return {
    readyTimeoutMs: readPositiveMs(
      env["SEARCH_INDEX_READY_TIMEOUT_MS"],
      DEFAULT_SEARCH_INDEX_READY_TIMEOUT_MS,
    ),
    pollIntervalMs: readPositiveMs(
      env["SEARCH_INDEX_POLL_INTERVAL_MS"],
      DEFAULT_SEARCH_INDEX_POLL_INTERVAL_MS,
    ),
  };
}

/** 오설정이 대기를 0으로 만들어 폴링을 무력화하지 않게, 비정상 값은 기본값으로 되돌린다. */
function readPositiveMs(raw: string | undefined, fallback: number): number {
  const trimmed = raw?.trim();
  if (!trimmed) return fallback;
  const parsed = Number(trimmed);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
}

/** Atlas가 보고하는 인덱스 상태 중 "더 기다려도 소용없는" 것. */
const FAILED_STATUS = "FAILED";
const READY_STATUS = "READY";

export interface WaitForSearchIndexesOptions extends Partial<SearchIndexWaitConfig> {
  readonly env?: NodeJS.ProcessEnv;
  /** 테스트가 대기를 즉시 resolve로 바꾸는 지점. */
  readonly sleep?: (ms: number) => Promise<void>;
  /** 테스트가 시계를 고정하는 지점. */
  readonly now?: () => number;
}

const realSleep = (ms: number): Promise<void> =>
  new Promise((resolve) => setTimeout(resolve, ms));

/**
 * 모든 대상 인덱스가 READY(그리고 queryable)가 될 때까지 폴링한다.
 *
 * 이 대기를 건너뛰면 바로 뒤따르는 `$vectorSearch`가 "not initialized"로 죽는다 —
 * 배포 직후 첫 검색이 실패하는 형태로 드러나므로 조용한 결함이 아니라 즉시 장애다.
 */
export async function waitForSearchIndexesReady(
  db: SearchIndexDbLike,
  plans: readonly SearchIndexPlan[],
  options: WaitForSearchIndexesOptions = {},
): Promise<void> {
  const fromEnv = readSearchIndexWaitConfig(options.env ?? process.env);
  const readyTimeoutMs = options.readyTimeoutMs ?? fromEnv.readyTimeoutMs;
  const pollIntervalMs = options.pollIntervalMs ?? fromEnv.pollIntervalMs;
  const sleep = options.sleep ?? realSleep;
  const now = options.now ?? Date.now;

  const startedAt = now();
  let pending: string[] = plans.map((plan) => `${plan.collection}.${plan.name}`);

  for (;;) {
    pending = [];
    for (const plan of plans) {
      const existing = await findExisting(db.collection(plan.collection), plan.name);
      const label = `${plan.collection}.${plan.name}`;

      if (existing === undefined) {
        pending.push(`${label}(없음)`);
        continue;
      }
      if (existing.status === FAILED_STATUS) {
        throw new SearchIndexError(
          SEARCH_INDEX_ERROR_CODES.BUILD_FAILED,
          `${label} 빌드가 FAILED로 끝났다. 정의 JSON과 Atlas 인덱스 로그를 확인하라.`,
        );
      }
      if (existing.status !== READY_STATUS || existing.queryable === false) {
        pending.push(`${label}(${existing.status ?? "unknown"})`);
      }
    }

    if (pending.length === 0) return;

    const elapsed = now() - startedAt;
    if (elapsed >= readyTimeoutMs) {
      throw new SearchIndexError(
        SEARCH_INDEX_ERROR_CODES.NOT_READY,
        `${readyTimeoutMs}ms 안에 READY가 되지 않았다: ${pending.join(", ")}. ` +
          `SEARCH_INDEX_READY_TIMEOUT_MS를 늘리거나 Atlas 인덱스 상태를 확인하라.`,
      );
    }

    await sleep(pollIntervalMs);
  }
}
