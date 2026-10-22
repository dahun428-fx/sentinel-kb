/**
 * T-053 통합 테스트 — 임베딩 세대 장부와 재임베딩 잡 투입 (P1 리뷰 C1).
 *
 * UPLIFT P3(fake)에서 만든 청크가 P4(Voyage)로 넘어가 같은 `embeddingVersion`에 섞이는 경로를 재현한다.
 * 기대값은 리터럴이다.
 */
import {
  connect,
  claimEmbeddingGeneration,
  EmbeddingGenerationMismatchError,
} from "@sentinel/core/db";
import type { MongoMemoryServer } from "mongodb-memory-server";
import { startMemoryServer } from "@sentinel/core/testing/memory-server";
import { ObjectId, type Db, type MongoClient } from "mongodb";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";

import { enqueueReembedJobs } from "./reembed.js";

const BOOT_TIMEOUT_MS = 120_000;
const FAKE = "fake/dim=8";
const VOYAGE = "voyage/voyage-3/dim=8/input-type";
const NOW = new Date("2026-10-22T00:00:00.000Z");

let server: MongoMemoryServer;
let client: MongoClient;
let db: Db;

beforeAll(async () => {
  server = await startMemoryServer();
  client = await connect({
    uri: server.getUri(),
    dbName: "sentinel_generations_int_test",
    serverSelectionTimeoutMS: 10_000,
  });
  db = client.db("sentinel_generations_int_test");
}, BOOT_TIMEOUT_MS);

afterAll(async () => {
  await client.close();
  await server.stop();
});

beforeEach(async () => {
  await Promise.all(
    ["records", "chunks", "jobs", "embedding_generations"].map((name) =>
      db.collection(name).deleteMany({}),
    ),
  );
});

describe("claimEmbeddingGeneration", () => {
  it("빈 DB에서는 세대를 기록하고, 같은 임베더의 두 번째 기동은 통과한다", async () => {
    await expect(
      claimEmbeddingGeneration(db, { version: 1, identity: FAKE, now: NOW }),
    ).resolves.toBe("claimed");
    await expect(
      claimEmbeddingGeneration(db, { version: 1, identity: FAKE, now: NOW }),
    ).resolves.toBe("matched");
  });

  it("fake로 만든 세대에 Voyage로 기동하면 두 이름을 대고 거부한다 — P3→P4 전환 사고", async () => {
    await claimEmbeddingGeneration(db, { version: 1, identity: FAKE, now: NOW });

    const attempt = claimEmbeddingGeneration(db, { version: 1, identity: VOYAGE, now: NOW });
    await expect(attempt).rejects.toBeInstanceOf(EmbeddingGenerationMismatchError);
    await expect(attempt).rejects.toThrow(/fake\/dim=8.*voyage\/voyage-3/);
  });

  it("장부 없이 그 버전의 청크가 있으면 출처를 모르는 벡터라 거부한다", async () => {
    await db
      .collection("chunks")
      .insertOne({ recordId: new ObjectId(), embeddingVersion: 1, text: "x" });

    await expect(
      claimEmbeddingGeneration(db, { version: 1, identity: VOYAGE, now: NOW }),
    ).rejects.toThrow(/기록이 없다/);
  });

  it("버전을 올리면 새 임베더로 기동할 수 있다 — 옛 세대의 청크는 막지 않는다", async () => {
    await claimEmbeddingGeneration(db, { version: 1, identity: FAKE, now: NOW });
    await db
      .collection("chunks")
      .insertOne({ recordId: new ObjectId(), embeddingVersion: 1, text: "x" });

    await expect(
      claimEmbeddingGeneration(db, { version: 2, identity: VOYAGE, now: NOW }),
    ).resolves.toBe("claimed");
  });

  it("동시에 기동해도 한 세대에 한 임베더만 기록된다", async () => {
    const results = await Promise.allSettled([
      claimEmbeddingGeneration(db, { version: 1, identity: FAKE, now: NOW }),
      claimEmbeddingGeneration(db, { version: 1, identity: VOYAGE, now: NOW }),
    ]);

    expect(results.filter((result) => result.status === "fulfilled")).toHaveLength(1);
    expect(await db.collection("embedding_generations").countDocuments()).toBe(1);
  });
});

describe("enqueueReembedJobs", () => {
  async function record(fields: { status: string; embeddingVersion: number }): Promise<ObjectId> {
    const { insertedId } = await db.collection("records").insertOne({ ...fields, title: "t" });
    return insertedId;
  }

  it("워터마크가 새 버전보다 낮은 published 레코드에만 잡을 넣는다", async () => {
    const stale = await record({ status: "published", embeddingVersion: 1 });
    await record({ status: "published", embeddingVersion: 2 });
    await record({ status: "draft", embeddingVersion: 0 });

    await expect(enqueueReembedJobs(db, 2, NOW)).resolves.toBe(1);

    const jobs = await db.collection("jobs").find().toArray();
    expect(jobs).toHaveLength(1);
    expect(jobs[0]).toMatchObject({
      type: "embed",
      recordId: stale,
      status: "pending",
      attempts: 0,
    });
  });

  it("이미 대기 중인 잡이 있는 레코드는 건너뛴다 — 두 번 돌려도 잡이 불어나지 않는다", async () => {
    await record({ status: "published", embeddingVersion: 0 });

    await expect(enqueueReembedJobs(db, 1, NOW)).resolves.toBe(1);
    await expect(enqueueReembedJobs(db, 1, NOW)).resolves.toBe(0);
    expect(await db.collection("jobs").countDocuments()).toBe(1);
  });
});
