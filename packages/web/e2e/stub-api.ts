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
  CANDIDATE_ARTICLE,
  DIVERGENCE_RECORD,
  DRAFT_ARTICLE,
  FLOW_DRAFT_ARTICLE,
  INCIDENT_RECORD,
  PUBLISHED_ARTICLE,
  SEARCH_HITS,
  STUB_API_PORT,
  STUB_PUBLISHED_AT,
} from "./fixtures";

const RECORDS: Record<string, unknown> = {
  [INCIDENT_RECORD._id]: INCIDENT_RECORD,
  [DIVERGENCE_RECORD._id]: DIVERGENCE_RECORD,
};

/**
 * 아티클 저장소 (T-033). **가변이다** — 편집·발행 흐름을 끝까지 밟으려면 상태가 남아야 한다.
 *
 * 이 스텁은 specs/04의 아티클 4건을 그대로 흉내 낸다. 흉내가 아니라 진짜 판정은
 * `packages/api/src/articles.ts`와 그 테스트가 한다 — 여기서 재는 것은 **웹의 흐름**이다
 * (T-023이 스텁을 둔 이유와 같다). 그래서 계약을 어기지 않는 선에서 최소한만 구현한다.
 */
interface StubArticle {
  _id: string;
  status: string;
  title: string;
  body?: string;
  publishedAt?: string;
  editHistory: { at: string; diffSummary: string }[];
  [key: string]: unknown;
}

const ARTICLES = new Map<string, StubArticle>(
  [PUBLISHED_ARTICLE, DRAFT_ARTICLE, FLOW_DRAFT_ARTICLE, CANDIDATE_ARTICLE].map((article) => [
    article._id,
    structuredClone(article) as StubArticle,
  ]),
);

/** 목록 항목은 **본문 없는 요약**이다(specs/04). 본문을 실으면 계약이 거부한다. */
function toSummary(article: StubArticle): unknown {
  return {
    _id: article._id,
    kind: article["kind"],
    title: article.title,
    slug: article["slug"],
    status: article.status,
    sourceRecordCount: (article["sourceRecordIds"] as string[]).length,
    createdAt: article["createdAt"],
    ...(article.publishedAt === undefined ? {} : { publishedAt: article.publishedAt }),
  };
}

const EDITABLE = ["candidate", "draft"];

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

    // --------------------------------------------------------- 아티클 (specs/04 표)

    if (url.pathname === "/v1/articles" && request.method === "GET") {
      // **기본은 published다.** 파라미터를 빠뜨렸을 때가 안전한 쪽이어야 한다(specs/04).
      const status = url.searchParams.get("status") ?? "published";
      const items = [...ARTICLES.values()]
        .filter((article) => article.status === status)
        .map(toSummary);
      send(response, 200, { items, nextCursor: null });
      return;
    }

    const publishMatch = /^\/v1\/articles\/([^/]+)\/publish$/.exec(url.pathname);
    if (publishMatch !== null && request.method === "POST") {
      const article = ARTICLES.get(decodeURIComponent(publishMatch[1] ?? ""));
      if (article === undefined) {
        send(response, 404, apiError("ARTICLE_NOT_FOUND", "해당 ID의 아티클이 없다"));
        return;
      }
      const body = (await readJsonBody(request)) ?? {};
      // 바디에 무엇이든 오면 거절한다. `publishedAt`은 **서버가 찍는다**(specs/04).
      if (Object.keys(body as Record<string, unknown>).length > 0) {
        send(
          response,
          400,
          apiError("PUBLISHED_AT_IS_SERVER_OWNED", "발행 바디는 비어 있어야 한다"),
        );
        return;
      }
      if (article.status !== "draft" || article.body === undefined) {
        send(response, 409, apiError("ARTICLE_NOT_PUBLISHABLE", "본문 있는 draft만 발행된다"));
        return;
      }
      article.status = "published";
      article.publishedAt = STUB_PUBLISHED_AT;
      send(response, 200, article);
      return;
    }

    const articleMatch = /^\/v1\/articles\/([^/]+)$/.exec(url.pathname);
    if (articleMatch !== null) {
      const article = ARTICLES.get(decodeURIComponent(articleMatch[1] ?? ""));
      if (article === undefined) {
        send(response, 404, apiError("ARTICLE_NOT_FOUND", "해당 ID의 아티클이 없다"));
        return;
      }
      if (request.method === "GET") {
        send(response, 200, article);
        return;
      }
      if (request.method === "PATCH") {
        const patch = ((await readJsonBody(request)) ?? {}) as Record<string, unknown>;
        if ("publishedAt" in patch) {
          send(
            response,
            400,
            apiError("PUBLISHED_AT_IS_SERVER_OWNED", "바디에 publishedAt을 담을 수 없다"),
          );
          return;
        }
        if (!EDITABLE.includes(article.status)) {
          send(response, 409, apiError("ARTICLE_NOT_EDITABLE", "candidate·draft만 편집된다"));
          return;
        }
        for (const [key, value] of Object.entries(patch)) article[key] = value;
        // editHistory는 **서버가** 붙인다(specs/08 §2).
        article.editHistory.push({
          at: new Date().toISOString(),
          diffSummary: `${Object.keys(patch).sort().join(", ")} 수정`,
        });
        send(response, 200, article);
        return;
      }
    }

    send(response, 404, apiError("NOT_FOUND", `${url.pathname}는 스텁에 없다`));
  })().catch((error: unknown) => {
    send(response, 500, apiError("STUB_FAILURE", error instanceof Error ? error.message : "unknown"));
  });
});

server.listen(STUB_API_PORT, () => {
  process.stdout.write(`[e2e stub-api] listening on ${String(STUB_API_PORT)}\n`);
});
