/**
 * T-058 통합 테스트 — `give_feedback`과 `record_knowledge`가 실제 API 경로로 저장된 뒤 도그푸딩 리포트에 집계되는가.
 *
 * 예전에는 리포트가 손으로 쓰는 jsonl만 세서, 피드백을 아무리 보내도 적중이 0이었다(P1 리뷰 A2).
 * 저장 형식이 바뀌면 이 테스트가 먼저 깨지도록 DB에 직접 넣지 않고 `/v1/records`·`/v1/feedback`을 거친다.
 */
import { createApp } from "@sentinel/api";
import { connect, ensureIndexes } from "@sentinel/core/db";
import { parseApiKeys } from "@sentinel/core";

import { MongoMemoryServer } from "mongodb-memory-server";
import type { Db, MongoClient } from "mongodb";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { loadDbEvents, mergeWithDbEvents } from "./dogfood-db.js";
import { buildDogfoodReport, isoWeekOf, parseDogfoodLog } from "./dogfood-report.js";

const BOOT_TIMEOUT_MS = 120_000;
const AUTH = { authorization: "Bearer key-alpha" };
const NOW = new Date("2026-10-22T09:00:00.000Z");

let server: MongoMemoryServer;
let client: MongoClient;
let db: Db;
let app: ReturnType<typeof createApp>;

beforeAll(async () => {
  server = await MongoMemoryServer.create();
  client = await connect({
    uri: server.getUri(),
    dbName: "sentinel_dogfood_int_test",
    serverSelectionTimeoutMS: 10_000,
  });
  db = client.db("sentinel_dogfood_int_test");
  await ensureIndexes(db);
  app = createApp({
    db,
    apiKeys: parseApiKeys("key-alpha:sentinel-kb"),
    sanitizeOptions: { maskEmail: false, maxInputChars: 65_536 },
    embeddingVersion: 1,
    version: "0.0.1-test",
    now: () => NOW,
  });
  await app.ready();
}, BOOT_TIMEOUT_MS);

afterAll(async () => {
  await app.close();
  await client.close();
  await server.stop();
});

describe("도그푸딩 리포트의 DB 출처 (T-058)", () => {
  it("기록 1건과 give_feedback(helped:true) 1건이 로그 파일 없이 기록 1·적중 1로 잡힌다", async () => {
    const created = await app.inject({
      method: "POST",
      url: "/v1/records",
      headers: AUTH,
      payload: {
        type: "incident",
        title: "결제 큐가 멈춘 장애",
        severity: "SEV2",
        tags: ["queue"],
        symptom: "결제 요청이 큐에 쌓이기만 하고 소비되지 않았다.",
        resolution: "컨슈머를 재기동하고 프리페치 수를 낮췄다.",
      },
    });
    const recordId = created.json<{ _id: string }>()._id;
    const feedback = await app.inject({
      method: "POST",
      url: "/v1/feedback",
      headers: AUTH,
      payload: { recordId, query: "큐 소비가 멈췄다", helped: true },
    });
    expect(feedback.statusCode).toBe(204);
    // helped:false는 적중이 아니다.
    await app.inject({
      method: "POST",
      url: "/v1/feedback",
      headers: AUTH,
      payload: { recordId, query: "다른 질문", helped: false },
    });

    const logOnly = parseDogfoodLog('{"ts":"2026-10-22T08:00:00Z","event":"search","results":1}\n');
    const events = mergeWithDbEvents(logOnly, await loadDbEvents(db));
    const report = buildDogfoodReport(events, { week: isoWeekOf(NOW), generatedAt: NOW });

    expect(report.records.total).toBe(1);
    expect(report.hits).toEqual({ total: 1, recordIds: [recordId] });
    expect(report.searches.total).toBe(1);
  });

  it("--since 이전에 만든 기록·피드백은 세지 않는다 — 일괄 적재분 제외 (UPLIFT Q-12)", async () => {
    const events = await loadDbEvents(db, new Date("2026-10-23T00:00:00.000Z"));
    expect(events).toEqual([]);
  });
});
