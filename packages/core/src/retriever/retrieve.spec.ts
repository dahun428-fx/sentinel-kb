/**
 * `createRetriever`의 파이프라인 형상·융합·게이트 값 단위 테스트.
 *
 * 구조적 `RetrievalDbLike`(types.ts) 덕에 컨테이너 없이 **실제로 발행되는 파이프라인**을
 * 들여다볼 수 있다. 컨테이너가 판정하는 것(인덱스가 실제로 존재하는가, cosine 척도가
 * 0–1인가)은 `retrieve.int.spec.ts`가 맡는다 — 여기서는 그것을 흉내내지 않는다.
 *
 * **`FakeEmbedder`로 "벡터 경로가 기여한다"를 증명하지 않는다** (T-006 F-8):
 * 해시 벡터는 서로 다른 텍스트 간 cosine ≈ 0이라 공허한 그린이 난다. 여기 embedder는
 * 파이프라인에 실릴 벡터를 만드는 자리표일 뿐이고, 유사도 판정은 하지 않는다.
 */
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

import type { SanitizeFlag } from "@sentinel/contracts";
import { describe, expect, it } from "vitest";

import {
  RETRIEVER_ERROR_CODES,
  TEXT_INDEX_NAME,
  VECTOR_INDEX_NAME,
  createRetriever,
} from "./retrieve.js";
import type { RetrievalConfig } from "./config.js";
import type { PipelineStage, RetrievalDbLike } from "./types.js";
import type { Embedder } from "../embedder/types.js";

const CONFIG: RetrievalConfig = {
  vectorK: 4,
  textK: 4,
  finalK: 3,
  rrfK: 60,
  numCandidates: 50,
  candidateOverfetch: 3,
  maxChunksPerRecord: 2,
};

const QUERY_VECTOR = [0.1, 0.2, 0.3, 0.4];

const embedder: Embedder = {
  dim: QUERY_VECTOR.length,
  version: 7,
  embed: (texts) => Promise.resolve(texts.map(() => [...QUERY_VECTOR])),
};

interface ChunkDocOptions {
  readonly section?: string;
  readonly seq?: number;
  readonly text?: string;
  readonly type?: string;
  readonly project?: string;
  readonly flags?: readonly string[];
}

/**
 * `score`는 **드라이버가 주는 값 그대로**다 — vector 경로면 Atlas의 `vectorSearchScore`,
 * 즉 `(1 + cos) / 2`로 **정규화된 0–1 값**이고(직교가 0.5, 정반대가 0.0), text 경로면 BM25다.
 * retriever가 vector 쪽만 원시 cosine(−1..1)으로 되돌리므로, 아래 단언의 기대값은
 * 여기 넣은 값이 아니라 **환산된 값**이다.
 */
function chunkDoc(
  id: string,
  recordId: string,
  score: number,
  options: ChunkDocOptions = {},
): Record<string, unknown> {
  return {
    _id: id,
    recordId,
    section: options.section ?? "symptom",
    seq: options.seq ?? 0,
    text: options.text ?? `본문 ${id}`,
    meta: {
      type: options.type ?? "incident",
      project: options.project ?? "sentinel-kb",
      severity: "SEV2",
      tags: [],
      sanitizeFlags: [...(options.flags ?? [])],
    },
    embeddingVersion: 7,
    score,
  };
}

function recordDoc(id: string): Record<string, unknown> {
  return { _id: id, title: `제목 ${id}`, summary: `요약 ${id}` };
}

interface FakeDbOptions {
  readonly vector?: readonly Record<string, unknown>[];
  readonly text?: readonly Record<string, unknown>[];
  readonly records?: readonly Record<string, unknown>[];
}

interface FakeDb {
  readonly db: RetrievalDbLike;
  readonly calls: { collection: string; pipeline: PipelineStage[] }[];
}

function makeDb(options: FakeDbOptions): FakeDb {
  const calls: { collection: string; pipeline: PipelineStage[] }[] = [];

  const db: RetrievalDbLike = {
    collection(name) {
      return {
        aggregate(pipeline) {
          calls.push({ collection: name, pipeline });
          return {
            toArray: () => {
              if (name === "records") {
                const wanted = matchedIds(pipeline);
                return Promise.resolve(
                  (options.records ?? []).filter((doc) => wanted.includes(doc["_id"])),
                );
              }
              const isVector = pipeline[0] !== undefined && "$vectorSearch" in pipeline[0];
              return Promise.resolve([...((isVector ? options.vector : options.text) ?? [])]);
            },
          };
        },
      };
    },
  };

  return { db, calls };
}

function matchedIds(pipeline: PipelineStage[]): unknown[] {
  const match = pipeline[0]?.["$match"];
  const id = asRecord(asRecord(match)?.["_id"]);
  const list = id?.["$in"];
  return Array.isArray(list) ? list : [];
}

function asRecord(value: unknown): Record<string, unknown> | undefined {
  return typeof value === "object" && value !== null
    ? (value as Record<string, unknown>)
    : undefined;
}

function stageOf(fake: FakeDb, operator: string): Record<string, unknown> {
  for (const call of fake.calls) {
    for (const stage of call.pipeline) {
      if (operator in stage) return asRecord(stage[operator]) ?? {};
    }
  }
  throw new Error(`${operator} 스테이지가 발행되지 않았다`);
}

function pipelineWith(fake: FakeDb, operator: string): PipelineStage[] {
  const call = fake.calls.find((c) => c.pipeline.some((stage) => operator in stage));
  if (!call) throw new Error(`${operator}를 담은 파이프라인이 없다`);
  return call.pipeline;
}

const retrieverOn = (fake: FakeDb): ReturnType<typeof createRetriever> =>
  createRetriever({ db: fake.db, embedder, config: CONFIG });

describe("발행되는 파이프라인", () => {
  it("인덱스 이름이 db/search-indexes의 정의 파일과 같다", () => {
    // 두 곳이 갈라지면 쿼리가 에러 없이 0건이 된다 — 가장 조용한 실패다.
    const read = (file: string): string =>
      readFileSync(fileURLToPath(new URL(`../db/search-indexes/${file}`, import.meta.url)), "utf8");

    expect(JSON.parse(read("vec_idx.json"))).toMatchObject({ name: VECTOR_INDEX_NAME });
    expect(JSON.parse(read("text_idx.json"))).toMatchObject({ name: TEXT_INDEX_NAME });
  });

  it("$vectorSearch가 env 파라미터와 필터 3종을 그대로 싣는다", async () => {
    const fake = makeDb({});
    await retrieverOn(fake).retrieve({ query: "nginx 스트리밍", type: "incident", project: "sentinel-kb" });

    expect(stageOf(fake, "$vectorSearch")).toEqual({
      index: VECTOR_INDEX_NAME,
      path: "embedding",
      queryVector: QUERY_VECTOR,
      numCandidates: CONFIG.numCandidates,
      limit: CONFIG.vectorK * CONFIG.candidateOverfetch,
      filter: {
        embeddingVersion: { $eq: 7 },
        "meta.type": { $eq: "incident" },
        "meta.project": { $eq: "sentinel-kb" },
      },
    });
  });

  /**
   * `embeddingVersion` 필터가 빠지면 구버전 청크가 섞여 나온다 — specs/02 마이그레이션 규칙이
   * 구·신 버전 공존을 **정상 상태**로 정의하므로 이건 이론이 아니라 상시 위험이다.
   */
  it("type·project가 없어도 embeddingVersion 필터는 항상 걸린다", async () => {
    const fake = makeDb({});
    await retrieverOn(fake).retrieve({ query: "아무 질의" });

    expect(stageOf(fake, "$vectorSearch")["filter"]).toEqual({ embeddingVersion: { $eq: 7 } });
  });

  /**
   * `text_idx`는 `dynamic:false`에 `text` 하나만 매핑한다. `$search`의 `equals`로는
   * meta.*를 걸 수 없으므로 뒤따르는 `$match`로 건다. 그리고 `$limit`은 **`$match` 뒤**여야
   * 필터로 잘린 만큼 재현율을 잃지 않는다.
   */
  it("$search는 뒤따르는 $match로 같은 필터를 걸고, $limit은 그 뒤에 온다", async () => {
    const fake = makeDb({});
    await retrieverOn(fake).retrieve({ query: "proxy_buffering", type: "divergence", project: "bizcare-web" });

    const pipeline = pipelineWith(fake, "$search");
    expect(pipeline.map((stage) => Object.keys(stage)[0])).toEqual([
      "$search",
      "$match",
      "$limit",
      "$project",
    ]);
    expect(pipeline[0]?.["$search"]).toEqual({
      index: TEXT_INDEX_NAME,
      text: { query: "proxy_buffering", path: "text" },
    });
    expect(pipeline[1]?.["$match"]).toEqual({
      embeddingVersion: 7,
      "meta.type": "divergence",
      "meta.project": "bizcare-web",
    });
    expect(pipeline[2]?.["$limit"]).toBe(CONFIG.textK * CONFIG.candidateOverfetch);
  });

  it("두 경로 모두 score를 $meta로 투영한다", async () => {
    const fake = makeDb({});
    await retrieverOn(fake).retrieve({ query: "질의" });

    const vectorProject = pipelineWith(fake, "$vectorSearch").at(-1);
    const textProject = pipelineWith(fake, "$search").at(-1);
    expect(asRecord(vectorProject?.["$project"])?.["score"]).toEqual({
      $meta: "vectorSearchScore",
    });
    expect(asRecord(textProject?.["$project"])?.["score"]).toEqual({ $meta: "searchScore" });
  });
});

describe("융합과 dedupe", () => {
  it("두 경로 결과를 RRF로 융합하고 어느 경로가 기여했는지 남긴다", async () => {
    const fake = makeDb({
      vector: [chunkDoc("c1", "r1", 0.9), chunkDoc("c2", "r2", 0.8)],
      text: [chunkDoc("c2", "r2", 3.5), chunkDoc("c3", "r3", 2.1)],
      records: [recordDoc("r1"), recordDoc("r2"), recordDoc("r3")],
    });

    const result = await retrieverOn(fake).retrieve({ query: "질의" });

    // c2만 두 경로에 있으므로 RRF 점수가 가장 높다.
    expect(result.hits.map((h) => h.chunkId)).toEqual(["c2", "c1", "c3"]);
    expect(result.hits[0]).toMatchObject({
      chunkId: "c2",
      vectorRank: 2,
      textRank: 1,
      // Atlas 원본은 0.8(정규화) → 원시 cosine 0.6. textScore는 BM25라 그대로다.
      vectorScore: expect.closeTo(0.6, 10),
      textScore: 3.5,
      title: "제목 r2",
      summary: "요약 r2",
      type: "incident",
      project: "sentinel-kb",
    });
    expect(result.hits[1]).toMatchObject({ vectorRank: 1, textRank: null, textScore: null });
    expect(result.hits[2]).toMatchObject({ vectorRank: null, vectorScore: null, textRank: 2 });
    expect(result.vectorCandidateCount).toBe(2);
    expect(result.textCandidateCount).toBe(2);
  });

  it("한 record의 4개 섹션이 상위여도 2개만 남는다", async () => {
    const fake = makeDb({
      vector: [
        chunkDoc("a1", "r1", 0.9, { section: "symptom" }),
        chunkDoc("a2", "r1", 0.88, { section: "rootCause" }),
        chunkDoc("a3", "r1", 0.86, { section: "resolution" }),
        chunkDoc("a4", "r1", 0.84, { section: "prevention" }),
        chunkDoc("b1", "r2", 0.5),
      ],
      records: [recordDoc("r1"), recordDoc("r2")],
    });

    const result = await retrieverOn(fake).retrieve({ query: "질의" });

    expect(result.hits.map((h) => h.chunkId)).toEqual(["a1", "a2", "b1"]);
    expect(result.hits.filter((h) => h.recordId === "r1")).toHaveLength(2);
  });

  /**
   * T-005 F-3. 장문 레코드 1건(청크 28개)이 후보 앞줄을 전부 차지해도 최종 결과를
   * 독점하지 못해야 한다. 후보 단계 상한이 없으면 `vectorK`(=4) 슬롯을 장문이 다 먹고
   * dedupe 후 레코드가 1건만 남는다.
   */
  it("장문 레코드가 후보 슬롯을 독점하지 못한다", async () => {
    const monster = Array.from({ length: 28 }, (_, i) =>
      chunkDoc(`long-${String(i)}`, "r-long", 0.9 - i / 1000),
    );
    const shorts = Array.from({ length: 5 }, (_, i) =>
      chunkDoc(`short-${String(i)}`, `r-short-${String(i)}`, 0.5 - i / 1000),
    );

    const fake = makeDb({
      vector: [...monster, ...shorts],
      records: [
        recordDoc("r-long"),
        ...shorts.map((_, i) => recordDoc(`r-short-${String(i)}`)),
      ],
    });

    const result = await retrieverOn(fake).retrieve({ query: "질의" });

    expect(result.hits.filter((h) => h.recordId === "r-long")).toHaveLength(2);
    expect(new Set(result.hits.map((h) => h.recordId)).size).toBeGreaterThan(1);
  });

  it("limit을 주면 그만큼만 돌려준다", async () => {
    const fake = makeDb({
      vector: [chunkDoc("c1", "r1", 0.9), chunkDoc("c2", "r2", 0.8), chunkDoc("c3", "r3", 0.7)],
      records: [recordDoc("r1"), recordDoc("r2"), recordDoc("r3")],
    });

    const result = await retrieverOn(fake).retrieve({ query: "질의", limit: 1 });
    expect(result.hits.map((h) => h.chunkId)).toEqual(["c1"]);
  });
});

/**
 * T-010 F-6: `lucene.standard`는 한국어 형태소 분석을 하지 않는다. 한국어 서술형 질의에서
 * 텍스트 경로가 0건이 되는 것은 **버그가 아니라 정상 경로**이며, 그때도 결과가 나와야 한다.
 */
describe("한쪽 경로가 0건", () => {
  it("텍스트 0건이어도 벡터 결과만으로 답한다", async () => {
    const fake = makeDb({
      vector: [chunkDoc("c1", "r1", 0.77)],
      text: [],
      records: [recordDoc("r1")],
    });

    const result = await retrieverOn(fake).retrieve({ query: "왜 이렇게 느려졌을까" });

    expect(result.hits.map((h) => h.chunkId)).toEqual(["c1"]);
    expect(result.textCandidateCount).toBe(0);
    // Atlas 원본은 0.77(정규화) → 원시 cosine 0.54.
    expect(result.maxVectorScore).toBeCloseTo(0.54, 10);
  });

  it("벡터 0건이어도 텍스트 결과만으로 답하고, maxVectorScore는 0이 아니라 null이다", async () => {
    const fake = makeDb({
      vector: [],
      text: [chunkDoc("c9", "r9", 4.2)],
      records: [recordDoc("r9")],
    });

    const result = await retrieverOn(fake).retrieve({ query: "ECONNRESET" });

    expect(result.hits.map((h) => h.chunkId)).toEqual(["c9"]);
    // "0점"과 "판정 불가"는 다르다. 0이면 T-018의 임계값 게이트가 '유사도 0'으로 오판한다.
    expect(result.maxVectorScore).toBeNull();
    // BM25는 cosine이 아니다 — 환산 대상이 아니므로 드라이버 값 그대로여야 한다.
    expect(result.hits[0]?.textScore).toBe(4.2);
  });

  it("양쪽 0건이면 빈 결과다", async () => {
    const result = await retrieverOn(makeDb({})).retrieve({ query: "없는 것" });
    expect(result.hits).toEqual([]);
    expect(result.maxVectorScore).toBeNull();
  });
});

/**
 * 감사 B-1. RRF 점수(k=60이면 최대 약 0.033)와 cosine(0–1)은 척도가 달라 비교할 수 없다.
 * `maxVectorScore`가 RRF 점수로 바꿔치기되면 T-018이 모든 질의에 found:false를 낸다.
 */
describe("maxVectorScore (감사 B-1)", () => {
  it("융합·상한·dedupe 이전의 원시 cosine 최고점이다", async () => {
    const fake = makeDb({
      // 최고점 청크 3개가 같은 record라 상한(2)에 걸려 하나는 잘려 나간다.
      vector: [
        chunkDoc("m1", "r1", 0.93),
        chunkDoc("m2", "r1", 0.91),
        chunkDoc("m3", "r1", 0.9),
        chunkDoc("m4", "r2", 0.4),
      ],
      records: [recordDoc("r1"), recordDoc("r2")],
    });

    const result = await retrieverOn(fake).retrieve({ query: "질의" });

    // Atlas 원본은 0.93(정규화) → 원시 cosine 0.86.
    expect(result.maxVectorScore).toBeCloseTo(0.86, 10);
    // 잘려나간 청크가 있어도 최고점은 그대로다.
    expect(result.hits.filter((h) => h.recordId === "r1")).toHaveLength(2);
  });

  /**
   * hit별 `vectorScore`는 **후보 상한을 적용하기 전의 원시 목록**에서 온다.
   * 상한에 걸려 융합에 못 들어간 청크라도 벡터 경로가 점수를 매겼다면 그 값을 보고한다 —
   * T-013 eval이 hit마다 cosine을 볼 수 있어야 순위·임계값을 함께 스윕할 수 있다.
   * (`vectorRank`는 반대다: 융합에 들어간 순위이므로 상한에 걸리면 null이다. 둘은 다른 질문에 답한다.)
   */
  it("상한에 걸려 융합에서 빠진 청크도 원시 cosine을 보고한다", async () => {
    const fake = makeDb({
      vector: [chunkDoc("c1", "r1", 0.9), chunkDoc("c2", "r1", 0.8), chunkDoc("c3", "r1", 0.7)],
      text: [chunkDoc("c3", "r1", 5)],
      records: [recordDoc("r1")],
    });

    const result = await retrieverOn(fake).retrieve({ query: "질의" });
    const revived = result.hits.find((h) => h.chunkId === "c3");

    expect(revived).toBeDefined();
    // 벡터 후보에서는 상한(2)에 걸려 잘렸다 → rank는 없다.
    expect(revived?.vectorRank).toBeNull();
    // 그래도 벡터 경로가 매긴 원시 점수는 남는다. Atlas 원본 0.7(정규화) → 원시 cosine 0.4.
    expect(revived?.vectorScore).toBeCloseTo(0.4, 10);
    expect(revived?.textRank).toBe(1);
  });

  it("RRF 점수와 다른 값이다 — 척도가 섞이지 않았다", async () => {
    const fake = makeDb({
      vector: [chunkDoc("c1", "r1", 0.93)],
      text: [chunkDoc("c1", "r1", 8.5)],
      records: [recordDoc("r1")],
    });

    const result = await retrieverOn(fake).retrieve({ query: "질의" });
    const hit = result.hits[0];

    expect(result.maxVectorScore).toBeCloseTo(0.86, 10);
    // 두 경로 1위 × RRF_K=60 → 2/61 ≈ 0.0328. cosine 임계값(0.62)과 비교 불가한 척도다.
    expect(hit?.fusedScore).toBeCloseTo(2 / 61, 12);
    expect(hit?.fusedScore).toBeLessThan(0.62);
    expect(result.maxVectorScore).not.toBe(hit?.fusedScore);
  });
});

/**
 * Atlas의 `vectorSearchScore`는 **원시 cosine이 아니라 `(1 + cos) / 2`로 정규화된 0–1 값**이다
 * (실측: 동일 1.0 / 45° 0.8536 / 60° 0.75 / 직교 0.5 / 120° 0.25 / 정반대 0.0).
 * retriever의 `toRawCosine`이 `cos = 2·s − 1`로 되돌려서 돌려준다 — 그래야 코드가
 * specs/03 §4의 "원시 cosine 최고점"과 `SIMILARITY_THRESHOLD=0.62`를 같은 척도로 비교한다.
 * 환산이 빠지면 0.62는 실제로 원시 cosine 0.24 게이트가 된다.
 *
 * 여기서는 컨테이너 없이 **환산식 자체**를 잠근다. Atlas가 정말 그 값을 주는지는
 * `retrieve.int.spec.ts`가 실제 인덱스로 판정한다 — 둘 다 있어야 방어선이 성립한다.
 */
describe("cosine 척도 환산 (toRawCosine)", () => {
  it("정규화 0–1을 원시 cosine −1..1로 되돌린다", async () => {
    const fake = makeDb({
      vector: [
        // 동일 방향, 직교, 정반대. Atlas가 주는 값이 각각 1 / 0.5 / 0이다.
        chunkDoc("same", "r1", 1),
        chunkDoc("orthogonal", "r2", 0.5),
        chunkDoc("opposite", "r3", 0),
      ],
      records: [recordDoc("r1"), recordDoc("r2"), recordDoc("r3")],
    });

    const result = await retrieverOn(fake).retrieve({ query: "질의" });
    const byId = new Map(result.hits.map((h) => [h.chunkId, h.vectorScore]));

    expect(byId.get("same")).toBeCloseTo(1, 10);
    expect(byId.get("orthogonal")).toBeCloseTo(0, 10);
    expect(byId.get("opposite")).toBeCloseTo(-1, 10);
    // 질의 단위 최고점도 **같은 척도**여야 한다 — 두 곳에서 따로 곱하면 언젠가 갈린다.
    expect(result.maxVectorScore).toBeCloseTo(1, 10);
  });

  it("maxVectorScore는 음수일 수 있다 — null과 다른 상태다", async () => {
    const fake = makeDb({
      // 정반대(0) · 120°(0.25) 후보뿐이면 원시 cosine은 전부 음수다.
      vector: [chunkDoc("c1", "r1", 0.25), chunkDoc("c2", "r2", 0)],
      records: [recordDoc("r1"), recordDoc("r2")],
    });

    const result = await retrieverOn(fake).retrieve({ query: "질의" });

    // 벡터 경로가 **일했다**. null(판정 불가)과 음수(아주 안 맞음)는 T-018 게이트에서 다른 분기다.
    expect(result.maxVectorScore).not.toBeNull();
    expect(result.maxVectorScore).toBeLessThan(0);
    expect(result.maxVectorScore).toBeCloseTo(-0.5, 10);
    expect(result.hits.map((h) => h.vectorScore)).toEqual([
      expect.closeTo(-0.5, 10),
      expect.closeTo(-1, 10),
    ]);
  });

  it("BM25 textScore는 환산하지 않는다 — cosine이 아니다", async () => {
    const fake = makeDb({
      // 같은 청크가 두 경로에 있다. 같은 숫자 0.5가 경로에 따라 다르게 다뤄져야 한다.
      vector: [chunkDoc("c1", "r1", 0.5)],
      text: [chunkDoc("c1", "r1", 0.5)],
      records: [recordDoc("r1")],
    });

    const result = await retrieverOn(fake).retrieve({ query: "질의" });

    expect(result.hits[0]?.vectorScore).toBeCloseTo(0, 10);
    expect(result.hits[0]?.textScore).toBe(0.5);
  });
});

describe("플래그와 데이터 무결성", () => {
  /** specs/03 §2: injection-suspect는 **목록에는 경고와 함께 노출**하고 생성에서만 뺀다. */
  it("injection-suspect 청크를 결과에 남기고 flags로 표시한다", async () => {
    const fake = makeDb({
      vector: [
        chunkDoc("c1", "r1", 0.9, { flags: ["injection-suspect", "secret-masked"] }),
        chunkDoc("c2", "r2", 0.8),
      ],
      records: [recordDoc("r1"), recordDoc("r2")],
    });

    const result = await retrieverOn(fake).retrieve({ query: "질의" });

    expect(result.hits.map((h) => h.chunkId)).toContain("c1");
    expect(result.hits[0]?.flags).toEqual<SanitizeFlag[]>(["injection-suspect", "secret-masked"]);
    expect(result.hits[1]?.flags).toEqual([]);
  });

  it("알 수 없는 플래그는 버린다", async () => {
    const fake = makeDb({
      vector: [chunkDoc("c1", "r1", 0.9, { flags: ["injection-suspect", "made-up"] })],
      records: [recordDoc("r1")],
    });

    const result = await retrieverOn(fake).retrieve({ query: "질의" });
    expect(result.hits[0]?.flags).toEqual(["injection-suspect"]);
  });

  it("record가 사라진 고아 청크는 결과에서 뺀다", async () => {
    const fake = makeDb({
      vector: [chunkDoc("c1", "r-gone", 0.9), chunkDoc("c2", "r2", 0.8)],
      records: [recordDoc("r2")],
    });

    const result = await retrieverOn(fake).retrieve({ query: "질의" });
    expect(result.hits.map((h) => h.recordId)).toEqual(["r2"]);
  });

  it("records 조회는 최종 hit의 record만 요청한다", async () => {
    const fake = makeDb({
      vector: [chunkDoc("c1", "r1", 0.9), chunkDoc("c2", "r2", 0.8), chunkDoc("c3", "r3", 0.7)],
      records: [recordDoc("r1"), recordDoc("r2"), recordDoc("r3")],
    });

    await retrieverOn(fake).retrieve({ query: "질의", limit: 2 });

    const recordsCall = fake.calls.find((c) => c.collection === "records");
    expect(matchedIds(recordsCall?.pipeline ?? [])).toEqual(["r1", "r2"]);
  });
});

describe("실패 경로", () => {
  it("빈 쿼리는 QUERY_EMPTY로 거절한다", async () => {
    await expect(retrieverOn(makeDb({})).retrieve({ query: "   " })).rejects.toMatchObject({
      code: RETRIEVER_ERROR_CODES.QUERY_EMPTY,
    });
  });

  it("embedder 차원이 다르면 QUERY_VECTOR_INVALID로 즉시 죽는다", async () => {
    const wrong: Embedder = {
      dim: QUERY_VECTOR.length,
      version: 7,
      embed: () => Promise.resolve([[1, 2]]),
    };
    const retriever = createRetriever({ db: makeDb({}).db, embedder: wrong, config: CONFIG });

    // 차원이 vec_idx와 다르면 $vectorSearch가 통째로 실패한다 — 그 전에 잡는다.
    await expect(retriever.retrieve({ query: "질의" })).rejects.toMatchObject({
      code: RETRIEVER_ERROR_CODES.QUERY_VECTOR_INVALID,
    });
  });

  it("score $meta 투영이 없는 후보는 CANDIDATE_INVALID로 죽는다", async () => {
    const broken = chunkDoc("c1", "r1", 0);
    delete broken["score"];
    const fake = makeDb({ vector: [broken], records: [recordDoc("r1")] });

    // 조용히 0점으로 흘려보내면 maxVectorScore 게이트가 오작동한다.
    await expect(retrieverOn(fake).retrieve({ query: "질의" })).rejects.toMatchObject({
      code: RETRIEVER_ERROR_CODES.CANDIDATE_INVALID,
    });
  });

  it("section이 스키마 밖이면 CANDIDATE_INVALID로 죽는다", async () => {
    const fake = makeDb({
      vector: [chunkDoc("c1", "r1", 0.9, { section: "notASection" })],
      records: [recordDoc("r1")],
    });

    await expect(retrieverOn(fake).retrieve({ query: "질의" })).rejects.toMatchObject({
      code: RETRIEVER_ERROR_CODES.CANDIDATE_INVALID,
    });
  });

  /**
   * `text`·`project`·`seq`도 `section`·`type`과 같은 강도로 검사한다.
   * contracts의 `Chunk`가 `text.min(1)`·`project.min(1)`·`seq.int().nonnegative()`를 요구하므로
   * 같은 함수 안에서 엄격/관대가 갈릴 근거가 없다. 특히 **빈 `text`를 조용히 통과시키면**
   * T-018이 그 청크로 인용을 만들어 놓고 근거가 없는 답을 낸다.
   */
  it("text가 비면 CANDIDATE_INVALID로 죽는다 — 빈 본문은 근거 없는 인용이 된다", async () => {
    const fake = makeDb({
      vector: [chunkDoc("c1", "r1", 0.9, { text: "" })],
      records: [recordDoc("r1")],
    });

    await expect(retrieverOn(fake).retrieve({ query: "질의" })).rejects.toMatchObject({
      code: RETRIEVER_ERROR_CODES.CANDIDATE_INVALID,
    });
  });

  it("text가 문자열이 아니어도 CANDIDATE_INVALID로 죽는다", async () => {
    const broken = chunkDoc("c1", "r1", 0.9);
    broken["text"] = 42;
    const fake = makeDb({ vector: [broken], records: [recordDoc("r1")] });

    await expect(retrieverOn(fake).retrieve({ query: "질의" })).rejects.toMatchObject({
      code: RETRIEVER_ERROR_CODES.CANDIDATE_INVALID,
    });
  });

  it("meta.project가 비면 CANDIDATE_INVALID로 죽는다", async () => {
    const fake = makeDb({
      vector: [chunkDoc("c1", "r1", 0.9, { project: "" })],
      records: [recordDoc("r1")],
    });

    // 빈 project는 결과가 보고하는 소속을 지운다 — 필터가 본 값과 어긋난다.
    await expect(retrieverOn(fake).retrieve({ query: "질의" })).rejects.toMatchObject({
      code: RETRIEVER_ERROR_CODES.CANDIDATE_INVALID,
    });
  });

  it("seq가 없으면 CANDIDATE_INVALID로 죽는다 — 0으로 접으면 청크 identity가 충돌한다", async () => {
    const broken = chunkDoc("c1", "r1", 0.9);
    delete broken["seq"];
    const fake = makeDb({ vector: [broken], records: [recordDoc("r1")] });

    await expect(retrieverOn(fake).retrieve({ query: "질의" })).rejects.toMatchObject({
      code: RETRIEVER_ERROR_CODES.CANDIDATE_INVALID,
    });
  });

  it("text 경로 후보에도 같은 검사가 걸린다", async () => {
    const fake = makeDb({
      text: [chunkDoc("c1", "r1", 3.2, { text: "" })],
      records: [recordDoc("r1")],
    });

    await expect(retrieverOn(fake).retrieve({ query: "질의" })).rejects.toMatchObject({
      code: RETRIEVER_ERROR_CODES.CANDIDATE_INVALID,
    });
  });
});

describe("config 주입", () => {
  it("config를 안 주면 env에서 읽는다", () => {
    const retriever = createRetriever({
      db: makeDb({}).db,
      embedder,
      env: { RETRIEVAL_FINAL_K: "2", RRF_K: "5" },
    });

    expect(retriever.config.finalK).toBe(2);
    expect(retriever.config.rrfK).toBe(5);
  });
});
