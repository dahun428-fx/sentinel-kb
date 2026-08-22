/**
 * T-010 통합 테스트. **`mongodb/mongodb-atlas-local` 컨테이너를 쓴다.**
 *
 * `mongodb-memory-server`는 `$vectorSearch`·`$search`를 지원하지 않는다 — 검색 인덱스
 * 생성 자체가 불가능하다. specs/05가 정정한 대로 atlas-local 컨테이너는 둘 다 그대로
 * 지원하므로 클라우드 자격증명 없이 Acceptance 3("인덱스 READY 후 $vectorSearch 1건 성공")을
 * 실제로 판정한다.
 *
 * **컨테이너를 못 쓰는 환경에서는 skip한다. 통과시키지 않는다.**
 * skip은 조용히 일어나지 않는다 — 아래 `console.warn`이 이유를 찍고 vitest가 skip으로 표시한다.
 * "docker가 없으니 그린"은 가짜 그린이라 절대 하지 않는다.
 *
 * testcontainers 대신 `docker` CLI를 직접 부른다: 컨테이너가 하나뿐이고 수명이 파일 하나에
 * 갇혀 있어 새 devDependency(전이 의존 포함)를 늘릴 만한 이득이 없다.
 */
import { spawnSync } from "node:child_process";

import { MongoClient, type Db, type Document } from "mongodb";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";

import {
  buildSearchIndexPlans,
  ensureSearchIndexes,
  readVectorNumDimensions,
  waitForSearchIndexesReady,
} from "./search-indexes.js";

const IMAGE = "mongodb/mongodb-atlas-local:latest";
const CONTAINER_NAME = `sentinel-t010-${process.pid}`;
const DB_NAME = "sentinel_t010_int";
/** 테스트 전용 차원. 실제 모델 차원과 무관해야 env가 소스임이 드러난다. */
const DIM = 4;
/** 이미지 pull(~2GB)까지 감안한 부팅 상한. */
const BOOT_TIMEOUT_MS = 600_000;
const QUERY_TIMEOUT_MS = 60_000;

function docker(args: string[]): { status: number; stdout: string; stderr: string } {
  const result = spawnSync("docker", args, { encoding: "utf8" });
  return {
    status: result.status ?? -1,
    stdout: result.stdout ?? "",
    stderr: result.stderr ?? "",
  };
}

function dockerAvailable(): boolean {
  return docker(["info", "--format", "{{.ServerVersion}}"]).status === 0;
}

const HAS_DOCKER = dockerAvailable();
if (!HAS_DOCKER) {
  console.warn(
    [
      "",
      "==============================================================",
      "[T-010] search-indexes.int.spec.ts를 SKIP한다: docker 데몬에 닿지 못했다.",
      `        이 파일은 ${IMAGE} 컨테이너가 있어야만 $vectorSearch를 검증할 수 있다.`,
      "        skip은 '통과'가 아니다 — Acceptance 3은 이 환경에서 판정되지 않았다.",
      "==============================================================",
      "",
    ].join("\n"),
  );
}

let client: MongoClient | undefined;
let db: Db;

async function connectWithRetry(uri: string, deadline: number): Promise<MongoClient> {
  let lastError: unknown;
  while (Date.now() < deadline) {
    const candidate = new MongoClient(uri, { serverSelectionTimeoutMS: 2_000 });
    try {
      await candidate.connect();
      await candidate.db(DB_NAME).admin().command({ ping: 1 });
      return candidate;
    } catch (error) {
      lastError = error;
      await candidate.close().catch(() => undefined);
      await sleep(1_000);
    }
  }
  throw new Error(`atlas-local 컨테이너에 연결하지 못했다: ${String(lastError)}`);
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * atlas-local은 mongod와 **mongot(검색 프로세스)** 두 개를 띄운다. mongod가 먼저 붙기 때문에
 * ping이 통해도 검색은 아직 `Error connecting to localhost:27027 ... Connection refused`로 죽는다.
 * 컨테이너 부팅 레이스를 여기서 흡수하지 않으면 이 파일이 간헐적으로 실패한다(실측).
 *
 * 게이트: mongot이 살아 있으면 없는 인덱스를 향한 `$search`도 에러 없이 빈 결과를 준다.
 */
async function waitForMongot(handle: Db, deadline: number): Promise<void> {
  const probe = handle.collection("_mongot_probe");
  await handle.createCollection("_mongot_probe").catch(() => undefined);
  let lastError: unknown;

  while (Date.now() < deadline) {
    try {
      await probe
        .aggregate([{ $search: { index: "__not_created__", text: { query: "x", path: "y" } } }])
        .toArray();
      return;
    } catch (error) {
      lastError = error;
      const message = error instanceof Error ? error.message : String(error);
      // mongot이 답을 했다면(=인덱스 없음 류의 에러) 준비된 것이다.
      if (!/connection refused|connecting to localhost/i.test(message)) return;
      await sleep(500);
    }
  }
  throw new Error(`mongot이 준비되지 않았다: ${String(lastError)}`);
}

function waitForHealthy(deadline: number): void {
  while (Date.now() < deadline) {
    const status = docker([
      "inspect",
      "--format",
      "{{if .State.Health}}{{.State.Health.Status}}{{else}}nohealth{{end}}",
      CONTAINER_NAME,
    ])
      .stdout.trim();
    if (status === "healthy" || status === "nohealth") return;
    if (status === "unhealthy") throw new Error("atlas-local 컨테이너가 unhealthy다");
    spawnSync("sleep", ["1"]);
  }
  throw new Error("atlas-local 컨테이너가 제한 시간 안에 healthy가 되지 않았다");
}

/** 검색 인덱스는 READY 이후에도 새 문서를 반영하는 데 잠깐 걸린다 — 결과가 나올 때까지 폴링. */
async function pollUntilNonEmpty(run: () => Promise<Document[]>): Promise<Document[]> {
  const deadline = Date.now() + QUERY_TIMEOUT_MS;
  let last: Document[] = [];
  while (Date.now() < deadline) {
    last = await run();
    if (last.length > 0) return last;
    await sleep(300);
  }
  return last;
}

beforeAll(async () => {
  if (!HAS_DOCKER) return;

  docker(["rm", "-f", CONTAINER_NAME]);
  const run = docker(["run", "-d", "--name", CONTAINER_NAME, "-P", IMAGE]);
  if (run.status !== 0) {
    throw new Error(`컨테이너 기동 실패: ${run.stderr || run.stdout}`);
  }

  const deadline = Date.now() + BOOT_TIMEOUT_MS / 2;
  waitForHealthy(deadline);

  const port = docker(["port", CONTAINER_NAME, "27017/tcp"]).stdout.trim().split("\n")[0];
  const hostPort = port?.split(":").pop();
  if (!hostPort) throw new Error(`포트 매핑을 읽지 못했다: ${String(port)}`);

  client = await connectWithRetry(`mongodb://127.0.0.1:${hostPort}/?directConnection=true`, deadline);
  db = client.db(DB_NAME);
  await waitForMongot(db, deadline);
}, BOOT_TIMEOUT_MS);

afterAll(async () => {
  await client?.close().catch(() => undefined);
  if (HAS_DOCKER) docker(["rm", "-f", CONTAINER_NAME]);
});

/** 서버가 돌려주는 순서는 보장되지 않는다 — 이름으로 정렬해 단언을 안정화한다. */
async function listSearchIndexes(): Promise<Document[]> {
  const all = await db.collection("chunks").listSearchIndexes().toArray();
  return all.sort((a, b) => String(a["name"]).localeCompare(String(b["name"])));
}

describe.skipIf(!HAS_DOCKER)("ensureSearchIndexes on mongodb-atlas-local", () => {
  it("컨테이너가 실제로 붙었다", async () => {
    // 아래 단언들이 죽은 연결 위에서 공허하게 통과하지 않도록 먼저 확인한다.
    const pong = await db.admin().command({ ping: 1 });
    expect(pong["ok"]).toBe(1);
  });

  it("vec_idx·text_idx를 만들고 READY까지 기다린다", async () => {
    const results = await ensureSearchIndexes(db, { dim: DIM });
    expect(results.map((r) => [r.name, r.action])).toEqual([
      ["vec_idx", "created"],
      ["text_idx", "created"],
    ]);

    await waitForSearchIndexesReady(db, buildSearchIndexPlans(DIM), {
      pollIntervalMs: 500,
      readyTimeoutMs: 120_000,
    });

    const indexes = await listSearchIndexes(); // 이름순: text_idx, vec_idx
    expect(indexes.map((i) => i["name"])).toEqual(["text_idx", "vec_idx"]);
    expect(indexes.map((i) => i["status"])).toEqual(["READY", "READY"]);
    expect(indexes.map((i) => i["type"])).toEqual(["search", "vectorSearch"]);
  }, 180_000);

  it("적용된 정의가 specs/02의 filter 3종과 cosine을 그대로 갖는다", async () => {
    const vec = (await listSearchIndexes()).find((i) => i["name"] === "vec_idx");
    expect(vec?.["latestDefinition"]).toEqual({
      fields: [
        { type: "vector", path: "embedding", numDimensions: DIM, similarity: "cosine" },
        { type: "filter", path: "meta.type" },
        { type: "filter", path: "meta.project" },
        { type: "filter", path: "embeddingVersion" },
      ],
    });
  });

  it("2회 실행해도 에러 없이 동일 상태다 (Acceptance 1)", async () => {
    const before = await listSearchIndexes();

    const second = await ensureSearchIndexes(db, { dim: DIM });
    expect(second.map((r) => r.action)).toEqual(["existing", "existing"]);

    const after = await listSearchIndexes();
    expect(after.map((i) => i["id"])).toEqual(before.map((i) => i["id"]));
    expect(after.map((i) => i["latestDefinition"])).toEqual(
      before.map((i) => i["latestDefinition"]),
    );
  }, 60_000);
});

describe.skipIf(!HAS_DOCKER)("EMBEDDING_DIM 불일치 (Acceptance 2)", () => {
  it("env의 dim이 기존 인덱스와 다르면 DIM_MISMATCH로 실패한다", async () => {
    vi.stubEnv("EMBEDDING_DIM", String(DIM + 1));
    // provider·version 없이도 dim 대조 경로가 도는지 함께 확인한다 (T-006 F-4).
    vi.stubEnv("EMBEDDING_PROVIDER", "");
    vi.stubEnv("EMBEDDING_VERSION", "");
    try {
      await expect(ensureSearchIndexes(db)).rejects.toMatchObject({
        code: "SEARCH_INDEX_DIM_MISMATCH",
      });
    } finally {
      vi.unstubAllEnvs();
    }
  }, 60_000);

  it("실패했어도 기존 인덱스를 재생성하지 않는다", async () => {
    const vec = (await listSearchIndexes()).find((i) => i["name"] === "vec_idx");
    expect(readVectorNumDimensions((vec?.["latestDefinition"] ?? {}) as Document)).toBe(DIM);
  });
});

describe.skipIf(!HAS_DOCKER)("READY 이후의 실제 쿼리 (Acceptance 3)", () => {
  const chunks = (): ReturnType<Db["collection"]> => db.collection("chunks");

  beforeAll(async () => {
    if (!HAS_DOCKER) return;
    await chunks().insertMany([
      {
        text: "nginx proxy_buffering off 없이 SSE 스트리밍이 끊긴다",
        embedding: [1, 0, 0, 0],
        meta: { type: "incident", project: "sentinel-kb" },
        embeddingVersion: 1,
      },
      {
        text: "다른 프로젝트의 무관한 기록",
        embedding: [0, 1, 0, 0],
        meta: { type: "divergence", project: "bizcare-web" },
        embeddingVersion: 1,
      },
    ]);
  });

  it("$vectorSearch가 1건을 돌려준다", async () => {
    const hits = await pollUntilNonEmpty(() =>
      chunks()
        .aggregate([
          {
            $vectorSearch: {
              index: "vec_idx",
              path: "embedding",
              queryVector: [1, 0, 0, 0],
              numCandidates: 20,
              limit: 1,
            },
          },
          { $project: { _id: 0, text: 1, score: { $meta: "vectorSearchScore" } } },
        ])
        .toArray(),
    );

    expect(hits).toHaveLength(1);
    expect(hits[0]?.["text"]).toContain("proxy_buffering");
    // cosine이므로 0–1. 같은 방향 벡터라 1에 가깝다.
    expect(hits[0]?.["score"]).toBeGreaterThan(0.9);
  }, QUERY_TIMEOUT_MS + 10_000);

  it("$search(text_idx)도 1건을 돌려준다 — text_idx 정의 검증", async () => {
    const hits = await pollUntilNonEmpty(() =>
      chunks()
        .aggregate([
          { $search: { index: "text_idx", text: { query: "proxy_buffering", path: "text" } } },
          { $project: { _id: 0, text: 1, score: { $meta: "searchScore" } } },
        ])
        .toArray(),
    );

    expect(hits).toHaveLength(1);
    expect(hits[0]?.["score"]).toBeGreaterThan(0);
  }, QUERY_TIMEOUT_MS + 10_000);

  it("meta.project filter가 실제로 걸러낸다", async () => {
    const mine = await pollUntilNonEmpty(() => vectorSearchFiltered({ "meta.project": "sentinel-kb" }));
    expect(mine.map((h) => h["meta"]?.["project"])).toEqual(["sentinel-kb"]);

    const other = await vectorSearchFiltered({ "meta.project": "bizcare-web" });
    expect(other.map((h) => h["meta"]?.["project"])).toEqual(["bizcare-web"]);

    const none = await vectorSearchFiltered({ "meta.project": "no-such-project" });
    expect(none).toEqual([]);
  }, QUERY_TIMEOUT_MS + 10_000);

  it("meta.type·embeddingVersion filter도 동작한다", async () => {
    const incidents = await pollUntilNonEmpty(() => vectorSearchFiltered({ "meta.type": "incident" }));
    expect(incidents.map((h) => h["meta"]?.["type"])).toEqual(["incident"]);

    const v1 = await pollUntilNonEmpty(() => vectorSearchFiltered({ embeddingVersion: 1 }));
    expect(v1.length).toBeGreaterThan(0);
    expect(await vectorSearchFiltered({ embeddingVersion: 99 })).toEqual([]);
  }, QUERY_TIMEOUT_MS + 10_000);

  /**
   * `.claude/skills/mongo-vector-ops/SKILL.md`: "필터로 쓸 필드는 **반드시 인덱스에 filter로
   * 선언**해야 한다. 빠뜨리면 필터가 무시되는 게 아니라 쿼리가 실패한다."
   * specs/02:93은 filter 필드 **목록**만 정하고 이 실패 양상은 말하지 않는다 — 인용 출처를
   * 헷갈리지 마라. 이 테스트가 그 경고를 잠근다: filter 선언을 하나라도 빼면 위 테스트들이 이렇게 죽는다.
   *
   * 정규식이 서버 에러 문구에 의존한다. 이 문구는 드라이버가 아니라 **mongot**이 만들며
   * (`code: 8 / UnknownError`라 코드로는 식별 불가), 문구가 바뀌면 이 테스트는 조용히
   * 그린이 되는 게 아니라 실패한다 — 무력화가 아니라 소음이다.
   */
  it("선언하지 않은 필드로 필터하면 쿼리가 실패한다", async () => {
    await expect(vectorSearchFiltered({ "meta.severity": "SEV1" })).rejects.toThrow(
      /needs to be indexed as filter/i,
    );
  }, 30_000);

  async function vectorSearchFiltered(equals: Record<string, unknown>): Promise<Document[]> {
    const filter = Object.fromEntries(
      Object.entries(equals).map(([path, value]) => [path, { $eq: value }]),
    );
    return chunks()
      .aggregate([
        {
          $vectorSearch: {
            index: "vec_idx",
            path: "embedding",
            queryVector: [1, 0, 0, 0],
            numCandidates: 20,
            limit: 5,
            filter,
          },
        },
        { $project: { _id: 0, text: 1, meta: 1 } },
      ])
      .toArray();
  }
});
