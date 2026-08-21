import { afterEach, describe, expect, it } from "vitest";

import {
  closeDb,
  connect,
  DB_ERROR_CODES,
  DbConnectionError,
  DEFAULT_SERVER_SELECTION_TIMEOUT_MS,
  getDb,
  ping,
  readDbConfig,
} from "./client.js";

/**
 * T-003 Acceptance 2: 연결 실패는 **명확한 에러 코드**로 드러나야 한다.
 * 실제 네트워크 대기를 피하려고 serverSelectionTimeoutMS를 아주 짧게 주입한다 —
 * 안 그러면 기본 5초(운영은 그게 맞다)를 테스트마다 물게 된다.
 */
const FAST_TIMEOUT_MS = 100;
/** 라우팅 불가 포트. 어떤 mongod도 여기 없다. */
const UNREACHABLE_URI = "mongodb://127.0.0.1:1/sentinel";

/** env 오염이 다른 테스트로 새지 않게 각 테스트가 끝나면 되돌린다. */
const ENV_KEYS = ["MONGODB_URI", "MONGODB_DB", "MONGODB_SERVER_SELECTION_TIMEOUT_MS"] as const;
const originalEnv = new Map(ENV_KEYS.map((k) => [k, process.env[k]]));

afterEach(async () => {
  await closeDb();
  for (const [key, value] of originalEnv) {
    if (value === undefined) Reflect.deleteProperty(process.env, key);
    else process.env[key] = value;
  }
});

function envWithout(...omitted: string[]): NodeJS.ProcessEnv {
  const base: NodeJS.ProcessEnv = {
    MONGODB_URI: UNREACHABLE_URI,
    MONGODB_DB: "sentinel_test",
  };
  for (const key of omitted) Reflect.deleteProperty(base, key);
  return base;
}

describe("readDbConfig", () => {
  it("MONGODB_URI가 없으면 DB_URI_MISSING으로 실패한다", () => {
    try {
      readDbConfig(envWithout("MONGODB_URI"));
      expect.unreachable("에러를 던져야 한다");
    } catch (error) {
      expect(error).toBeInstanceOf(DbConnectionError);
      expect((error as DbConnectionError).code).toBe(DB_ERROR_CODES.URI_MISSING);
    }
  });

  it("MONGODB_URI가 공백뿐이어도 DB_URI_MISSING이다", () => {
    // 빈 문자열을 유효한 URI로 취급하면 드라이버 단에서 모호한 에러가 난다.
    // CI가 존재하지 않는 시크릿을 빈 문자열로 주입하는 실제 상황이다.
    const call = (): unknown => readDbConfig({ ...envWithout(), MONGODB_URI: "   " });
    expect(call).toThrow(DbConnectionError);
    expect(call).toThrow(/MONGODB_URI/);
  });

  it("MONGODB_DB가 없으면 DB_NAME_MISSING으로 실패한다", () => {
    try {
      readDbConfig(envWithout("MONGODB_DB"));
      expect.unreachable("에러를 던져야 한다");
    } catch (error) {
      expect((error as DbConnectionError).code).toBe(DB_ERROR_CODES.DB_NAME_MISSING);
    }
  });

  it("접속 정보를 env에서만 읽는다(기본 URI 폴백 없음)", () => {
    const config = readDbConfig(envWithout());
    expect(config.uri).toBe(UNREACHABLE_URI);
    expect(config.dbName).toBe("sentinel_test");
  });

  it("서버 선택 타임아웃은 기본 5000ms이고 env로 덮어쓸 수 있다", () => {
    expect(readDbConfig(envWithout()).serverSelectionTimeoutMS).toBe(
      DEFAULT_SERVER_SELECTION_TIMEOUT_MS,
    );
    expect(
      readDbConfig({
        ...envWithout(),
        MONGODB_SERVER_SELECTION_TIMEOUT_MS: "250",
      }).serverSelectionTimeoutMS,
    ).toBe(250);
  });

  it("타임아웃 env가 쓰레기 값이면 기본값으로 되돌린다", () => {
    // 오타 하나로 타임아웃이 NaN이 되면 드라이버가 즉시 죽거나 영원히 매달린다.
    expect(
      readDbConfig({
        ...envWithout(),
        MONGODB_SERVER_SELECTION_TIMEOUT_MS: "빠르게",
      }).serverSelectionTimeoutMS,
    ).toBe(DEFAULT_SERVER_SELECTION_TIMEOUT_MS);
  });
});

describe("connect", () => {
  it("URI 형식이 틀리면 DB_URI_INVALID로 실패한다", async () => {
    await expect(
      connect({
        uri: "http://not-a-mongo-uri",
        dbName: "sentinel_test",
        serverSelectionTimeoutMS: FAST_TIMEOUT_MS,
      }),
    ).rejects.toMatchObject({
      name: "DbConnectionError",
      code: DB_ERROR_CODES.URI_INVALID,
    });
  });

  it("서버에 닿지 못하면 DB_CONNECTION_FAILED로 실패한다", async () => {
    try {
      await connect({
        uri: UNREACHABLE_URI,
        dbName: "sentinel_test",
        serverSelectionTimeoutMS: FAST_TIMEOUT_MS,
      });
      expect.unreachable("연결이 성공하면 안 된다");
    } catch (error) {
      expect(error).toBeInstanceOf(DbConnectionError);
      expect((error as DbConnectionError).code).toBe(DB_ERROR_CODES.CONNECTION_FAILED);
      // 원인을 삼키지 않는다 — 드라이버 에러가 cause로 남아야 진단이 된다.
      expect((error as DbConnectionError).cause).toBeDefined();
    }
  });
});

describe("싱글턴 접근자", () => {
  it("env 미설정 상태의 getDb는 DB_URI_MISSING을 던진다", async () => {
    delete process.env["MONGODB_URI"];
    process.env["MONGODB_DB"] = "sentinel_test";
    await expect(getDb()).rejects.toMatchObject({
      code: DB_ERROR_CODES.URI_MISSING,
    });
  });

  it("연결 실패는 캐시되지 않아 재시도가 가능하다", async () => {
    process.env["MONGODB_URI"] = UNREACHABLE_URI;
    process.env["MONGODB_DB"] = "sentinel_test";
    process.env["MONGODB_SERVER_SELECTION_TIMEOUT_MS"] = String(FAST_TIMEOUT_MS);

    // 실패한 Promise가 싱글턴에 눌러앉으면 DB가 살아난 뒤에도 영원히 실패한다.
    await expect(getDb()).rejects.toMatchObject({
      code: DB_ERROR_CODES.CONNECTION_FAILED,
    });
    await expect(getDb()).rejects.toMatchObject({
      code: DB_ERROR_CODES.CONNECTION_FAILED,
    });
  });

  it("closeDb는 연결이 없어도, 두 번 불러도 던지지 않는다", async () => {
    await expect(closeDb()).resolves.toBeUndefined();
    await expect(closeDb()).resolves.toBeUndefined();
  });
});

describe("ping", () => {
  it("DB에 닿지 못해도 던지지 않고 ok:false를 반환한다", async () => {
    // 헬스체크가 예외로 죽으면 /health 자체가 500이 되어 진단 가치가 사라진다.
    process.env["MONGODB_URI"] = UNREACHABLE_URI;
    process.env["MONGODB_DB"] = "sentinel_test";
    process.env["MONGODB_SERVER_SELECTION_TIMEOUT_MS"] = String(FAST_TIMEOUT_MS);

    const result = await ping();
    expect(result.ok).toBe(false);
    expect(result.latencyMs).toBeGreaterThanOrEqual(0);
  });

  it("env가 아예 없어도 던지지 않는다", async () => {
    delete process.env["MONGODB_URI"];
    await expect(ping()).resolves.toMatchObject({ ok: false });
  });
});
