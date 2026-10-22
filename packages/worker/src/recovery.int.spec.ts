/**
 * T-054 통합 테스트 — 멈춘 running 잡 회수와 failed·dead 재투입 (P1 리뷰 C2·C3).
 */
import { connect } from "@sentinel/core/db";
import { MongoMemoryServer } from "mongodb-memory-server";
import { ObjectId, type Db, type MongoClient } from "mongodb";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";

import { claimNextJob } from "./jobs.js";
import { parseRequeueStatuses, requeueJobs } from "./requeue.js";

const BOOT_TIMEOUT_MS = 120_000;
const NOW = new Date("2026-10-22T12:00:00.000Z");
const LEASE_MS = 600_000;
const MAX_ATTEMPTS = 3;

let server: MongoMemoryServer;
let client: MongoClient;
let db: Db;

beforeAll(async () => {
  server = await MongoMemoryServer.create();
  client = await connect({
    uri: server.getUri(),
    dbName: "sentinel_recovery_int_test",
    serverSelectionTimeoutMS: 10_000,
  });
  db = client.db("sentinel_recovery_int_test");
}, BOOT_TIMEOUT_MS);

afterAll(async () => {
  await client.close();
  await server.stop();
});

beforeEach(async () => {
  await db.collection("jobs").deleteMany({});
});

async function job(fields: {
  status: string;
  attempts: number;
  updatedAt: Date;
}): Promise<ObjectId> {
  const { insertedId } = await db.collection("jobs").insertOne({
    type: "embed",
    recordId: new ObjectId(),
    createdAt: new Date("2026-10-22T00:00:00.000Z"),
    ...fields,
  });
  return insertedId;
}

const minutesAgo = (minutes: number): Date => new Date(NOW.getTime() - minutes * 60_000);

describe("리스가 지난 running 잡 회수 (C2)", () => {
  it("11분째 running인 잡을 다시 집고 시도 1회로 센다", async () => {
    const id = await job({ status: "running", attempts: 0, updatedAt: minutesAgo(11) });

    const claimed = await claimNextJob(db, NOW, 2000, LEASE_MS, MAX_ATTEMPTS);

    expect(claimed?._id).toEqual(id);
    expect(claimed).toMatchObject({ status: "running", attempts: 1, updatedAt: NOW });
  });

  it("리스 안의 running 잡은 건드리지 않는다 — 다른 워커가 처리 중일 수 있다", async () => {
    await job({ status: "running", attempts: 0, updatedAt: minutesAgo(5) });

    await expect(claimNextJob(db, NOW, 2000, LEASE_MS, MAX_ATTEMPTS)).resolves.toBeNull();
  });

  it("회수로 상한에 닿으면 처리하지 않고 dead로 끝낸 뒤 다음 잡을 집는다", async () => {
    const poison = await job({ status: "running", attempts: 2, updatedAt: minutesAgo(30) });
    const next = await job({ status: "pending", attempts: 0, updatedAt: minutesAgo(1) });

    const claimed = await claimNextJob(db, NOW, 2000, LEASE_MS, MAX_ATTEMPTS);

    expect(claimed?._id).toEqual(next);
    expect(await db.collection("jobs").findOne({ _id: poison })).toMatchObject({
      status: "dead",
      attempts: 3,
    });
  });
});

describe("failed·dead 재투입 (C3)", () => {
  it("failed·dead를 pending으로, attempts를 0으로 되돌린다. done·running은 건드리지 않는다", async () => {
    await job({ status: "failed", attempts: 0, updatedAt: minutesAgo(60) });
    await job({ status: "dead", attempts: 3, updatedAt: minutesAgo(60) });
    await job({ status: "done", attempts: 1, updatedAt: minutesAgo(60) });
    await job({ status: "running", attempts: 0, updatedAt: minutesAgo(1) });

    await expect(requeueJobs(db, ["failed", "dead"], NOW)).resolves.toBe(2);

    const statuses = (await db.collection("jobs").find().toArray()).map((doc) => [
      doc["status"],
      doc["attempts"],
    ]);
    expect(statuses.sort()).toEqual(
      [
        ["done", 1],
        ["pending", 0],
        ["pending", 0],
        ["running", 0],
      ].sort(),
    );
  });

  it("되돌린 잡은 백오프 없이 바로 집힌다", async () => {
    await job({ status: "dead", attempts: 3, updatedAt: minutesAgo(60) });
    await requeueJobs(db, ["dead"], NOW);

    await expect(claimNextJob(db, NOW, 2000, LEASE_MS, MAX_ATTEMPTS)).resolves.toMatchObject({
      status: "running",
    });
  });

  it("--status 인자를 해석하고 모르는 값은 거부한다", () => {
    expect(parseRequeueStatuses([])).toEqual(["failed", "dead"]);
    expect(parseRequeueStatuses(["--status=failed"])).toEqual(["failed"]);
    expect(() => parseRequeueStatuses(["--status=done"])).toThrow(/failed\|dead/);
  });
});
