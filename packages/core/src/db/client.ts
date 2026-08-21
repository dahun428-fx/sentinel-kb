/**
 * MongoDB 싱글턴 커넥션. 출처: specs/02-data-model.md, T-003.
 *
 * 이 모듈은 HTTP·MCP를 모른다(specs/01 의존 방향). `/health`가 쓸 수 있도록
 * `ping()`을 export하지만, 라우팅·응답 형상은 호출자(packages/api)의 몫이다.
 *
 * **라이브러리는 프로세스를 죽이지 않는다.** 연결 실패는 코드가 붙은 에러로 던지고,
 * 종료 여부는 호출자(스크립트/서버)가 판단한다.
 */
import { MongoClient, type Db } from "mongodb";

/** 연결 실패 원인 코드. 호출자가 exit code·로그 레벨을 분기하는 기준이다. */
export const DB_ERROR_CODES = {
  /** MONGODB_URI 미설정 — 설정 실수. 재시도해도 소용없다. */
  URI_MISSING: "DB_URI_MISSING",
  /** MONGODB_DB 미설정 — 설정 실수. */
  DB_NAME_MISSING: "DB_NAME_MISSING",
  /** URI 형식 자체가 틀림(mongodb:// 스킴 아님 등) — 설정 실수. */
  URI_INVALID: "DB_URI_INVALID",
  /** 서버 선택·인증 실패 — 네트워크·자격증명 문제. 재시도 여지가 있다. */
  CONNECTION_FAILED: "DB_CONNECTION_FAILED",
} as const;

export type DbErrorCode = (typeof DB_ERROR_CODES)[keyof typeof DB_ERROR_CODES];

/** 연결 계층의 모든 실패를 코드로 식별 가능하게 감싼다 (T-003 Acceptance 2). */
export class DbConnectionError extends Error {
  readonly code: DbErrorCode;

  constructor(code: DbErrorCode, message: string, cause?: unknown) {
    super(message, cause === undefined ? undefined : { cause });
    this.name = "DbConnectionError";
    this.code = code;
  }
}

/** 서버 선택 타임아웃 기본값(ms). 짧게 둬야 오설정이 30초씩 매달리지 않는다. */
export const DEFAULT_SERVER_SELECTION_TIMEOUT_MS = 5000;

export interface DbConfig {
  readonly uri: string;
  readonly dbName: string;
  readonly serverSelectionTimeoutMS: number;
}

/**
 * env에서만 접속 정보를 읽는다. 기본 URI·자격증명 하드코딩 금지(CLAUDE.md).
 * 값이 없으면 `mongodb://localhost`로 조용히 흘러가지 않고 즉시 코드가 붙은 에러를 던진다.
 */
export function readDbConfig(env: NodeJS.ProcessEnv = process.env): DbConfig {
  const uri = env["MONGODB_URI"]?.trim();
  if (!uri) {
    throw new DbConnectionError(
      DB_ERROR_CODES.URI_MISSING,
      "MONGODB_URI가 설정되지 않았다. .env.example을 참고해 주입하라.",
    );
  }

  const dbName = env["MONGODB_DB"]?.trim();
  if (!dbName) {
    throw new DbConnectionError(
      DB_ERROR_CODES.DB_NAME_MISSING,
      "MONGODB_DB가 설정되지 않았다. .env.example을 참고해 주입하라.",
    );
  }

  return {
    uri,
    dbName,
    serverSelectionTimeoutMS: readTimeoutMs(env["MONGODB_SERVER_SELECTION_TIMEOUT_MS"]),
  };
}

function readTimeoutMs(raw: string | undefined): number {
  if (raw === undefined || raw.trim() === "") {
    return DEFAULT_SERVER_SELECTION_TIMEOUT_MS;
  }
  const parsed = Number(raw);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : DEFAULT_SERVER_SELECTION_TIMEOUT_MS;
}

/**
 * 싱글턴을 거치지 않는 저수준 연결. 테스트와 마이그레이션 스크립트가 쓴다.
 * 연결 직후 ping을 한 번 쳐서 "connect는 됐는데 첫 쿼리에서 죽는" 지연 실패를 막는다.
 */
export async function connect(config: DbConfig): Promise<MongoClient> {
  let client: MongoClient;
  try {
    client = new MongoClient(config.uri, {
      serverSelectionTimeoutMS: config.serverSelectionTimeoutMS,
    });
  } catch (cause) {
    throw new DbConnectionError(
      DB_ERROR_CODES.URI_INVALID,
      `MONGODB_URI 형식이 올바르지 않다: ${describe(cause)}`,
      cause,
    );
  }

  try {
    await client.connect();
    await client.db(config.dbName).admin().command({ ping: 1 });
  } catch (cause) {
    await client.close().catch(() => undefined);
    throw new DbConnectionError(
      DB_ERROR_CODES.CONNECTION_FAILED,
      `MongoDB 연결에 실패했다(db=${config.dbName}): ${describe(cause)}`,
      cause,
    );
  }

  return client;
}

function describe(cause: unknown): string {
  return cause instanceof Error ? cause.message : String(cause);
}

/**
 * 연결 시도 자체를 캐시한다(Promise 캐시). 부팅 직후 동시에 여러 요청이 들어와도
 * 커넥션 풀이 하나만 생긴다. 실패한 시도는 캐시에서 지워 다음 호출이 재시도할 수 있게 둔다.
 */
let clientPromise: Promise<MongoClient> | undefined;

/** 싱글턴 MongoClient. env가 없거나 연결이 실패하면 `DbConnectionError`를 던진다. */
export function getClient(): Promise<MongoClient> {
  clientPromise ??= connect(readDbConfig()).catch((error: unknown) => {
    clientPromise = undefined;
    throw error;
  });
  return clientPromise;
}

/** 싱글턴 커넥션의 `MONGODB_DB` 핸들. */
export async function getDb(): Promise<Db> {
  const { dbName } = readDbConfig();
  const client = await getClient();
  return client.db(dbName);
}

/**
 * graceful shutdown. 여러 번 불러도 안전하고, 연결이 실패한 상태에서도 던지지 않는다.
 * 종료 경로에서 예외가 나면 프로세스가 비정상 코드로 죽는데 그건 감출 가치가 없는 소음이다.
 */
export async function closeDb(): Promise<void> {
  const pending = clientPromise;
  clientPromise = undefined;
  if (pending === undefined) return;
  try {
    const client = await pending;
    await client.close();
  } catch {
    // 연결 자체가 실패했다면 닫을 커넥션이 없다 — 종료를 막을 이유가 아니다.
  }
}

export interface PingResult {
  readonly ok: boolean;
  readonly latencyMs: number;
}

/**
 * 헬스체크용 admin `{ping:1}`. **실패해도 던지지 않는다** —
 * `/health`가 DB 장애에 500이 아니라 `ok:false`로 답해야 진단이 가능하다.
 */
export async function ping(): Promise<PingResult> {
  const startedAt = Date.now();
  try {
    const db = await getDb();
    await db.admin().command({ ping: 1 });
    return { ok: true, latencyMs: Date.now() - startedAt };
  } catch {
    return { ok: false, latencyMs: Date.now() - startedAt };
  }
}
