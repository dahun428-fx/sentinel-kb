/**
 * T-012 통합 테스트. `mongodb/mongodb-atlas-local` 컨테이너에서 **실제 `$vectorSearch`·`$search`**
 * 위로 `POST /v1/search`를 부른다. 부팅은 `@sentinel/core/testing`(T-010이 뽑고 T-011이
 * 재사용한 공용 게이트)을 쓴다 — 복붙하지 않는다.
 *
 * **컨테이너를 못 쓰는 환경에서는 skip한다. 통과시키지 않는다.** skip은 조용히 일어나지 않는다.
 *
 * ## 픽스처가 진짜 시드다
 * Acceptance 1이 "**시드 기준** 알려진 쿼리 3개"를 요구하므로 `packages/core/seed/*.json`을
 * 그대로 읽어 **실제 `POST /v1/records`로 적재한다**(T-009 `runSeed`와 같은 경로).
 * 손으로 만든 축소 픽스처였다면 "요약이 본문과 다르다"·"청크 prefix가 붙는다" 같은
 * 이 라우트의 실제 위험이 재현되지 않는다.
 *
 * 청크는 인제스트 워커 대신 여기서 `chunkRecord()` + `createFakeEmbedder()`로 만들어 넣는다.
 * `@sentinel/api`가 `@sentinel/worker`를 import하는 것은 specs/01의 의존 방향 위반이라
 * (eslint `import/no-restricted-paths`가 실제로 막는다) 큐를 드레인할 수 없기 때문이다.
 *
 * ## 왜 기대 record를 **리터럴 토큰**으로 지목하는가
 * fake embedder는 해시 기반이라 서로 다른 텍스트 간 cosine ≈ 0이다(T-006 F-8). 그 위에서
 * "서술형 질의가 의미로 맞는다"를 단언하면 **공허한 그린**이 난다. 그래서 질의는 시드 전체에서
 * **정확히 한 레코드에만 등장하는 식별자**를 쓴다 — 판정 대상은 임베딩 품질이 아니라
 * "라우트가 retriever의 결과를 계약대로 투영해 Top-N 안에 돌려주는가"다.
 *
 * 동점 벡터 점수 청크를 지목하지 않는다(T-011 F-9): 순위를 콕 집지 않고 **Top-5 포함**만 본다.
 */
import { SearchResponse, type RecordSchema } from "@sentinel/contracts";
import {
  chunkRecord,
  createFakeEmbedder,
  createRetriever,
  parseApiKeys, // T-037: api 사본에서 core 한 벌로.
  type Retriever,
} from "@sentinel/core";
import {
  buildSearchIndexPlans,
  ensureIndexes,
  ensureSearchIndexes,
  waitForSearchIndexesReady,
} from "@sentinel/core/db";
import {
  ATLAS_LOCAL_BOOT_TIMEOUT_MS,
  dockerAvailable,
  pollUntil,
  startAtlasLocal,
  warnDockerMissing,
  type AtlasLocalHandle,
} from "@sentinel/core/testing";
import type { FastifyInstance } from "fastify";
import { readdir, readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { ObjectId, type Db } from "mongodb";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { createApp } from "./app.js";
import { SEARCH_LOG_EVENT } from "./search.js";

const CONTAINER_NAME = `sentinel-t012-${process.pid}`;
const DB_NAME = "sentinel_t012_int";
/** 테스트 전용 차원. 실제 모델 차원과 무관해야 env가 소스임이 드러난다. */
const DIM = 8;
const EMBEDDING_VERSION = 1;
const QUERY_TIMEOUT_MS = 120_000;

const API_KEYS = parseApiKeys("key-alpha:sentinel-kb");
const ALPHA = "Bearer key-alpha";
const SANITIZE_OPTIONS = { maskEmail: false, maxInputChars: 65_536 } as const;

/** `packages/api/src` → `packages/core/seed`. T-009의 `DEFAULT_SEED_DIR`와 같은 곳을 가리킨다. */
const SEED_DIR = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "..",
  "..",
  "core",
  "seed",
);

const HAS_DOCKER = dockerAvailable();
if (!HAS_DOCKER) {
  warnDockerMissing("T-012", "search.int.spec.ts", "시드 기준 검색(Acceptance 1)");
}

/* --------------------------------------------------------------------------
 * 알려진 쿼리 3개 (Acceptance 1)
 *
 * 세 토큰 모두 시드 50건 중 **정확히 한 파일에만** 등장한다(작성 시점 실측).
 * `lucene.standard`는 밑줄을 단어 결합자로 보고 대소문자를 접으므로 `proxy_buffering`·
 * `OOMKilled`가 통째 토큰으로 잡힌다 — 한국어 서술형과 달리 텍스트 경로가 확실히 잡는 종류다.
 * ----------------------------------------------------------------------- */

interface KnownQuery {
  readonly query: string;
  /** 이 토큰을 담은 시드 파일. title로 recordId를 찾는다(T-009의 멱등 키와 같은 기준). */
  readonly seedFile: string;
}

const KNOWN_QUERIES: readonly KnownQuery[] = [
  { query: "onlyBuiltDependencies", seedFile: "incidents/INC-01.json" },
  { query: "proxy_buffering", seedFile: "incidents/INC-06.json" },
  { query: "OOMKilled", seedFile: "incidents/INC-13.json" },
];

interface LogLine {
  readonly msg?: string;
  readonly [key: string]: unknown;
}

let handle: AtlasLocalHandle | undefined;
let db: Db;
let app: FastifyInstance;
let retriever: Retriever;
const logs: LogLine[] = [];
/** 시드 파일 경로 → 적재된 recordId(hex). */
const recordIdBySeedFile = new Map<string, string>();
/** 시드 파일 경로 → 적재된 레코드 전문. 본문 유출 검사의 원본이다. */
const recordBySeedFile = new Map<string, RecordSchema>();

async function readSeedFiles(): Promise<{ file: string; input: unknown }[]> {
  const entries = await readdir(SEED_DIR, { withFileTypes: true });
  const out: { file: string; input: unknown }[] = [];
  for (const dir of entries.filter((entry) => entry.isDirectory())) {
    const files = (await readdir(path.join(SEED_DIR, dir.name)))
      .filter((name) => name.endsWith(".json"))
      .sort();
    for (const name of files) {
      const raw = await readFile(path.join(SEED_DIR, dir.name, name), "utf8");
      out.push({ file: `${dir.name}/${name}`, input: JSON.parse(raw) });
    }
  }
  return out;
}

beforeAll(async () => {
  if (!HAS_DOCKER) return;
  handle = await startAtlasLocal({ containerName: CONTAINER_NAME, dbName: DB_NAME });
  db = handle.db;

  await ensureIndexes(db);
  await ensureSearchIndexes(db, { dim: DIM });
  await waitForSearchIndexesReady(db, buildSearchIndexPlans(DIM), {
    pollIntervalMs: 500,
    readyTimeoutMs: 180_000,
  });

  const embedder = createFakeEmbedder({ dim: DIM, version: EMBEDDING_VERSION });
  retriever = createRetriever({ db, embedder });

  app = createApp({
    db,
    apiKeys: API_KEYS,
    sanitizeOptions: SANITIZE_OPTIONS,
    retriever,
    embeddingVersion: EMBEDDING_VERSION,
    version: "0.0.1-test",
    logger: {
      level: "info",
      stream: {
        write(line: string): void {
          logs.push(JSON.parse(line) as LogLine);
        },
      },
    },
  });
  await app.ready();

  /*
   * 1) 시드 50건을 **실제 라우트로** 적재한다. summary·sanitizeFlags·embeddingVersion이
   *    전부 서버 생성 경로를 거친다 — 검색 응답의 summary가 그 산출물이다.
   */
  const seeds = await readSeedFiles();
  expect(seeds.length).toBeGreaterThan(0);
  for (const seed of seeds) {
    const response = await app.inject({
      method: "POST",
      url: "/v1/records",
      headers: { authorization: ALPHA },
      payload: seed.input as object,
    });
    expect(response.statusCode, `${seed.file} 적재 실패: ${response.body}`).toBe(201);
    const record = response.json<RecordSchema>();
    recordIdBySeedFile.set(seed.file, record._id);
    recordBySeedFile.set(seed.file, record);
  }

  /*
   * 2) 워커 대신 청크를 만든다(위 파일 주석의 의존 방향 참조). 도큐먼트 형상은
   *    specs/02 chunks — retriever가 `meta.type`·`meta.project`·`embeddingVersion`으로 필터한다.
   */
  const chunkDocs: Record<string, unknown>[] = [];
  for (const [file, record] of recordBySeedFile) {
    const chunks = chunkRecord(record, { maxChars: 1200 });
    expect(chunks.length, `${file}이 청크를 만들지 못했다`).toBeGreaterThan(0);
    const vectors = await embedder.embed(chunks.map((chunk) => chunk.text));
    chunks.forEach((chunk, index) => {
      chunkDocs.push({
        recordId: new ObjectId(record._id),
        section: chunk.section,
        seq: chunk.seq,
        text: chunk.text,
        embedding: vectors[index],
        meta: {
          type: record.type,
          project: record.project,
          severity: record.severity,
          tags: record.tags,
          sanitizeFlags: record.sanitizeFlags,
        },
        embeddingVersion: EMBEDDING_VERSION,
      });
    });
  }
  await db.collection("chunks").insertMany(chunkDocs);

  // 검색 인덱스는 READY 이후에도 새 문서를 반영하는 데 잠깐 걸린다.
  await pollUntil(
    () => retriever.retrieve({ query: KNOWN_QUERIES[0]?.query ?? "" }),
    (result) => result.textCandidateCount > 0 && result.vectorCandidateCount > 0,
    QUERY_TIMEOUT_MS,
  );
}, ATLAS_LOCAL_BOOT_TIMEOUT_MS);

afterAll(async () => {
  await app?.close();
  await handle?.stop();
});

async function search(payload: unknown): Promise<{
  status: number;
  raw: string;
  body: Record<string, unknown>;
}> {
  const response = await app.inject({
    method: "POST",
    url: "/v1/search",
    headers: { authorization: ALPHA },
    payload: payload as object,
  });
  return {
    status: response.statusCode,
    raw: response.body,
    body: response.json<Record<string, unknown>>(),
  };
}

function resultsOf(body: Record<string, unknown>): Record<string, unknown>[] {
  return body["results"] as Record<string, unknown>[];
}

describe.skipIf(!HAS_DOCKER)("컨테이너와 시드가 실제로 살아 있다", () => {
  it("ping이 통하고 인덱스가 READY이며 시드 50건이 적재됐다", async () => {
    // 아래 단언들이 죽은 연결이나 빈 컬렉션 위에서 공허하게 통과하지 않도록 먼저 확인한다.
    expect((await db.admin().command({ ping: 1 }))["ok"]).toBe(1);

    const indexes: Record<string, unknown>[] = await db
      .collection("chunks")
      .listSearchIndexes()
      .toArray();
    expect(indexes.map((index) => [index["name"], index["status"]]).sort()).toEqual([
      ["text_idx", "READY"],
      ["vec_idx", "READY"],
    ]);

    expect(await db.collection("records").countDocuments()).toBe(recordIdBySeedFile.size);
    expect(await db.collection("chunks").countDocuments()).toBeGreaterThan(
      recordIdBySeedFile.size,
    );
  });
});

/* --------------------------------------------------------------------------
 * Acceptance 1
 * ----------------------------------------------------------------------- */

describe.skipIf(!HAS_DOCKER)("시드 기준 알려진 쿼리 (Acceptance 1)", () => {
  it.each(KNOWN_QUERIES)(
    "`$query` → $seedFile 이 Top-5에 있다",
    async ({ query, seedFile }) => {
      const expectedId = recordIdBySeedFile.get(seedFile);
      expect(expectedId, `${seedFile}이 적재되지 않았다`).toBeDefined();

      const { status, body } = await search({ query, limit: 5 });

      expect(status).toBe(200);
      const ids = resultsOf(body).map((hit) => hit["recordId"]);
      // 순위를 콕 집지 않는다 — 동점 처리에 기대면 간헐 실패한다(T-011 F-9).
      expect(ids).toContain(expectedId);
      expect(ids.length).toBeLessThanOrEqual(5);
    },
    QUERY_TIMEOUT_MS,
  );

  it("결과가 계약을 만족한다 — SearchResponse.parse 왕복", async () => {
    const { body } = await search({ query: KNOWN_QUERIES[0]?.query ?? "", limit: 5 });

    expect(SearchResponse.parse(body)).toEqual(body);
  });
});

/* --------------------------------------------------------------------------
 * Acceptance 2·3
 * ----------------------------------------------------------------------- */

describe.skipIf(!HAS_DOCKER)("limit (Acceptance 2)", () => {
  it("limit이 20을 넘으면 400이다", async () => {
    const { status, body } = await search({ query: "proxy_buffering", limit: 21 });

    expect(status).toBe(400);
    expect((body["error"] as Record<string, unknown>)["code"]).toBe("VALIDATION_FAILED");
  });

  it("limit이 결과 수를 실제로 자른다 — 계약값이 RETRIEVAL_FINAL_K를 이긴다", async () => {
    // 흔한 토큰이라 후보가 충분하다. FINAL_K(8)가 이겼다면 아래가 8이 된다.
    const two = await search({ query: "배포", limit: 2 });
    const wide = await search({ query: "배포", limit: 10 });

    expect(resultsOf(two.body).length).toBeLessThanOrEqual(2);
    // 후보가 3건 이상 있다는 것을 보여야 위 단언이 공허하지 않다.
    expect(resultsOf(wide.body).length).toBeGreaterThan(resultsOf(two.body).length);
  });

  it("limit을 생략하면 5건 이하다 — 계약 기본값이 적용된다", async () => {
    const { body } = await search({ query: "배포" });

    expect(resultsOf(body).length).toBeLessThanOrEqual(5);
  });
});

describe.skipIf(!HAS_DOCKER)("응답에 record 본문이 없다 (Acceptance 3 · NFR-03)", () => {
  it("실제 시드 본문 문장이 응답 어디에도 없다", async () => {
    const seedFile = "incidents/INC-06.json";
    const record = recordBySeedFile.get(seedFile);
    expect(record).toBeDefined();
    expect(record?.type).toBe("incident");

    const { raw, body } = await search({ query: "proxy_buffering", limit: 5 });

    // 이 레코드가 결과에 실제로 들어 있어야 검사가 공허하지 않다.
    expect(resultsOf(body).map((hit) => hit["recordId"])).toContain(
      recordIdBySeedFile.get(seedFile),
    );

    const incident = record as Extract<RecordSchema, { type: "incident" }>;
    // 본문 섹션 전문은 물론이고, 요약에 쓰이지 않는 섹션의 조각도 새면 안 된다.
    expect(raw).not.toContain(incident.resolution);
    expect(raw).not.toContain(incident.rootCause ?? " 없음");
    expect(raw).not.toContain(incident.prevention ?? " 없음");
    // 청크 본문에는 `[제목] (섹션)` prefix가 붙는다. 그게 보이면 청크를 실은 것이다.
    expect(raw).not.toContain(`(resolution)`);
    expect(raw).not.toContain(`(symptom)`);

    for (const hit of resultsOf(body)) {
      expect(Object.keys(hit).sort()).toEqual([
        "flags",
        "project",
        "recordId",
        "score",
        "section",
        "summary",
        "title",
        "type",
      ]);
    }
  });

  it("summary는 레코드의 서버 생성 요약과 정확히 같다", async () => {
    const seedFile = "incidents/INC-06.json";
    const expectedId = recordIdBySeedFile.get(seedFile);
    const record = recordBySeedFile.get(seedFile);

    const { body } = await search({ query: "proxy_buffering", limit: 5 });
    const hit = resultsOf(body).find((entry) => entry["recordId"] === expectedId);

    expect(hit?.["summary"]).toBe(record?.summary);
    expect(hit?.["title"]).toBe(record?.title);
  });
});

/* --------------------------------------------------------------------------
 * 레이턴시 (Scope · NFR-01)
 * ----------------------------------------------------------------------- */

describe.skipIf(!HAS_DOCKER)("레이턴시 로깅", () => {
  /**
   * **NFR-01의 임계값(p95 < 1.5s)을 여기서 단언하지 않는다.**
   * 이 컨테이너는 개발 머신의 단일 노드 atlas-local이고 시드는 50건이다 — 운영 토폴로지가
   * 아니므로 여기서 1.5s를 통과했다는 사실은 운영 p95에 대해 아무것도 보장하지 않고,
   * 반대로 느린 CI 러너에서 실패하면 **NFR과 무관한 간헐 실패**가 된다.
   * 여기서 잠그는 것은 **p95를 계산할 수 있는 필드가 실제로 나간다**는 것이고,
   * 실측값은 로그로 남겨 태스크 보고에 싣는다.
   */
  it("p95를 계산할 수 있는 필드가 실제 검색에서도 나간다", async () => {
    const before = logs.length;
    const samples = 10;
    for (let index = 0; index < samples; index += 1) {
      const known = KNOWN_QUERIES[index % KNOWN_QUERIES.length];
      await search({ query: known?.query ?? "배포", limit: 5 });
    }

    const lines = logs.slice(before).filter((line) => line["msg"] === SEARCH_LOG_EVENT);
    expect(lines).toHaveLength(samples);

    const totals = lines.map((line) => line["totalMs"] as number);
    for (const line of lines) {
      expect(typeof line["totalMs"]).toBe("number");
      expect(typeof line["retrievalMs"]).toBe("number");
      // 실제 검색이므로 두 값 모두 양수여야 한다 — 0이면 시계가 배선되지 않은 것이다.
      expect(line["totalMs"] as number).toBeGreaterThan(0);
      expect(line["retrievalMs"] as number).toBeGreaterThan(0);
      // 검색이 핸들러의 부분집합이다. 뒤집히면 구간을 잘못 재고 있다.
      expect(line["retrievalMs"] as number).toBeLessThanOrEqual(line["totalMs"] as number);
      // T-013의 임계값 스윕 근거. 벡터 경로가 돌았으므로 null이 아니다.
      expect(line["maxVectorScore"]).not.toBeNull();
    }

    const sorted = [...totals].sort((a, b) => a - b);
    const p95 = sorted[Math.min(sorted.length - 1, Math.ceil(sorted.length * 0.95) - 1)] ?? 0;
    console.warn(
      `[T-012] atlas-local 실측(시드 50건, n=${String(samples)}): ` +
        `p95 totalMs=${String(p95)} / min=${String(sorted[0])} / max=${String(sorted[sorted.length - 1])}. ` +
        "운영 토폴로지가 아니므로 NFR-01 판정이 아니라 계측 배선의 증거다.",
    );
    expect(p95).toBeGreaterThan(0);
  }, QUERY_TIMEOUT_MS);
});
