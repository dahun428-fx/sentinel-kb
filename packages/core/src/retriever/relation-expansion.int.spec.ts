/**
 * T-035 통합 테스트. **실제 `$graphLookup`**을 `mongodb/mongodb-atlas-local`에서 돌린다.
 * 컨테이너 부팅은 `../testing/atlas-local.ts`(T-010에서 뽑은 공용 게이트)를 쓴다 — 복붙하지 않는다.
 *
 * ## 단위 테스트가 증명할 수 없는 것만 여기서 판정한다
 *
 * `relation-expansion.spec.ts`는 "우리가 `maxDepth: 0`을 **요구한다**"까지만 잠근다.
 * 그것이 실제로 1홉에서 멈추는지, 순환 관계(A→B→A)에서 엔진이 돌지 않는지는
 * **엔진 동작**이라 컨테이너 없이 알 수 없다. 그 판정이 이 파일의 존재 이유다.
 *
 * **컨테이너를 못 쓰는 환경에서는 skip한다. 통과시키지 않는다.**
 * skip은 조용히 일어나지 않는다(`warnDockerMissing`이 배너를 찍는다).
 *
 * `$vectorSearch`/`$search`를 쓰지 않으므로 검색 인덱스는 만들지 않는다 —
 * `$graphLookup`은 일반 aggregation 스테이지라 mongod만 있으면 된다.
 */
import { ObjectId, type Db } from "mongodb";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import {
  RELATION_TARGETS_FIELD,
  buildRelationChunkPipeline,
  buildRelationLookupPipeline,
  parseRelationTargets,
} from "./relation-expansion.js";
import { CHUNKS_COLLECTION, RECORDS_COLLECTION } from "./retrieve.js";
import {
  ATLAS_LOCAL_BOOT_TIMEOUT_MS,
  dockerAvailable,
  startAtlasLocal,
  warnDockerMissing,
  type AtlasLocalHandle,
} from "../testing/atlas-local.js";

const CONTAINER_NAME = `sentinel-t035-${process.pid}`;
const DB_NAME = "sentinel_t035_int";
const EMBEDDING_VERSION = 1;

const HAS_DOCKER = dockerAvailable();
if (!HAS_DOCKER) {
  warnDockerMissing("T-035", "relation-expansion.int.spec.ts", "$graphLookup 1홉 제한(Acceptance 1·4)");
}

/* --------------------------------------------------------------------------
 * 픽스처 — 재발 사슬 A → B → C 와 순환 A ↔ B
 * ----------------------------------------------------------------------- */

/** 진입점. B의 재발이고, B는 C의 재발이다 — 2홉을 타면 C까지 간다. */
const REC_A = new ObjectId();
const REC_B = new ObjectId();
const REC_C = new ObjectId();
/** 순환 픽스처. D ↔ E가 서로를 `recurrence_of`로 가리킨다. */
const REC_D = new ObjectId();
const REC_E = new ObjectId();
/** 삭제된 대상. records에 **넣지 않는다.** */
const REC_GONE = new ObjectId();

function record(
  id: ObjectId,
  relations: readonly { type: string; targetRecordId: ObjectId }[],
): Record<string, unknown> {
  return {
    _id: id,
    project: "sentinel-kb",
    type: "incident",
    title: `기록 ${id.toHexString()}`,
    summary: "요약",
    severity: "SEV2",
    tags: [],
    sanitizeFlags: [],
    relations: relations.map((relation) => ({ ...relation })),
    status: "published",
    embeddingVersion: EMBEDDING_VERSION,
    createdAt: new Date(),
    updatedAt: new Date(),
  };
}

function chunk(
  recordId: ObjectId,
  section: string,
  seq: number,
  options: { readonly flags?: readonly string[]; readonly version?: number } = {},
): Record<string, unknown> {
  return {
    _id: new ObjectId(),
    recordId,
    section,
    seq,
    text: `${recordId.toHexString()} ${section} 본문`,
    meta: {
      type: "incident",
      project: "sentinel-kb",
      severity: "SEV2",
      tags: [],
      sanitizeFlags: [...(options.flags ?? [])],
    },
    embeddingVersion: options.version ?? EMBEDDING_VERSION,
  };
}

let handle: AtlasLocalHandle | undefined;
let db: Db;

beforeAll(async () => {
  if (!HAS_DOCKER) return;
  handle = await startAtlasLocal({ containerName: CONTAINER_NAME, dbName: DB_NAME });
  db = handle.db;

  await db.collection(RECORDS_COLLECTION).insertMany([
    record(REC_A, [
      { type: "recurrence_of", targetRecordId: REC_B },
      // 확장 대상이 아닌 관계. 1홉 안에 있어도 끌려오면 안 된다.
      { type: "related", targetRecordId: REC_C },
      // 삭제된 대상.
      { type: "same_root_cause", targetRecordId: REC_GONE },
    ]),
    record(REC_B, [{ type: "recurrence_of", targetRecordId: REC_C }]),
    record(REC_C, []),
    record(REC_D, [{ type: "recurrence_of", targetRecordId: REC_E }]),
    record(REC_E, [{ type: "recurrence_of", targetRecordId: REC_D }]),
  ]);

  await db.collection(CHUNKS_COLLECTION).insertMany([
    chunk(REC_B, "symptom", 0),
    chunk(REC_B, "resolution", 1),
    chunk(REC_B, "prevention", 2),
    // 다른 임베딩 세대 — 필터가 걸러야 한다.
    chunk(REC_B, "resolution", 3, { version: EMBEDDING_VERSION + 1 }),
    chunk(REC_C, "resolution", 0),
    chunk(REC_E, "resolution", 0, { flags: ["injection-suspect"] }),
  ]);
}, ATLAS_LOCAL_BOOT_TIMEOUT_MS);

afterAll(async () => {
  await handle?.stop();
});

const toId = (value: unknown): string =>
  value instanceof ObjectId ? value.toHexString() : String(value);

async function lookup(entries: readonly ObjectId[]): Promise<Record<string, unknown>[]> {
  return db
    .collection(RECORDS_COLLECTION)
    .aggregate(buildRelationLookupPipeline([...entries], RECORDS_COLLECTION))
    .toArray();
}

describe.skipIf(!HAS_DOCKER)("$graphLookup 관계 확장 (T-035, specs/03 §2.5)", () => {
  it("진입점의 1홉 대상만 찾는다 — 2홉(A→B→C)까지 가지 않는다 (Acceptance 4)", async () => {
    const docs = await lookup([REC_A]);
    const found = (docs[0]?.[RELATION_TARGETS_FIELD] as { _id: ObjectId }[]).map((t) =>
      t._id.toHexString(),
    );

    // B는 1홉이라 온다. C는 A의 `related` 대상이자 B의 2홉 대상인데 **둘 다 이유가 안 된다.**
    expect(found).toEqual([REC_B.toHexString()]);
    expect(found).not.toContain(REC_C.toHexString());
  });

  it("확장 대상이 아닌 관계(related)는 startWith 단계에서 이미 빠진다", async () => {
    const docs = await lookup([REC_A]);
    const relations = docs[0]?.["relations"] as { type: string }[];
    expect(relations.map((r) => r.type).sort()).toEqual(["recurrence_of", "same_root_cause"]);
  });

  /**
   * **순환 참조가 무한 루프를 만들지 않는다** (Acceptance 4). D→E, E→D.
   * `maxDepth: 0`이라 초기 조회에서 멈춘다 — 이 테스트가 걸리면 타임아웃이 아니라
   * "받은 대상이 예상과 다르다"로 죽어야 한다(엔진이 돌면 애초에 여기 도달하지 못한다).
   */
  it("순환 관계(D↔E)에서 무한 순회 없이 끝난다 (Acceptance 4)", async () => {
    const docs = await lookup([REC_D, REC_E]);
    expect(docs).toHaveLength(2);

    const targets = parseRelationTargets(docs, [REC_D.toHexString(), REC_E.toHexString()], toId);
    expect(targets.map((t) => [t.fromRecordId, t.targetRecordId])).toEqual([
      [REC_D.toHexString(), REC_E.toHexString()],
      [REC_E.toHexString(), REC_D.toHexString()],
    ]);
    // 각자 상대 1건씩. 자기 자신이 대상으로 돌아오지 않는다.
    for (const doc of docs) {
      expect(doc[RELATION_TARGETS_FIELD]).toHaveLength(1);
    }
  });

  it("삭제된 대상을 가리키는 관계는 조용히 빠진다", async () => {
    const targets = parseRelationTargets(await lookup([REC_A]), [REC_A.toHexString()], toId);
    expect(targets.map((t) => t.targetRecordId)).toEqual([REC_B.toHexString()]);
    expect(targets.map((t) => t.targetRecordId)).not.toContain(REC_GONE.toHexString());
  });

  it("확장 대상의 resolution·prevention 청크만, 같은 임베딩 세대만 긁는다 (Acceptance 1)", async () => {
    const docs = await db
      .collection(CHUNKS_COLLECTION)
      .aggregate(
        buildRelationChunkPipeline([REC_B], EMBEDDING_VERSION, {
          _id: 1,
          recordId: 1,
          section: 1,
          seq: 1,
          text: 1,
          meta: 1,
        }),
      )
      .toArray();

    expect(docs.map((doc) => doc["section"]).sort()).toEqual(["prevention", "resolution"]);
    // symptom은 안 온다. 다른 세대의 resolution도 안 온다.
    expect(docs.map((doc) => doc["seq"]).sort()).toEqual([1, 2]);
    // 파이프라인이 score를 0으로 투영한다 — 확장 청크는 융합 순위가 없다.
    expect(docs.every((doc) => doc["score"] === 0)).toBe(true);
  });

  /**
   * **관계를 타고 오염이 들어오는 경로**. retriever는 specs/03 §2대로 플래그를 실어 보내고
   * 빼지 않는다 — 여기서는 그 플래그가 **소실되지 않는다**는 것만 확인한다.
   * 실제 제외는 `generator/context.ts`가 하며 `context.spec.ts`가 잠근다.
   */
  it("확장 청크의 sanitizeFlags가 소실되지 않는다", async () => {
    const docs = await db
      .collection(CHUNKS_COLLECTION)
      .aggregate(
        buildRelationChunkPipeline([REC_E], EMBEDDING_VERSION, {
          _id: 1,
          recordId: 1,
          section: 1,
          seq: 1,
          text: 1,
          meta: 1,
        }),
      )
      .toArray();

    expect(docs).toHaveLength(1);
    expect((docs[0]?.["meta"] as { sanitizeFlags: string[] }).sanitizeFlags).toEqual([
      "injection-suspect",
    ]);
  });
});
