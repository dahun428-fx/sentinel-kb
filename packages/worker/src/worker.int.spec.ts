import {
  createFakeEmbedder,
  deterministicVector,
  EMBEDDER_ERROR_CODES,
  EmbedderError,
  type Embedder,
} from "@sentinel/core";
import { connect, ensureIndexes } from "@sentinel/core/db";
import { MongoMemoryServer } from "mongodb-memory-server";
import { ObjectId, type Db, type MongoClient } from "mongodb";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

import { createEmbedWorker, type EmbedWorker, type JobOutcome } from "./worker.js";

/**
 * T-008 통합 테스트. specs/05가 "Integration: … mongodb-memory-server(벡터 외)"를 허용한다.
 *
 * **env의 MONGODB_URI에 의존하지 않는다.** CI의 integration 스텝은 존재하지 않는 시크릿을
 * 주입해 빈 문자열이 들어온다 — 거기 기대면 CI에서 반드시 깨진다(T-003이 확인). 메모리 서버를
 * 여기서 직접 띄우고 그 URI만 쓴다. 임베딩은 `FakeEmbedder`를 주입한다(specs/05 결정론 원칙).
 *
 * 기대값은 **구현 상수에서 끌어오지 않고 리터럴로 박는다.** 상수를 참조하면 상수를 고쳤을 때
 * 기대값도 따라 움직여 아무것도 검증하지 못한다(T-004·T-006에서 반복 확인된 실패 양식).
 */
const BOOT_TIMEOUT_MS = 120_000; // 첫 실행은 mongod 바이너리를 내려받는다
const DB_NAME = "sentinel_worker_int_test";

/** 테스트가 쓰는 임베딩 세대·차원. 리터럴이며 프로덕션 env와 무관하다. */
const TEST_DIM = 8;
const TEST_VERSION = 1;

let server: MongoMemoryServer;
let client: MongoClient;
let db: Db;

beforeAll(async () => {
  server = await MongoMemoryServer.create();
  client = await connect({
    uri: server.getUri(),
    dbName: DB_NAME,
    serverSelectionTimeoutMS: 10_000,
  });
  db = client.db(DB_NAME);
  await ensureIndexes(db);
}, BOOT_TIMEOUT_MS);

afterAll(async () => {
  await client.close();
  await server.stop();
});

beforeEach(async () => {
  await Promise.all(
    ["records", "chunks", "jobs"].map(async (name) => db.collection(name).deleteMany({})),
  );
});

afterEach(() => {
  vi.unstubAllEnvs();
});

// ---------------------------------------------------------------- fixtures

interface RecordFields {
  readonly title?: string;
  readonly symptom?: string;
  readonly rootCause?: string;
  readonly resolution?: string;
  readonly prevention?: string;
}

async function insertRecord(fields: RecordFields = {}): Promise<ObjectId> {
  const at = new Date("2026-01-01T00:00:00.000Z");
  const { insertedId } = await db.collection("records").insertOne({
    type: "incident",
    project: "sentinel-kb",
    title: fields.title ?? "결제 큐가 멈춘 장애",
    summary: "결제 큐가 멈췄다.",
    severity: "SEV2",
    tags: ["queue"],
    sanitizeFlags: [],
    relations: [],
    status: "published",
    embeddingVersion: 0,
    symptom: fields.symptom ?? "결제 요청이 큐에 쌓이기만 하고 소비되지 않았다.",
    resolution: fields.resolution ?? "컨슈머를 재기동하고 프리페치 수를 낮췄다.",
    ...(fields.rootCause === undefined ? {} : { rootCause: fields.rootCause }),
    ...(fields.prevention === undefined ? {} : { prevention: fields.prevention }),
    createdAt: at,
    updatedAt: at,
  });
  return insertedId;
}

async function enqueue(recordId: ObjectId, createdAt = new Date()): Promise<ObjectId> {
  const { insertedId } = await db.collection("jobs").insertOne({
    type: "embed",
    recordId,
    status: "pending",
    attempts: 0,
    createdAt,
    updatedAt: createdAt,
  });
  return insertedId;
}

interface StoredChunk {
  _id: ObjectId;
  section: string;
  seq: number;
  text: string;
  embedding: number[];
  embeddingVersion: number;
  meta: Record<string, unknown>;
}

async function chunksOf(recordId: ObjectId, embeddingVersion?: number): Promise<StoredChunk[]> {
  const filter = embeddingVersion === undefined ? { recordId } : { recordId, embeddingVersion };
  return (await db
    .collection("chunks")
    .find(filter)
    .sort({ section: 1, seq: 1 })
    .toArray()) as unknown as StoredChunk[];
}

interface StoredJob {
  status: string;
  attempts: number;
  lastError?: string;
}

async function jobOf(jobId: ObjectId): Promise<StoredJob> {
  const doc = await db.collection("jobs").findOne({ _id: jobId });
  expect(doc, "job이 사라졌다").not.toBeNull();
  return doc as unknown as StoredJob;
}

async function watermarkOf(recordId: ObjectId): Promise<number> {
  const doc = await db.collection("records").findOne({ _id: recordId });
  return (doc as unknown as { embeddingVersion: number }).embeddingVersion;
}

function fakeEmbedder(version: number = TEST_VERSION): Embedder {
  return createFakeEmbedder({ dim: TEST_DIM, version });
}

/** 항상 같은 에러로 실패하는 embedder. 재시도 사다리를 시험한다. */
function failingEmbedder(error: unknown): Embedder {
  return {
    dim: TEST_DIM,
    version: TEST_VERSION,
    embed: () => Promise.reject(error),
  };
}

function makeWorker(overrides: Partial<Parameters<typeof createEmbedWorker>[0]> = {}): EmbedWorker {
  return createEmbedWorker({ db, embedder: fakeEmbedder(), pollIntervalMs: 5, ...overrides });
}

// ---------------------------------------------------------------- acceptance

describe("Acceptance 1 — job 처리 후 chunks가 chunker 출력과 일치한다", () => {
  it("섹션마다 청크 1개가 생기고 텍스트·메타·벡터가 계약대로다", async () => {
    const recordId = await insertRecord({
      rootCause: "컨슈머 프리페치가 과도해 브로커가 스로틀링했다.",
      prevention: "프리페치 상한을 배포 체크리스트에 넣었다.",
    });
    const jobId = await enqueue(recordId);

    const outcome = await makeWorker().runOnce();

    expect(outcome?.jobId).toBe(jobId.toHexString());
    expect(outcome?.status).toBe("done");
    expect(outcome?.chunkCount).toBe(4);

    const stored = await chunksOf(recordId);
    // specs/03 §1-2의 섹션 순서(symptom→rootCause→resolution→prevention)를 리터럴로 박는다.
    // 빈 섹션은 스킵이므로 4개 섹션이 모두 채워진 이 record는 정확히 4청크여야 한다.
    expect(stored.map((chunk) => `${chunk.section}#${String(chunk.seq)}`)).toEqual([
      "prevention#0",
      "resolution#0",
      "rootCause#0",
      "symptom#0",
    ]);

    const symptom = stored.find((chunk) => chunk.section === "symptom");
    // 청크 텍스트 형식 `"[{title}] ({section}) {body}"` — specs/03 §1-2.
    expect(symptom?.text).toBe(
      "[결제 큐가 멈춘 장애] (symptom) 결제 요청이 큐에 쌓이기만 하고 소비되지 않았다.",
    );
    expect(symptom?.meta).toEqual({
      type: "incident",
      project: "sentinel-kb",
      severity: "SEV2",
      tags: ["queue"],
      sanitizeFlags: [],
    });

    for (const chunk of stored) {
      expect(chunk.embeddingVersion).toBe(1);
      expect(chunk.embedding).toHaveLength(8);
      // 벡터가 **자기 청크의 텍스트**에서 나왔는지 확인한다. 배치 순서가 어긋나면
      // 개수·차원은 그대로인 채 청크마다 남의 벡터가 붙는다 — 검색에서만 드러나는 손상이다.
      expect(chunk.embedding).toEqual(deterministicVector(chunk.text, 8));
    }

    const job = await jobOf(jobId);
    expect(job.status).toBe("done");
    expect(job.attempts).toBe(0);
  });
});

describe("Acceptance 2 — 같은 job을 2회 처리해도 chunks가 중복 생성되지 않는다", () => {
  it("두 번째 처리는 같은 도큐먼트를 덮어쓴다(insert가 아니라 upsert)", async () => {
    const recordId = await insertRecord({ rootCause: "브로커 스로틀링." });
    const jobId = await enqueue(recordId);
    const worker = makeWorker();

    await worker.runOnce();
    const first = await chunksOf(recordId);
    expect(first).toHaveLength(3);

    // 같은 잡을 다시 큐에 올린다 — 재시도·중복 이벤트로 실제로 벌어지는 상황이다.
    await db
      .collection("jobs")
      .updateOne({ _id: jobId }, { $set: { status: "pending", updatedAt: new Date() } });
    const second = await worker.runOnce();

    expect(second?.status).toBe("done");
    const after = await chunksOf(recordId);
    expect(after).toHaveLength(3);
    // _id가 보존돼야 upsert다. delete+insert였다면 여기서 갈린다.
    expect(after.map((chunk) => chunk._id.toHexString())).toEqual(
      first.map((chunk) => chunk._id.toHexString()),
    );
    expect(await watermarkOf(recordId)).toBe(1);
  });
});

describe("Acceptance 3 — 실패 시 attempts가 오르고 3회째에 dead가 된다", () => {
  it("일시 실패(RETRY_EXHAUSTED)는 재큐잉되다가 3회째에 dead로 간다", async () => {
    const recordId = await insertRecord();
    const jobId = await enqueue(recordId);
    // **시계를 직접 민다.** 재시도는 백오프를 거치므로 `runOnce()`를 연달아 불러도
    // 잡이 다시 집히지 않는다 — 그게 정상이다. 실제 시간을 기다리면 테스트가 느려지고
    // 백오프가 실제로 걸렸는지도 확인할 수 없다.
    let clock = Date.now();
    const worker = makeWorker({
      now: () => new Date(clock),
      retryBackoffMs: 1000,
      embedder: failingEmbedder(
        new EmbedderError(EMBEDDER_ERROR_CODES.RETRY_EXHAUSTED, "429를 소진했다"),
      ),
    });

    const first = await worker.runOnce();
    expect(first?.status).toBe("pending");
    expect(first?.attempts).toBe(1);

    // 백오프가 지나기 전에는 같은 잡을 다시 집지 않는다.
    // 이 단언이 없으면 "재시도가 밀리초 안에 소진되는" 결함이 되돌아와도 아무도 모른다.
    expect(await worker.runOnce()).toBeUndefined();

    clock += 1000; // attempts=1 → 1000ms
    const second = await worker.runOnce();
    expect(second?.status).toBe("pending");
    expect(second?.attempts).toBe(2);

    clock += 1000; // attempts=2 → 2000ms 필요. 아직 부족하다.
    expect(await worker.runOnce()).toBeUndefined();

    clock += 1000;
    const third = await worker.runOnce();
    expect(third?.status).toBe("dead");
    expect(third?.attempts).toBe(3);

    const dead = await jobOf(jobId);
    expect(dead.status).toBe("dead");
    expect(dead.attempts).toBe(3);
    expect(dead.lastError).toContain("EMBEDDER_RETRY_EXHAUSTED");

    // dead는 종착 상태다 — 다시 집히면 안 된다.
    expect(await worker.runOnce()).toBeUndefined();
    // 실패했으므로 청크도 워터마크도 움직이지 않았다.
    expect(await chunksOf(recordId)).toHaveLength(0);
    expect(await watermarkOf(recordId)).toBe(0);
  });

  it("영구 실패(REQUEST_FAILED)는 attempts를 태우지 않고 즉시 failed로 끝난다", async () => {
    const recordId = await insertRecord();
    const jobId = await enqueue(recordId);
    const worker = makeWorker({
      embedder: failingEmbedder(
        new EmbedderError(EMBEDDER_ERROR_CODES.REQUEST_FAILED, "400 Bad Request"),
      ),
    });

    const outcome = await worker.runOnce();

    expect(outcome?.status).toBe("failed");
    expect(outcome?.attempts).toBe(1);
    const job = await jobOf(jobId);
    expect(job.status).toBe("failed");
    expect(job.lastError).toContain("EMBEDDER_REQUEST_FAILED");
    // 재큐잉되지 않는다 — 재시도해도 결과가 같은 실패에 attempts를 태우면 안 된다.
    expect(await worker.runOnce()).toBeUndefined();
  });

  it("설정 오류가 잡마다 큐를 태우지 않는다(record 없음 = 영구 실패)", async () => {
    const missingRecordId = new ObjectId();
    const jobId = await enqueue(missingRecordId);

    const outcome = await makeWorker().runOnce();

    expect(outcome?.status).toBe("failed");
    expect((await jobOf(jobId)).lastError).toContain("WORKER_RECORD_NOT_FOUND");
  });
});

describe("Acceptance 4 — 동시 워커 2개가 같은 job을 중복 처리하지 않는다", () => {
  it("두 워커를 동시에 돌려도 처리한 jobId 집합의 교집합이 비어 있다", async () => {
    const jobIds: string[] = [];
    for (let index = 0; index < 20; index += 1) {
      const recordId = await insertRecord({ title: `동시성 검증 레코드 ${String(index)}` });
      jobIds.push((await enqueue(recordId)).toHexString());
    }

    // 두 워커가 **실제로 동시에** 임베딩 구간에 들어갈 때까지 서로를 기다리게 만든다.
    // 이 게이트가 없으면 한 워커가 전부 처리해 버려 교집합 단언이 우연히 통과한다.
    const gate = createGate(2);
    const workerA = makeWorker({ embedder: gatedEmbedder(fakeEmbedder(), gate) });
    const workerB = makeWorker({ embedder: gatedEmbedder(fakeEmbedder(), gate) });

    const [processedByA, processedByB] = await Promise.all([drain(workerA), drain(workerB)]);

    expect(processedByA.length).toBeGreaterThan(0);
    expect(processedByB.length).toBeGreaterThan(0);
    expect(processedByA.filter((id) => processedByB.includes(id))).toEqual([]);
    expect([...processedByA, ...processedByB].sort()).toEqual([...jobIds].sort());

    const done = await db.collection("jobs").countDocuments({ status: "done" });
    expect(done).toBe(20);
    // record 1건당 symptom·resolution 2청크. 중복 처리가 있었다면 유니크 인덱스가 막아
    // 잡이 실패했을 것이므로, 총량 40이 곧 "정확히 한 번씩"의 증거다.
    expect(await db.collection("chunks").countDocuments({})).toBe(40);
  }, 30_000);
});

// ---------------------------------------------------------------- 고아 청크 / 마이그레이션

describe("고아 청크 삭제 (T-005 F-2)", () => {
  it("본문이 줄어 청크 수가 감소하면 꼬리 청크가 남지 않는다", async () => {
    // 상한을 낮춰 3청크가 나오는 본문을 짧게 만든다. specs/03 §6대로 env가 소스다.
    vi.stubEnv("CHUNK_MAX_CHARS", "200");
    const longSymptom = ["가".repeat(100), "나".repeat(100), "다".repeat(100)].join("\n\n");
    const recordId = await insertRecord({ title: "고아 청크 회귀", symptom: longSymptom });
    const worker = makeWorker();

    const firstJob = await enqueue(recordId);
    const first = await worker.runOnce();
    expect(first?.jobId).toBe(firstJob.toHexString());
    expect(first?.chunkCount).toBe(4);
    expect(first?.deletedOrphans).toBe(0);
    expect(
      (await chunksOf(recordId)).map((chunk) => `${chunk.section}#${String(chunk.seq)}`),
    ).toEqual(["resolution#0", "symptom#0", "symptom#1", "symptom#2"]);

    // 본문을 한 조각으로 줄인다.
    await db
      .collection("records")
      .updateOne({ _id: recordId }, { $set: { symptom: "짧게 고쳐 쓴 증상." } });
    await enqueue(recordId);
    const second = await worker.runOnce();

    expect(second?.chunkCount).toBe(2);
    expect(second?.deletedOrphans).toBe(2);
    const after = await chunksOf(recordId);
    expect(after.map((chunk) => `${chunk.section}#${String(chunk.seq)}`)).toEqual([
      "resolution#0",
      "symptom#0",
    ]);
    // 남은 청크는 새 본문이어야 한다. 구 본문이 남으면 지운 문장이 영원히 검색된다.
    expect(after.find((chunk) => chunk.section === "symptom")?.text).toBe(
      "[고아 청크 회귀] (symptom) 짧게 고쳐 쓴 증상.",
    );
  });

  it("다른 embeddingVersion 청크는 지우지 않는다(무중단 마이그레이션 보호)", async () => {
    vi.stubEnv("CHUNK_MAX_CHARS", "200");
    const longSymptom = ["가".repeat(100), "나".repeat(100), "다".repeat(100)].join("\n\n");
    const recordId = await insertRecord({ title: "세대 보호", symptom: longSymptom });

    // 아직 서비스 중인 다른 세대의 청크. 이번 세대의 커밋 키 집합에는 당연히 없다.
    await db.collection("chunks").insertOne({
      recordId,
      section: "symptom",
      seq: 9,
      text: "다른 세대가 만든 청크",
      embedding: [1, 0, 0, 0, 0, 0, 0, 0],
      meta: {
        type: "incident",
        project: "sentinel-kb",
        severity: "SEV2",
        tags: [],
        sanitizeFlags: [],
      },
      embeddingVersion: 2,
    });

    const worker = makeWorker();
    await enqueue(recordId);
    await worker.runOnce();

    await db
      .collection("records")
      .updateOne({ _id: recordId }, { $set: { symptom: "짧게 고쳐 쓴 증상." } });
    await enqueue(recordId);
    await worker.runOnce();

    // 세대 1은 정리됐지만 세대 2는 그대로다. 세대를 안 가리고 지우면 specs/02
    // 마이그레이션 규칙("구버전 청크는 필터 스왑 **후에** 삭제")이 깨진다.
    expect((await chunksOf(recordId, 1)).map((chunk) => chunk.seq)).toEqual([0, 0]);
    const otherGeneration = await chunksOf(recordId, 2);
    expect(otherGeneration).toHaveLength(1);
    expect(otherGeneration[0]?.text).toBe("다른 세대가 만든 청크");
  });
});

// ---------------------------------------------------------------- 워터마크 / 순서 / 종료

describe("record.embeddingVersion 워터마크", () => {
  it("청크가 전부 커밋된 뒤에만 올라간다", async () => {
    const recordId = await insertRecord();
    const jobId = await enqueue(recordId);
    // chunks 쓰기만 실패시킨다. 워터마크를 먼저 올리는 구현이라면 여기서 드러난다.
    const worker = createEmbedWorker({
      db: withFailingChunkWrites(db),
      embedder: fakeEmbedder(),
      pollIntervalMs: 5,
    });

    const outcome = await worker.runOnce();

    expect(outcome?.status).toBe("pending"); // 일시 실패로 분류돼 재큐잉된다
    expect(await chunksOf(recordId)).toHaveLength(0);
    expect(await watermarkOf(recordId)).toBe(0);
    expect((await jobOf(jobId)).lastError).toContain("주입된 chunks 쓰기 실패");
  });

  it("성공하면 embedder.version으로 올라간다", async () => {
    const recordId = await insertRecord();
    await enqueue(recordId);
    expect(await watermarkOf(recordId)).toBe(0);

    await makeWorker().runOnce();

    expect(await watermarkOf(recordId)).toBe(1);
  });
});

describe("클레임 순서", () => {
  it("createdAt이 오래된 job부터 집는다(LIFO 기아 방지)", async () => {
    const newest = await enqueue(await insertRecord(), new Date("2026-03-03T00:00:00.000Z"));
    const oldest = await enqueue(await insertRecord(), new Date("2026-01-01T00:00:00.000Z"));
    const middle = await enqueue(await insertRecord(), new Date("2026-02-02T00:00:00.000Z"));
    const worker = makeWorker();

    expect((await worker.runOnce())?.jobId).toBe(oldest.toHexString());
    expect((await worker.runOnce())?.jobId).toBe(middle.toHexString());
    expect((await worker.runOnce())?.jobId).toBe(newest.toHexString());
  });

  it("embed 종류가 아닌 job은 집지 않는다", async () => {
    await db.collection("jobs").insertOne({
      type: "reindex",
      recordId: await insertRecord(),
      status: "pending",
      attempts: 0,
      createdAt: new Date("2026-01-01T00:00:00.000Z"),
      updatedAt: new Date("2026-01-01T00:00:00.000Z"),
    });

    expect(await makeWorker().runOnce()).toBeUndefined();
  });
});

/**
 * 재임베딩 창(specs/02 마이그레이션 규칙)에서는 구·신 세대 워커가 잠시 병존한다.
 * 그때 워터마크가 `$set`이면 **낮은 세대 워커가 값을 되돌린다** — 세대 5까지 올라간 record가
 * 세대 1 워커의 처리로 1이 되고, 백필 커서(`{embeddingVersion: {$lt: N}}`)가
 * 이미 끝난 record를 무한히 다시 집는다. 워터마크는 단조 증가여야 한다.
 */
describe("워터마크 단조성 (T-008 V13)", () => {
  it("낮은 세대 워커가 워터마크를 되돌리지 않는다", async () => {
    const recordId = await insertRecord();

    await enqueue(recordId);
    await makeWorker({ embedder: fakeEmbedder(5) }).runOnce();
    expect(await watermarkOf(recordId)).toBe(5);

    // 구 세대 워커가 같은 record를 처리한다(재임베딩 창의 실제 상황).
    await enqueue(recordId);
    await makeWorker({ embedder: fakeEmbedder(1) }).runOnce();

    expect(await watermarkOf(recordId)).toBe(5);
  });

  it("높은 세대 워커는 워터마크를 올린다", async () => {
    const recordId = await insertRecord();

    await enqueue(recordId);
    await makeWorker({ embedder: fakeEmbedder(1) }).runOnce();
    await enqueue(recordId);
    await makeWorker({ embedder: fakeEmbedder(5) }).runOnce();

    expect(await watermarkOf(recordId)).toBe(5);
  });
});

describe("graceful shutdown", () => {
  it("SIGTERM 경로에서 진행 중 잡을 끝내고, 새 잡은 집지 않는다", async () => {
    const recordId = await insertRecord();
    const runningJobId = await enqueue(recordId, new Date("2026-01-01T00:00:00.000Z"));
    const untouchedJobId = await enqueue(
      await insertRecord({ title: "종료 후 남는 레코드" }),
      new Date("2026-01-02T00:00:00.000Z"),
    );

    const latch = createLatch();
    const completed: JobOutcome[] = [];
    const worker = makeWorker({
      embedder: latchedEmbedder(fakeEmbedder(), latch),
      onOutcome: (outcome) => completed.push(outcome),
    });
    const loop = worker.start();

    await latch.entered; // 첫 잡이 임베딩 구간에 들어갔다
    const stopping = worker.stop(); // 여기서 죽으면 클레임한 잡이 running 좀비가 된다
    latch.release();
    await stopping;

    // **이 단언은 중간에 await가 없다.** `stop()`이 진행 중 잡을 기다리지 않고 즉시 돌아오는
    // 구현이라면 이 시점에 잡은 아직 DB 왕복(upsert→고아 삭제→워터마크→done) 중이라 비어 있다.
    // 여기에 `await loop`를 먼저 두면 루프가 대신 잡을 끝내 주어 이 검증이 통째로 무력해진다.
    expect(completed.map((outcome) => outcome.jobId)).toEqual([runningJobId.toHexString()]);
    expect(completed[0]?.status).toBe("done");

    // 루프가 실제로 빠져나왔는지. 종료 플래그를 세우지 않는 구현이면 여기서 영영 안 끝난다.
    await loop;

    expect((await jobOf(runningJobId)).status).toBe("done");
    expect(await chunksOf(recordId)).toHaveLength(2);

    const untouched = await jobOf(untouchedJobId);
    expect(untouched.status).toBe("pending");
    expect(untouched.attempts).toBe(0);

    // **종료 후 `running`이 하나도 남으면 안 된다.**
    // 잡을 클레임해 놓고 종료 플래그를 보고 이탈하면 아무도 되살리지 않는 좀비가 된다(T-003 F-3).
    // 위 단언들은 "진행 중 잡이 끝났다"만 보므로 클레임 직후 이탈 경로를 잡지 못한다 —
    // 실제로 그 뮤턴트가 검증에서 살아남았다(T-008 V23). 상태 자체를 세는 것이 유일한 방어다.
    expect(await db.collection("jobs").countDocuments({ status: "running" })).toBe(0);
  });

  it("종료 중에 클레임한 잡을 버리지 않는다 — running 좀비 금지", async () => {
    // 여러 잡을 넣고 종료를 반복해도 running이 쌓이지 않는지 본다.
    for (let i = 0; i < 3; i += 1) {
      await enqueue(await insertRecord({ title: `종료 반복 레코드 ${String(i)}` }));
    }

    const worker = makeWorker();
    const loop = worker.start();
    await worker.stop();
    await loop;

    expect(await db.collection("jobs").countDocuments({ status: "running" })).toBe(0);
  });
});

// ---------------------------------------------------------------- helpers

/** `runOnce`가 빈 큐를 만날 때까지 처리하고, 처리한 jobId를 순서대로 모은다. */
async function drain(worker: EmbedWorker): Promise<string[]> {
  const processed: string[] = [];
  for (;;) {
    const outcome = await worker.runOnce();
    if (outcome === undefined) return processed;
    processed.push(outcome.jobId);
  }
}

interface Gate {
  arrive(): Promise<void>;
}

/** 앞선 `target`개의 호출이 모두 도착할 때까지 서로를 붙잡아 두는 1회성 랑데부. */
function createGate(target: number): Gate {
  let arrived = 0;
  let open: (() => void) | undefined;
  const opened = new Promise<void>((resolve) => {
    open = resolve;
  });
  return {
    async arrive(): Promise<void> {
      arrived += 1;
      if (arrived >= target) open?.();
      if (arrived <= target) await opened;
    },
  };
}

function gatedEmbedder(base: Embedder, gate: Gate): Embedder {
  return {
    dim: base.dim,
    version: base.version,
    async embed(texts: string[]): Promise<number[][]> {
      await gate.arrive();
      return base.embed(texts);
    },
  };
}

interface Latch {
  /** 임베딩 구간에 들어갔음을 알리고 `release()`가 올 때까지 멈춘다. */
  enter(): Promise<void>;
  /** 누군가 `enter()`에 도달했음을 알리는 신호. */
  readonly entered: Promise<void>;
  release(): void;
}

function createLatch(): Latch {
  let signalEntered: (() => void) | undefined;
  let signalReleased: (() => void) | undefined;
  const entered = new Promise<void>((resolve) => {
    signalEntered = resolve;
  });
  const released = new Promise<void>((resolve) => {
    signalReleased = resolve;
  });
  return {
    entered,
    release: () => {
      signalReleased?.();
    },
    async enter(): Promise<void> {
      signalEntered?.();
      await released;
    },
  };
}

function latchedEmbedder(base: Embedder, latch: Latch): Embedder {
  return {
    dim: base.dim,
    version: base.version,
    async embed(texts: string[]): Promise<number[][]> {
      await latch.enter();
      return base.embed(texts);
    },
  };
}

/**
 * chunks 컬렉션의 쓰기만 실패시키는 Db 프록시. 다른 컬렉션(records·jobs)은 진짜다 —
 * "청크 커밋과 워터마크 사이"라는 좁은 구간을 재현하려면 나머지가 정상이어야 한다.
 */
function withFailingChunkWrites(real: Db): Db {
  return new Proxy(real, {
    get(target, property, receiver) {
      if (property !== "collection") return Reflect.get(target, property, receiver);
      return (name: string) => {
        const collection = target.collection(name);
        if (name !== "chunks") return collection;
        return new Proxy(collection, {
          get(inner, innerProperty, innerReceiver) {
            if (innerProperty !== "bulkWrite") {
              return Reflect.get(inner, innerProperty, innerReceiver);
            }
            return () => Promise.reject(new Error("주입된 chunks 쓰기 실패"));
          },
        });
      };
    },
  });
}
