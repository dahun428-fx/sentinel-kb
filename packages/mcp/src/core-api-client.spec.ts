import { describe, expect, it, vi } from "vitest";

import {
  createCoreApiClient,
  CoreApiError,
  CoreApiTransportError,
  CoreApiUnsafeReadError,
  type CoreApiClientOptions,
} from "./core-api-client.js";

const KEY = "devkey123";

/** 응답 큐를 순서대로 돌려주는 fetch 대역. 호출 인자를 전부 기록한다. */
function fakeFetch(responses: (() => Promise<Response>)[]): {
  fetchImpl: typeof fetch;
  calls: { url: string; init: RequestInit }[];
} {
  const calls: { url: string; init: RequestInit }[] = [];
  let index = 0;
  const fetchImpl = ((url: string, init: RequestInit): Promise<Response> => {
    calls.push({ url, init });
    const next = responses[Math.min(index, responses.length - 1)];
    index += 1;
    if (next === undefined) throw new Error("응답 큐가 비었다");
    return next();
  }) as unknown as typeof fetch;
  return { fetchImpl, calls };
}

const ok = (body: unknown) => (): Promise<Response> =>
  Promise.resolve(
    new Response(JSON.stringify(body), {
      status: 200,
      headers: { "content-type": "application/json" },
    }),
  );

const status =
  (code: number, body: unknown = { error: { code: "BOOM", message: "터졌다" } }) =>
  (): Promise<Response> =>
    Promise.resolve(
      new Response(JSON.stringify(body), {
        status: code,
        headers: { "content-type": "application/json" },
      }),
    );

const boom = () => (): Promise<Response> => Promise.reject(new TypeError("fetch failed"));

function client(
  responses: (() => Promise<Response>)[],
  overrides: Partial<CoreApiClientOptions> = {},
) {
  const { fetchImpl, calls } = fakeFetch(responses);
  return {
    calls,
    api: createCoreApiClient({
      baseUrl: "http://core-api:3001/",
      bearerKey: KEY,
      sleep: () => Promise.resolve(),
      fetchImpl,
      ...overrides,
    }),
  };
}

describe("createCoreApiClient — 요청 형상", () => {
  it("baseUrl 끝의 슬래시를 정규화하고 Bearer 키를 그대로 전달한다", async () => {
    const { api, calls } = client([ok({ items: [] })]);

    await api.read({ method: "GET", path: "/v1/records?limit=5" });

    expect(calls[0]?.url).toBe("http://core-api:3001/v1/records?limit=5");
    const headers = calls[0]?.init.headers as Record<string, string>;
    // MCP는 자기 서비스 키를 들지 않고 호출자의 토큰을 통과시킨다(T-014 D-5).
    expect(headers["authorization"]).toBe(`Bearer ${KEY}`);
  });

  it("본문이 있는 요청에만 content-type을 붙이고 JSON으로 직렬화한다", async () => {
    const { api, calls } = client([ok({ recordId: "r1" })]);

    await api.write({ method: "POST", path: "/v1/records", body: { title: "제목" } });

    const headers = calls[0]?.init.headers as Record<string, string>;
    expect(headers["content-type"]).toBe("application/json");
    expect(calls[0]?.init.body).toBe(JSON.stringify({ title: "제목" }));
  });
});

describe("createCoreApiClient — 재시도는 멱등 요청에만", () => {
  it("read: 503 뒤 200이면 재시도해서 성공한다", async () => {
    const { api, calls } = client([status(503), ok({ items: [1] })]);

    await expect(
      api.read({ method: "POST", path: "/v1/search", body: { query: "q" } }),
    ).resolves.toEqual({
      items: [1],
    });
    expect(calls).toHaveLength(2);
  });

  it("read: 전송 실패도 재시도 대상이다", async () => {
    const { api, calls } = client([boom(), ok({ items: [] })]);

    await expect(api.read({ method: "GET", path: "/v1/records" })).resolves.toEqual({ items: [] });
    expect(calls).toHaveLength(2);
  });

  it("read: 4xx는 재시도하지 않는다 — 재전송해도 같은 답이 온다", async () => {
    const { api, calls } = client([status(400)]);

    await expect(api.read({ method: "GET", path: "/v1/records" })).rejects.toBeInstanceOf(
      CoreApiError,
    );
    expect(calls).toHaveLength(1);
  });

  it("read: maxAttempts를 넘기면 마지막 오류를 던지고 시도 횟수를 싣는다", async () => {
    const { api, calls } = client([status(500)], { maxAttempts: 3 });

    const error = await api.read({ method: "GET", path: "/v1/records" }).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(CoreApiError);
    expect((error as CoreApiError).attempts).toBe(3);
    expect(calls).toHaveLength(3);
  });

  /**
   * **이 태스크에서 가장 중요한 단언이다.** `record_knowledge`(T-015)는 멱등하지 않다.
   * 5xx나 타임아웃에 재전송하면 같은 사건이 레코드 두 벌로 남고, 그건 검색으로만 발견된다.
   */
  it("write: 503이어도 절대 재시도하지 않는다", async () => {
    const { api, calls } = client([status(503), ok({ recordId: "dup" })]);

    await expect(
      api.write({ method: "POST", path: "/v1/records", body: { title: "t" } }),
    ).rejects.toBeInstanceOf(CoreApiError);
    expect(calls).toHaveLength(1);
  });

  it("write: 전송 실패(결과를 모르는 상태)에도 재시도하지 않는다", async () => {
    const { api, calls } = client([boom(), ok({ recordId: "dup" })]);

    await expect(
      api.write({ method: "PATCH", path: "/v1/records/r1", body: { title: "t" } }),
    ).rejects.toBeInstanceOf(CoreApiTransportError);
    expect(calls).toHaveLength(1);
  });
});

/**
 * D-2는 "호출부가 멱등성을 선언한다"였는데, **선언은 잘못될 수 있다.**
 * `read()`의 시그니처는 `POST`/`PATCH`를 전부 받고 경로 제약도 없었다 —
 * `read({method:"POST", path:"/v1/records"})` 한 줄이면 재시도가 켜진 채로 쓰기가 나가고,
 * T-015의 `record_knowledge`에 조용한 레코드 중복 경로가 열린다.
 */
describe("createCoreApiClient — read()는 쓰기 경로를 받지 않는다", () => {
  it.each([
    ["POST /v1/records", "POST", "/v1/records"],
    ["PATCH /v1/records/:id", "PATCH", "/v1/records/r1"],
    ["POST /v1/records/:id/feedback", "POST", "/v1/records/r1/feedback"],
    ["쿼리스트링이 붙어도", "POST", "/v1/records?dry=1"],
  ] as const)("%s는 네트워크에 나가기 전에 거절한다", async (_label, method, path) => {
    const { api, calls } = client([ok({ recordId: "dup" })]);

    await expect(api.read({ method, path, body: {} })).rejects.toBeInstanceOf(
      CoreApiUnsafeReadError,
    );
    // 던지는 것만으로는 부족하다 — 요청이 이미 나간 뒤였다면 중복은 이미 생겼다.
    expect(calls, "거절했다면서 fetch가 나갔다").toHaveLength(0);
  });

  it("POST /v1/search는 부수효과 없는 읽기라 통과한다", async () => {
    const { api, calls } = client([ok({ items: [] })]);

    await expect(
      api.read({ method: "POST", path: "/v1/search", body: { query: "q" } }),
    ).resolves.toEqual({ items: [] });
    expect(calls).toHaveLength(1);
  });

  it.each(["/v1/records", "/v1/records/r1", "/v1/records?limit=5"])(
    "GET %s는 읽기라 통과한다",
    async (path) => {
      const { api, calls } = client([ok({ items: [] })]);

      await api.read({ method: "GET", path });
      expect(calls).toHaveLength(1);
    },
  );

  it("write()는 그대로 쓰기 경로를 받는다 — 가드가 write까지 막으면 안 된다", async () => {
    const { api, calls } = client([ok({ recordId: "r1" })]);

    await expect(
      api.write({ method: "POST", path: "/v1/records", body: { title: "t" } }),
    ).resolves.toEqual({ recordId: "r1" });
    expect(calls).toHaveLength(1);
  });

  it("거절 메시지에 Bearer 키가 들어가지 않는다", async () => {
    const secret = "super-secret-project-key";
    const { api } = client([ok({})], { bearerKey: secret });

    const error = await api
      .read({ method: "POST", path: "/v1/records" })
      .catch((e: unknown) => e);
    expect((error as Error).message).not.toContain(secret);
  });
});

describe("createCoreApiClient — 타임아웃", () => {
  it("timeoutMs가 지나면 시도를 끊는다", async () => {
    // 신호가 abort될 때까지 절대 resolve하지 않는 fetch.
    // 타임아웃이 없으면(= 무력화되면) 이 테스트는 영원히 매달려 죽는다.
    const fetchImpl = ((_url: string, init: RequestInit): Promise<Response> =>
      new Promise((_resolve, reject) => {
        init.signal?.addEventListener("abort", () => {
          reject(new DOMException("The operation was aborted.", "AbortError"));
        });
      })) as unknown as typeof fetch;

    const api = createCoreApiClient({
      baseUrl: "http://core-api:3001",
      bearerKey: KEY,
      timeoutMs: 20,
      maxAttempts: 1,
      sleep: () => Promise.resolve(),
      fetchImpl,
    });

    const error = await api.read({ method: "GET", path: "/v1/records" }).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(CoreApiTransportError);
    expect((error as Error).message).toContain("20ms");
  });

  it("시도마다 새 신호를 만든다 — 신호를 재사용하면 첫 타임아웃 뒤 재시도가 즉시 죽는다", async () => {
    const signals: (AbortSignal | undefined)[] = [];
    const responses = [status(503), ok({ items: [] })];
    let index = 0;
    const fetchImpl = ((_url: string, init: RequestInit): Promise<Response> => {
      signals.push(init.signal ?? undefined);
      const next = responses[index];
      index += 1;
      return next === undefined ? Promise.reject(new Error("큐 없음")) : next();
    }) as unknown as typeof fetch;

    const api = createCoreApiClient({
      baseUrl: "http://core-api:3001",
      bearerKey: KEY,
      sleep: () => Promise.resolve(),
      fetchImpl,
    });
    await api.read({ method: "GET", path: "/v1/records" });

    expect(signals).toHaveLength(2);
    expect(signals[0]).not.toBe(signals[1]);
  });
});

describe("createCoreApiClient — 토큰 유출", () => {
  it("오류 메시지 어디에도 Bearer 키가 들어가지 않는다", async () => {
    const secret = "super-secret-project-key";
    const { api } = client([status(500, "<html>Bad Gateway</html>")], { bearerKey: secret });

    const error = await api.read({ method: "GET", path: "/v1/records" }).catch((e: unknown) => e);
    expect(String((error as Error).message)).not.toContain(secret);
    expect(JSON.stringify(error, Object.getOwnPropertyNames(error))).not.toContain(secret);
  });

  it("전송 오류 메시지도 원인 객체를 펼치지 않는다", async () => {
    const secret = "super-secret-project-key";
    const leaky = (): Promise<Response> =>
      Promise.reject(new TypeError(`fetch failed: authorization=Bearer ${secret}`));
    const { api } = client([leaky], { bearerKey: secret, maxAttempts: 1 });

    const error = await api.read({ method: "GET", path: "/v1/records" }).catch((e: unknown) => e);
    expect((error as Error).message).not.toContain(secret);
  });

  it("클라이언트 객체를 직렬화해도 키가 나오지 않는다 — 클로저에만 있다", () => {
    const secret = "super-secret-project-key";
    const { api } = client([ok({})], { bearerKey: secret });

    expect(JSON.stringify(api)).not.toContain(secret);
    expect(Object.values(api).join(" ")).not.toContain(secret);
  });

  it("JSON이 아닌 오류 본문을 메시지에 붙이지 않는다 (NFR-03 토큰 예산)", async () => {
    const huge = "x".repeat(50_000);
    const { api } = client([status(502, huge)], { maxAttempts: 1 });

    const error = await api.read({ method: "GET", path: "/v1/records" }).catch((e: unknown) => e);
    expect((error as Error).message).not.toContain("xxxx");
    expect((error as Error).message.length).toBeLessThan(200);
  });
});

describe("createCoreApiClient — 오류 번역", () => {
  it("core-api의 {error:{code,message}} 규약을 그대로 옮긴다", async () => {
    const { api } = client([
      status(401, { error: { code: "UNAUTHORIZED", message: "키가 유효하지 않다." } }),
    ]);

    const error = (await api
      .read({ method: "GET", path: "/v1/records" })
      .catch((e: unknown) => e)) as CoreApiError;
    expect(error.statusCode).toBe(401);
    expect(error.code).toBe("UNAUTHORIZED");
    expect(error.message).toBe("키가 유효하지 않다.");
  });

  it("백오프는 지수적으로 늘어난다", async () => {
    const sleep = vi.fn<(ms: number) => Promise<void>>().mockResolvedValue(undefined);
    const { api } = client([status(500), status(500), ok({})], {
      sleep,
      retryBackoffMs: 10,
      maxAttempts: 3,
    });

    await api.read({ method: "GET", path: "/v1/records" });

    expect(sleep.mock.calls.map(([ms]) => ms)).toEqual([10, 20]);
  });
});
