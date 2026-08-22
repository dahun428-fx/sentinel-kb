/**
 * 골든셋 로더의 통합 테스트. specs/05가 "Integration: … mongodb-memory-server(벡터 외)"를
 * 허용한다 — `eval_cases` 조회는 벡터 검색을 쓰지 않으므로 메모리 서버로 충분하다.
 * (`packages/api/src/feedback.int.spec.ts`와 같은 부팅 규약: env의 MONGODB_URI에 의존하지 않는다.)
 *
 * **단위 테스트가 못 잡는 것을 여기서 잡는다**: 필터가 실제로 미승인 후보를 걸러 내는지.
 * `toGoldenCase`만 테스트하면 "쿼리는 전부 긁어오고 파싱에서 죽는" 구현도 통과한다 —
 * 그 구현은 후보가 하나라도 있으면 eval 전체가 예외로 죽는다.
 */
import { evalCasesCollection, type EvalCaseDocument } from "@sentinel/api";
import { connect } from "@sentinel/core/db";
import { MongoMemoryServer } from "mongodb-memory-server";
import { ObjectId, type Db, type MongoClient } from "mongodb";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";

import { loadGoldenSet } from "./golden-set.js";

const BOOT_TIMEOUT_MS = 120_000; // 첫 실행은 mongod 바이너리를 내려받는다
const DB_NAME = "sentinel_eval_golden_set_int_test";

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
  await client.close();
  await server.stop();
});

beforeEach(async () => {
  await evalCasesCollection(db).deleteMany({});
});

/** `_id`를 명시해 정렬 결과를 결정론적으로 만든다 — 자동 생성 ObjectId는 시간에 따라 갈린다. */
function caseId(suffix: string): ObjectId {
  return new ObjectId(`0000000000000000000000${suffix}`);
}

const RECORD = new ObjectId("6650a1b2c3d4e5f601020304");

function approved(suffix: string, query: string): EvalCaseDocument {
  return {
    _id: caseId(suffix),
    query,
    expectedRecordIds: [RECORD],
    approvedBy: "human",
  };
}

describe("loadGoldenSet", () => {
  it("승인된 케이스만 읽는다 — 미승인 후보는 예외를 내지 않고 그냥 빠진다", async () => {
    await evalCasesCollection(db).insertMany([
      approved("01", "nginx 502"),
      // `/v1/feedback`이 helped=true로 만든 후보. approvedBy가 없다(T-022).
      { _id: caseId("02"), query: "스트리밍이 끊긴다", expectedRecordIds: [RECORD] },
    ]);

    const cases = await loadGoldenSet(db);

    expect(cases.map((item) => item.query)).toEqual(["nginx 502"]);
  });

  it("후보만 있으면 빈 골든셋이다 — 자동 승격이 일어나지 않는다", async () => {
    await evalCasesCollection(db).insertOne({
      _id: caseId("03"),
      query: "결제 큐가 멈췄다",
      expectedRecordIds: [RECORD],
    });
    await expect(loadGoldenSet(db)).resolves.toEqual([]);
  });

  it("`_id` 오름차순으로 고정한다 — 리포트의 cases 순서가 실행마다 흔들리지 않는다", async () => {
    await evalCasesCollection(db).insertMany([
      approved("0c", "ccc 3"),
      approved("0a", "aaa 1"),
      approved("0b", "bbb 2"),
    ]);
    const cases = await loadGoldenSet(db);
    expect(cases.map((item) => item.query)).toEqual(["aaa 1", "bbb 2", "ccc 3"]);
  });

  it("ObjectId를 hex로 낮추고 질의 종류를 붙여 돌려준다", async () => {
    await evalCasesCollection(db).insertOne(approved("04", "스트리밍이 끊긴다"));
    const cases = await loadGoldenSet(db);
    expect(cases[0]).toEqual({
      caseId: caseId("04").toHexString(),
      query: "스트리밍이 끊긴다",
      expectedRecordIds: [RECORD.toHexString()],
      queryKind: "korean-prose",
    });
  });

  it("골든셋이 비어 있는 것이 지금의 실제 상태다 (T-013 STATUS: BLOCKED)", async () => {
    // 30건은 `seedBatch` 마커 결정(G3) 전까지 만들지 않는다 — `--reset` 한 번에 죽기 때문이다.
    await expect(loadGoldenSet(db)).resolves.toEqual([]);
  });
});
