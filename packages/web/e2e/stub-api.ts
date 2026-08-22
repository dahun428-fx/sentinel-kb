/**
 * E2E용 core-api 스텁.
 *
 * 왜 실서버가 아닌가: 웹의 데이터 로딩은 서버 컴포넌트에서 일어나므로 Playwright의
 * `page.route()`로는 가로챌 수 없다. 그래서 core-api 자리에 계약을 지키는 작은 HTTP
 * 서버를 세우고 웹이 그것을 부르게 한다. 이 태스크가 검증하는 것은 **웹의 읽기 경로**이지
 * core-api의 검색 품질이 아니다 — 그쪽은 T-012·T-013·T-019의 몫이다.
 *
 * 응답 모양은 specs/04와 `packages/contracts`를 따른다. 계약을 벗어나면 웹의 Zod 파싱이 터진다.
 */
import { createServer } from "node:http";

import {
  ANSWER_CITATIONS,
  ANSWER_TEXT,
  CANARY_API_KEY,
  DIVERGENCE_RECORD,
  INCIDENT_RECORD,
  SEARCH_HITS,
  STUB_API_PORT,
} from "./fixtures";

const RECORDS: Record<string, unknown> = {
  [INCIDENT_RECORD._id]: INCIDENT_RECORD,
  [DIVERGENCE_RECORD._id]: DIVERGENCE_RECORD,
};

function send(
  response: import("node:http").ServerResponse,
  status: number,
  payload: unknown,
): void {
  const body = JSON.stringify(payload);
  response.writeHead(status, { "content-type": "application/json; charset=utf-8" });
  response.end(body);
}

function apiError(code: string, message: string) {
  return { error: { code, message } };
}

async function readJsonBody(request: import("node:http").IncomingMessage): Promise<unknown> {
  const chunks: Buffer[] = [];
  for await (const chunk of request) {
    chunks.push(chunk as Buffer);
  }
  if (chunks.length === 0) return undefined;
  return JSON.parse(Buffer.concat(chunks).toString("utf8")) as unknown;
}

const server = createServer((request, response) => {
  void (async () => {
    const url = new URL(request.url ?? "/", `http://localhost:${String(STUB_API_PORT)}`);

    if (url.pathname === "/health") {
      send(response, 200, { status: "ok", mongo: "up", embeddingVersion: 1, version: "e2e-stub" });
      return;
    }

    // specs/04: 모든 `/v1` 표면은 Bearer 인증을 요구한다 (NFR-04).
    if (request.headers.authorization !== `Bearer ${CANARY_API_KEY}`) {
      send(response, 401, apiError("UNAUTHORIZED", "Bearer 키가 없거나 올바르지 않다"));
      return;
    }

    if (url.pathname === "/v1/search" && request.method === "POST") {
      const body = (await readJsonBody(request)) as { type?: string; project?: string };
      const results = SEARCH_HITS.filter(
        (hit) =>
          (body.type === undefined || hit.type === body.type) &&
          (body.project === undefined || hit.project === body.project),
      );
      send(response, 200, { results });
      return;
    }

    if (url.pathname === "/v1/answer" && request.method === "POST") {
      const body = (await readJsonBody(request)) as { query?: string };
      // 임계값 미달 갈래도 화면에서 확인할 수 있어야 한다 (FR-04).
      if ((body.query ?? "").includes("없는사례")) {
        send(response, 200, {
          found: false,
          message: "유사한 사례를 찾지 못했다.",
          suggestRecord: true,
        });
        return;
      }
      send(response, 200, { found: true, answer: ANSWER_TEXT, citations: ANSWER_CITATIONS });
      return;
    }

    const recordMatch = /^\/v1\/records\/([^/]+)$/.exec(url.pathname);
    if (recordMatch !== null && request.method === "GET") {
      const record = RECORDS[decodeURIComponent(recordMatch[1] ?? "")];
      if (record === undefined) {
        send(response, 404, apiError("RECORD_NOT_FOUND", "해당 ID의 기록이 없다"));
        return;
      }
      send(response, 200, record);
      return;
    }

    send(response, 404, apiError("NOT_FOUND", `${url.pathname}는 스텁에 없다`));
  })().catch((error: unknown) => {
    send(response, 500, apiError("STUB_FAILURE", error instanceof Error ? error.message : "unknown"));
  });
});

server.listen(STUB_API_PORT, () => {
  process.stdout.write(`[e2e stub-api] listening on ${String(STUB_API_PORT)}\n`);
});
