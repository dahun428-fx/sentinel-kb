import { describe, expect, it } from "vitest";

import { createSearchClient, EvalSearchError } from "./search-client.js";

const RECORD_ID = "111111111111111111111111";

function okResponse(body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status: 200,
    headers: { "content-type": "application/json" },
  });
}

function hitBody(): unknown {
  return {
    results: [
      {
        recordId: RECORD_ID,
        title: "nginx 502",
        summary: "요약",
        section: "rootCause",
        score: 0.0328,
        type: "incident",
        project: "sentinel-kb",
        flags: [],
      },
    ],
  };
}

describe("createSearchClient", () => {
  it("POST /v1/search에 Bearer 키와 limit을 실어 보낸다", async () => {
    let seen: { url: string; init: RequestInit } | undefined;
    const search = createSearchClient({
      baseUrl: "http://localhost:3001",
      apiKey: "devkey123",
      fetchImpl: ((url: string, init: RequestInit) => {
        seen = { url, init };
        return Promise.resolve(okResponse(hitBody()));
      }) as unknown as typeof fetch,
    });

    await search({ query: "nginx 502", limit: 5 });

    expect(seen?.url).toBe("http://localhost:3001/v1/search");
    expect(seen?.init.method).toBe("POST");
    expect((seen?.init.headers as Record<string, string>)["authorization"]).toBe("Bearer devkey123");
    expect(JSON.parse(String(seen?.init.body))).toEqual({ query: "nginx 502", limit: 5 });
  });

  it("type 필터는 있을 때만 싣고, project는 절대 싣지 않는다", async () => {
    let body: unknown;
    const search = createSearchClient({
      baseUrl: "http://localhost:3001",
      apiKey: "devkey123",
      fetchImpl: ((_url: string, init: RequestInit) => {
        body = JSON.parse(String(init.body));
        return Promise.resolve(okResponse(hitBody()));
      }) as unknown as typeof fetch,
    });

    await search({ query: "nginx 502", limit: 5, type: "divergence" });
    expect(body).toEqual({ query: "nginx 502", limit: 5, type: "divergence" });
  });

  it("응답을 contracts의 SearchResponse로 파싱해 recordId·score만 남긴다", async () => {
    const search = createSearchClient({
      baseUrl: "http://localhost:3001",
      apiKey: "devkey123",
      fetchImpl: (() => Promise.resolve(okResponse(hitBody()))) as unknown as typeof fetch,
    });
    await expect(search({ query: "nginx 502", limit: 5 })).resolves.toEqual([
      { recordId: RECORD_ID, score: 0.0328 },
    ]);
  });

  it("계약을 어긴 응답은 조용히 빈 결과가 되지 않는다", async () => {
    const search = createSearchClient({
      baseUrl: "http://localhost:3001",
      apiKey: "devkey123",
      fetchImpl: (() =>
        Promise.resolve(okResponse({ results: [{ recordId: "nope" }] }))) as unknown as typeof fetch,
    });
    // 빈 결과로 접으면 "검색이 망가졌다"가 "품질이 떨어졌다"로 둔갑한다.
    await expect(search({ query: "nginx 502", limit: 5 })).rejects.toThrow();
  });

  it("실패 응답은 상태 코드를 달고 던지며, 메시지에 API 키가 없다", async () => {
    const search = createSearchClient({
      baseUrl: "http://localhost:3001",
      apiKey: "devkey123",
      fetchImpl: (() =>
        Promise.resolve(new Response("unauthorized", { status: 401 }))) as unknown as typeof fetch,
    });
    await expect(search({ query: "nginx 502", limit: 5 })).rejects.toBeInstanceOf(EvalSearchError);
    await search({ query: "x", limit: 5 }).catch((error: unknown) => {
      expect((error as EvalSearchError).status).toBe(401);
      expect((error as Error).message).not.toContain("devkey123");
    });
  });
});
