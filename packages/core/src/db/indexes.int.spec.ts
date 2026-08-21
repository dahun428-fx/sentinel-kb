import { MongoMemoryServer } from "mongodb-memory-server";
import type { Db, MongoClient } from "mongodb";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";

import { closeDb, connect, ping } from "./client.js";
import { DB_INDEX_SPECS, ensureIndexes } from "./indexes.js";

/**
 * T-003 통합 테스트. specs/05가 "Integration: … mongodb-memory-server(벡터 외)"를 허용한다.
 *
 * **env의 MONGODB_URI에 의존하지 않는다.** CI의 integration 스텝은 존재하지 않는
 * `secrets.MONGODB_TEST_URI`를 주입해 빈 문자열이 들어온다 — 거기 기대면 CI에서 반드시 깨진다.
 * 여기서 메모리 서버를 직접 띄우고 그 URI만 쓴다.
 */
const BOOT_TIMEOUT_MS = 120_000; // 첫 실행은 mongod 바이너리를 내려받는다
const DB_NAME = "sentinel_int_test";

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
}, BOOT_TIMEOUT_MS);

afterAll(async () => {
  await closeDb();
  await client.close();
  await server.stop();
});

/** `listIndexes`가 돌려주는 것 중 이 테스트가 확인하는 부분만. */
interface IndexInfo {
  name: string;
  key: Record<string, unknown>;
  unique?: boolean;
}

async function listIndexes(collection: string): Promise<IndexInfo[]> {
  return (await db.collection(collection).listIndexes().toArray()) as IndexInfo[];
}

async function findIndex(collection: string, name: string): Promise<IndexInfo | undefined> {
  return (await listIndexes(collection)).find((i) => i.name === name);
}

describe("ensureIndexes", () => {
  it("2회 실행해도 에러 없고 인덱스 개수가 늘지 않는다(멱등)", async () => {
    // T-003 Acceptance 1. 부트스트랩은 배포마다 무조건 돌아간다 — 두 번째 실행이
    // IndexKeySpecsConflict·IndexOptionsConflict로 죽으면 재배포 자체가 막힌다.
    const first = await ensureIndexes(db);
    const collections = [...new Set(DB_INDEX_SPECS.map((s) => s.collection))];
    const countsAfterFirst = await countIndexes(collections);

    const second = await ensureIndexes(db);

    expect(second).toEqual(first);
    expect(await countIndexes(collections)).toEqual(countsAfterFirst);
  });

  it("스펙에 적힌 이름을 그대로 반환한다", async () => {
    const names = await ensureIndexes(db);
    expect(names).toEqual(DB_INDEX_SPECS.map((s) => s.name));
  });

  it("생성된 인덱스가 기대한 키와 unique 옵션을 갖는다", async () => {
    await ensureIndexes(db);

    for (const spec of DB_INDEX_SPECS) {
      const actual = await findIndex(spec.collection, spec.name);
      expect(actual, `${spec.collection}.${spec.name}가 없다`).toBeDefined();
      expect(actual?.key).toEqual(spec.key);
      expect(actual?.unique ?? false).toBe(spec.unique);
    }
  });

  /**
   * 위 테스트는 `DB_INDEX_SPECS`를 기대값으로 쓰므로 **자기참조적**이다 — 상수를 고치면
   * 기대값도 따라 바뀌어 스펙 드리프트를 잡지 못한다. 그래서 여기서는 specs/02 §인덱스와
   * docs/design/DB-DESIGN.md §3에 적힌 값을 **리터럴로** 박아 앵커로 삼는다.
   * 이 테스트가 깨지면 코드가 아니라 스펙과 어긋난 것이므로, 먼저 스펙을 확인해야 한다.
   */
  it("인덱스 키가 specs/02 §인덱스와 문자 그대로 일치한다", async () => {
    await ensureIndexes(db);

    const expected = [
      // specs/02 §인덱스: records: {project:1, type:1, createdAt:-1}, {tags:1}
      { collection: "records", key: { project: 1, type: 1, createdAt: -1 }, unique: false },
      { collection: "records", key: { tags: 1 }, unique: false },
      // specs/02 §인덱스: jobs: {status:1, createdAt:1}
      // createdAt은 오름차순이어야 한다 — -1이면 최신 잡 우선 LIFO가 되어 오래된 pending이 기아 상태가 된다.
      { collection: "jobs", key: { status: 1, createdAt: 1 }, unique: false },
      // specs/02 §인덱스 + DB-DESIGN §3: chunks 인제스트 멱등성 unique
      {
        collection: "chunks",
        key: { recordId: 1, section: 1, seq: 1, embeddingVersion: 1 },
        unique: true,
      },
    ];

    for (const want of expected) {
      const all = await listIndexes(want.collection);
      const match = all.find((i) => JSON.stringify(i.key) === JSON.stringify(want.key));
      expect(
        match,
        `${want.collection}에 키 ${JSON.stringify(want.key)} 인덱스가 없다`,
      ).toBeDefined();
      expect(match?.unique ?? false).toBe(want.unique);
    }

    // 스펙에 없는 인덱스를 몰래 늘리지 않았는지도 함께 잠근다(_id_ 기본 인덱스는 제외).
    const created = await Promise.all(
      [...new Set(expected.map((e) => e.collection))].map(async (c) =>
        (await listIndexes(c)).filter((i) => i.name !== "_id_").length,
      ),
    );
    expect(created.reduce((a, b) => a + b, 0)).toBe(expected.length);
  });

  it("Atlas 전용 인덱스(vec_idx/text_idx)는 만들지 않는다", async () => {
    // T-010의 몫이다. 여기서 만들면 Out of scope 위반이자 로컬에서 생성 불가다.
    await ensureIndexes(db);
    const names = (await listIndexes("chunks")).map((i) => i.name);
    expect(names).not.toContain("vec_idx");
    expect(names).not.toContain("text_idx");
  });

  it("feedbacks에는 인덱스를 만들지 않는다(스펙 근거 없음)", async () => {
    // specs/02 §인덱스와 DB-DESIGN §3 어디에도 feedbacks 항목이 없다. Findings 참조.
    await ensureIndexes(db);
    expect(DB_INDEX_SPECS.map((s) => s.collection)).not.toContain("feedbacks");
    // 컬렉션을 만들지도 않았음을 확인한다 — createIndex는 컬렉션을 암묵 생성한다.
    const collections = await db.listCollections().toArray();
    expect(collections.map((c) => c.name)).not.toContain("feedbacks");
  });
});

describe("chunks 유니크 인덱스", () => {
  it("같은 {recordId,section,seq,embeddingVersion} 중복 삽입을 막는다", async () => {
    // specs/03 §1-3의 인제스트 멱등성이 이 인덱스 하나에 걸려 있다.
    await ensureIndexes(db);
    const chunks = db.collection("chunks");
    const key = {
      recordId: "0123456789abcdef01234567",
      section: "resolution",
      seq: 0,
      embeddingVersion: 1,
    };

    await chunks.insertOne({ ...key, text: "첫 번째 청크" });
    await expect(chunks.insertOne({ ...key, text: "재시도로 들어온 중복 청크" })).rejects.toThrow(
      /duplicate key/i,
    );

    // seq가 다르면 같은 섹션이라도 통과해야 한다 — 1200자 초과 분할이 이 경로다.
    await expect(
      chunks.insertOne({ ...key, seq: 1, text: "같은 섹션의 두 번째 분할" }),
    ).resolves.toBeDefined();
  });
});

describe("ping", () => {
  it("살아있는 DB에서 ok:true를 반환한다", async () => {
    // env를 건드리므로 stubEnv로 격리한다 — 원복하지 않으면 뒤에 추가될 테스트가 오염된 env를 물려받는다.
    vi.stubEnv("MONGODB_URI", server.getUri());
    vi.stubEnv("MONGODB_DB", DB_NAME);
    try {
      const result = await ping();
      expect(result.ok).toBe(true);
      expect(result.latencyMs).toBeGreaterThanOrEqual(0);
    } finally {
      await closeDb();
      vi.unstubAllEnvs();
    }
  });
});

async function countIndexes(collections: string[]): Promise<number[]> {
  const counts: number[] = [];
  for (const collection of collections) {
    counts.push((await listIndexes(collection)).length);
  }
  return counts;
}
