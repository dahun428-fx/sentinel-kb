/**
 * T-009 통합 테스트. specs/05가 "Integration: … mongodb-memory-server(벡터 외)"를 허용한다.
 *
 * **env의 MONGODB_URI에 의존하지 않는다.** CI의 integration 스텝은 존재하지 않는 시크릿을
 * 주입해 빈 문자열이 들어온다(T-003이 확인, 시드 INC-07). 메모리 서버를 여기서 직접 띄운다.
 * embedder는 fake를 쓴다 — 여기서 검증하는 것은 청크 생성·멱등성·`--reset` 격리이지
 * 유사도 값이 아니다. 유사도가 걸린 검증은 fake로 할 수 없다(시드 INC-18, T-006 F-8).
 *
 * 기대값은 **구현 상수에서 끌어오지 않고 리터럴로 박는다.** `SEED_TOTAL`을 로더가 센 값으로
 * 두면 시드 파일이 사라져도 테스트가 따라 움직여 아무것도 검증하지 못한다.
 */
import { readdir, readFile } from "node:fs/promises";
import path from "node:path";

import { CreateRecordInput } from "@sentinel/contracts";
import { createFakeEmbedder, readSanitizeOptions, type Embedder } from "@sentinel/core";
import { connect, ensureIndexes } from "@sentinel/core/db";
import type { Db, MongoClient, ObjectId } from "mongodb";
import { MongoMemoryServer } from "mongodb-memory-server";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import {
  DEFAULT_SEED_DIR,
  loadSeedRecords,
  parseSeedArgs,
  resolveSeedApiKey,
  runSeed,
  type SeedRecord,
  type SeedResult,
} from "./seed.js";

const BOOT_TIMEOUT_MS = 120_000; // 첫 실행은 mongod 바이너리를 내려받는다
const SEED_TIMEOUT_MS = 180_000;
const DB_NAME = "sentinel_seed_int_test";

/** FR-10: 실사례 20 + 공개 포스트모템 20 + 이격 10. **리터럴이다.** */
const SEED_TOTAL = 50;
const SEED_INCIDENTS = 40;
const SEED_DIVERGENCES = 10;

const PROJECT = "sentinel-kb";
const API_KEY = "seed-int-test-key";
const API_KEYS: ReadonlyMap<string, string> = new Map([[API_KEY, PROJECT]]);

/** 테스트가 쓰는 임베딩 세대·차원. 리터럴이며 프로덕션 env와 무관하다. */
const TEST_DIM = 8;
const TEST_VERSION = 1;

let server: MongoMemoryServer;
let client: MongoClient;
let db: Db;
let seedRecords: SeedRecord[];

beforeAll(async () => {
  server = await MongoMemoryServer.create();
  client = await connect({
    uri: server.getUri(),
    dbName: DB_NAME,
    serverSelectionTimeoutMS: 10_000,
  });
  db = client.db(DB_NAME);
  await ensureIndexes(db);
  seedRecords = await loadSeedRecords();
}, BOOT_TIMEOUT_MS);

afterAll(async () => {
  await client.close();
  await server.stop();
});

// ---------------------------------------------------------------- helpers

function embedder(): Embedder {
  return createFakeEmbedder({ dim: TEST_DIM, version: TEST_VERSION });
}

function seed(overrides: { reset?: boolean } = {}): Promise<SeedResult> {
  return runSeed({
    db,
    project: PROJECT,
    apiKey: API_KEY,
    apiKeys: API_KEYS,
    sanitizeOptions: readSanitizeOptions({}),
    embedder: embedder(),
    records: seedRecords,
    ...(overrides.reset === undefined ? {} : { reset: overrides.reset }),
  });
}

async function clearAll(): Promise<void> {
  await Promise.all(
    ["records", "chunks", "jobs"].map(async (name) => db.collection(name).deleteMany({})),
  );
}

interface StoredRecord {
  _id: ObjectId;
  type: string;
  project: string;
  title: string;
  summary: string;
  status: string;
  sanitizeFlags: string[];
  embeddingVersion: number;
  context?: { model?: string; tool?: string; framework?: string };
  correction?: string;
}

async function allRecords(): Promise<StoredRecord[]> {
  return (await db
    .collection("records")
    .find({})
    .sort({ title: 1 })
    .toArray()) as unknown as StoredRecord[];
}

/** 실제 파일을 직접 훑는다 — 로더 구현과 독립적인 두 번째 관측이다. */
async function readSeedFilesDirectly(): Promise<{ file: string; raw: unknown }[]> {
  const out: { file: string; raw: unknown }[] = [];
  async function walk(dir: string, prefix: string): Promise<void> {
    for (const entry of await readdir(dir, { withFileTypes: true })) {
      const relative = prefix === "" ? entry.name : `${prefix}/${entry.name}`;
      if (entry.isDirectory()) await walk(path.join(dir, entry.name), relative);
      else if (entry.name.endsWith(".json")) {
        out.push({
          file: relative,
          raw: JSON.parse(await readFile(path.join(dir, entry.name), "utf8")) as unknown,
        });
      }
    }
  }
  await walk(DEFAULT_SEED_DIR, "");
  return out;
}

// ---------------------------------------------------------------- 계약 적합성

describe("시드 JSON 전부가 CreateRecordInput으로 파싱된다", () => {
  it("50건이고 incident 40 / divergence 10이다", async () => {
    const files = await readSeedFilesDirectly();
    expect(files).toHaveLength(SEED_TOTAL);

    const parsed = files.map((entry) => {
      const result = CreateRecordInput.safeParse(entry.raw);
      expect(result.success, `${entry.file}: ${JSON.stringify(result.error?.issues)}`).toBe(true);
      return result.data;
    });

    expect(parsed.filter((record) => record?.type === "incident")).toHaveLength(SEED_INCIDENTS);
    expect(parsed.filter((record) => record?.type === "divergence")).toHaveLength(
      SEED_DIVERGENCES,
    );
  });

  it("바디에 project나 서버 생성 필드를 담지 않는다", async () => {
    // `.strict()`가 어차피 거부하지만, 그 이유를 이름으로 못박아 둔다 — T-002 S-2 / specs/04.
    const forbidden = [
      "project",
      "summary",
      "sanitizeFlags",
      "relations",
      "embeddingVersion",
      "createdAt",
      "updatedAt",
      "_id",
    ];
    for (const entry of await readSeedFilesDirectly()) {
      const keys = Object.keys(entry.raw as Record<string, unknown>);
      expect(keys.filter((key) => forbidden.includes(key)), entry.file).toEqual([]);
    }
  });

  it("title이 시드 전체에서 유일하다 — 멱등 키가 성립하는 조건", () => {
    const titles = seedRecords.map((record) => record.input.title);
    expect(new Set(titles).size).toBe(SEED_TOTAL);
  });
});

// ---------------------------------------------------------------- Acceptance 1·2·3

describe("Acceptance 1·2·3 — 멱등 적재, published + chunks, divergence 필수 필드", () => {
  let first: SeedResult;
  let second: SeedResult;
  let idsAfterFirst: string[];
  let chunkCountAfterFirst: number;

  beforeAll(async () => {
    await clearAll();
    first = await seed();
    idsAfterFirst = (await allRecords()).map((record) => record._id.toHexString());
    chunkCountAfterFirst = await db.collection("chunks").countDocuments({});
    second = await seed();
  }, SEED_TIMEOUT_MS);

  it("1회차는 50건을 삽입한다", () => {
    expect(first.inserted).toBe(SEED_TOTAL);
    expect(first.skipped).toBe(0);
    expect(first.failedJobs).toEqual([]);
    expect(first.embeddedJobs).toBe(SEED_TOTAL);
  });

  it("2회 실행해도 레코드 수가 같다", async () => {
    expect(second.inserted).toBe(0);
    expect(second.skipped).toBe(SEED_TOTAL);
    expect(await db.collection("records").countDocuments({})).toBe(SEED_TOTAL);
  });

  it("2회차가 _id를 유지한다 — delete+insert가 아니라 건너뛰기다", async () => {
    // 개수만 세면 '전부 지우고 다시 넣기'도 통과한다. _id 보존이 그 둘을 가르는 유일한 단언이다.
    const after = (await allRecords()).map((record) => record._id.toHexString());
    expect(after).toEqual(idsAfterFirst);
  });

  it("2회차가 청크를 중복 생성하지 않는다", async () => {
    expect(await db.collection("chunks").countDocuments({})).toBe(chunkCountAfterFirst);
  });

  it("50건 전부 published이고 project가 인증 키에서 주입됐다", async () => {
    const records = await allRecords();
    expect(records).toHaveLength(SEED_TOTAL);
    expect(records.filter((record) => record.status === "published")).toHaveLength(SEED_TOTAL);
    expect(records.filter((record) => record.project === PROJECT)).toHaveLength(SEED_TOTAL);
    // summary는 서버 생성 필드다. 시드 JSON에 없으므로 API가 만들었다는 증거이기도 하다.
    expect(records.filter((record) => record.summary.length > 0)).toHaveLength(SEED_TOTAL);
  });

  it("시드 50건 어디에도 새니타이즈 플래그가 붙지 않는다", async () => {
    /**
     * 시드에 자격증명 모양 문자열이나 인젝션 문구가 있으면 여기서 드러난다.
     * 새니타이저에 의존해 시크릿을 지우는 것이 아니라, 애초에 넣지 않는 것이 규칙이다
     * (postmortem-schema 스킬, CLAUDE.md 금지 사항). 플래그가 붙은 시드는 본문도
     * 마스킹 라벨로 바뀌어 있어 지식으로서의 값이 깎인다.
     */
    const flagged = (await allRecords()).filter((record) => record.sanitizeFlags.length > 0);
    expect(flagged.map((record) => `${record.title} ${record.sanitizeFlags.join(",")}`)).toEqual(
      [],
    );
  });

  it("50건 전부 chunks가 생성되고 워터마크가 올라갔다", async () => {
    const records = await allRecords();
    const withChunks = (await db
      .collection("chunks")
      .distinct("recordId")) as unknown as ObjectId[];
    expect(withChunks).toHaveLength(SEED_TOTAL);

    // 청크가 '어떤 레코드에든' 붙어 있는 것으로는 부족하다 — 50개 레코드 각각에 붙어야 한다.
    const chunked = new Set(withChunks.map((id) => id.toHexString()));
    const missing = records.filter((record) => !chunked.has(record._id.toHexString()));
    expect(missing.map((record) => record.title)).toEqual([]);

    expect(records.filter((record) => record.embeddingVersion === TEST_VERSION)).toHaveLength(
      SEED_TOTAL,
    );
    expect(await db.collection("jobs").countDocuments({ status: "done" })).toBe(SEED_TOTAL);
  });

  it("divergence 10건 모두 context.model과 correction이 채워져 있다", async () => {
    const divergences = (await allRecords()).filter((record) => record.type === "divergence");
    expect(divergences).toHaveLength(SEED_DIVERGENCES);

    for (const record of divergences) {
      // 재현 조건이 없으면 지식이 아니다 (postmortem-schema 스킬).
      expect(record.context?.model ?? "", record.title).not.toBe("");
      expect(record.correction ?? "", record.title).not.toBe("");
    }
  });

  it("incident 40 / divergence 10으로 저장됐다", async () => {
    const records = await allRecords();
    expect(records.filter((record) => record.type === "incident")).toHaveLength(SEED_INCIDENTS);
    expect(records.filter((record) => record.type === "divergence")).toHaveLength(
      SEED_DIVERGENCES,
    );
  });
});

// ---------------------------------------------------------------- --reset

describe("--reset은 시드만 지우고 사용자 레코드는 남긴다", () => {
  const userTitle = "사용자가 직접 기록한 사례 — 시드가 건드리면 안 된다";
  let userId: ObjectId;
  let seedIdsBefore: string[];
  let result: SeedResult;

  beforeAll(async () => {
    await clearAll();
    await seed();
    seedIdsBefore = (await allRecords()).map((record) => record._id.toHexString());

    // 시드가 만들지 않은 레코드. API를 거치지 않고 직접 넣어 시드 경로와 독립시킨다.
    const at = new Date("2026-01-01T00:00:00.000Z");
    const inserted = await db.collection("records").insertOne({
      type: "incident",
      project: PROJECT,
      title: userTitle,
      summary: "사용자 기록.",
      severity: "SEV3",
      tags: ["user"],
      sanitizeFlags: [],
      relations: [],
      status: "published",
      embeddingVersion: 0,
      symptom: "사용자가 MCP로 기록한 증상이다.",
      resolution: "사용자가 기록한 조치다.",
      createdAt: at,
      updatedAt: at,
    });
    userId = inserted.insertedId;

    result = await seed({ reset: true });
  }, SEED_TIMEOUT_MS);

  it("시드 레코드 50건을 지우고 다시 넣는다", () => {
    expect(result.deletedRecords).toBe(SEED_TOTAL);
    expect(result.inserted).toBe(SEED_TOTAL);
    expect(result.skipped).toBe(0);
  });

  it("사용자 레코드는 살아남는다", async () => {
    const survivor = await db.collection("records").findOne({ _id: userId });
    expect(survivor, "사용자 레코드가 사라졌다 — --reset이 컬렉션 전체를 지웠다").not.toBeNull();
    expect((survivor as unknown as StoredRecord).title).toBe(userTitle);
  });

  it("전체 개수는 시드 50 + 사용자 1이다", async () => {
    expect(await db.collection("records").countDocuments({})).toBe(SEED_TOTAL + 1);
  });

  it("재적재된 시드는 새 _id를 갖는다 — 실제로 지웠다는 증거", async () => {
    const after = (await allRecords())
      .filter((record) => record.title !== userTitle)
      .map((record) => record._id.toHexString());
    expect(after).toHaveLength(SEED_TOTAL);
    expect(after.filter((id) => seedIdsBefore.includes(id))).toEqual([]);
  });

  it("지운 시드의 청크가 고아로 남지 않는다", async () => {
    // 삭제 시 청크를 안 지우면 여기서 100(구세대 50 + 신세대 50)이 나온다.
    const owners = (await db.collection("chunks").distinct("recordId")) as unknown as ObjectId[];
    const live = new Set((await allRecords()).map((record) => record._id.toHexString()));
    expect(owners.filter((id) => !live.has(id.toHexString()))).toEqual([]);
  });
});

// ---------------------------------------------------------------- 방어 장치

describe("시드 CLI 인자와 키 해석", () => {
  it("--reset / --project / --allow-fake-embeddings를 읽는다", () => {
    expect(parseSeedArgs([])).toEqual({
      reset: false,
      project: "sentinel-kb",
      allowFakeEmbeddings: false,
    });
    expect(parseSeedArgs(["--reset", "--project=bizcare-web", "--allow-fake-embeddings"])).toEqual(
      { reset: true, project: "bizcare-web", allowFakeEmbeddings: true },
    );
  });

  it("모르는 인자는 조용히 무시하지 않고 던진다", () => {
    expect(() => parseSeedArgs(["--rest"])).toThrow(/알 수 없는 인자/);
    expect(() => parseSeedArgs(["--project="])).toThrow(/project 슬러그/);
  });

  it("project로 해석되는 키가 없으면 던진다 — 엉뚱한 project 적재 방지", () => {
    expect(resolveSeedApiKey(API_KEYS, PROJECT)).toBe(API_KEY);
    expect(() => resolveSeedApiKey(API_KEYS, "unknown-project")).toThrow(/해석되는 키가 없다/);
  });

  it("새니타이저가 title을 고치면 SEED_TITLE_REWRITTEN으로 실패한다", async () => {
    await clearAll();
    /**
     * title에 마스킹 대상이 들어 있으면 저장된 title이 시드 title과 달라지고, 다음 실행의
     * 멱등 조회가 그 레코드를 못 찾아 **매번 새로 삽입한다.** 개수가 조용히 늘어나는 대신
     * 여기서 시끄럽게 실패해야 한다. 이 단언이 없으면 멱등 키 검증을 통째로 지우는 뮤턴트가
     * 살아남는다. AWS 액세스 키 모양(AKIA + 대문자·숫자 16자)은 마스킹이 확실한 패턴이다.
     */
    const poisoned: SeedRecord = {
      source: "합성 픽스처(시드 파일 아님)",
      input: {
        type: "incident",
        title: "멱등 키 회귀 — AKIA0000000000000000 가 제목에 있다",
        symptom: "제목에 자격증명 모양 문자열이 들어간 기록을 적재한다.",
        resolution: "새니타이저가 제목을 고쳐 멱등 키가 어긋나는지 확인한다.",
        severity: "SEV3",
        tags: [],
        status: "published",
      },
    };
    const single = {
      db,
      project: PROJECT,
      apiKey: API_KEY,
      apiKeys: API_KEYS,
      sanitizeOptions: readSanitizeOptions({}),
      embedder: embedder(),
      records: [poisoned],
    };

    await expect(runSeed(single)).rejects.toMatchObject({
      name: "SeedError",
      code: "SEED_TITLE_REWRITTEN",
    });
  }, SEED_TIMEOUT_MS);
});
