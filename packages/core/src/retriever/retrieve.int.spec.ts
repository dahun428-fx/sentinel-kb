/**
 * T-011 통합 테스트. `mongodb/mongodb-atlas-local` 컨테이너에서 **실제 `$vectorSearch`·`$search`**를
 * 돌린다. 컨테이너 부팅은 `../testing/atlas-local.ts`(T-010에서 뽑은 공용 게이트)를 쓴다.
 *
 * **컨테이너를 못 쓰는 환경에서는 skip한다. 통과시키지 않는다.** skip은 조용히 일어나지 않는다.
 *
 * ## 벡터를 직접 심는다 (T-006 F-8)
 * `FakeEmbedder`는 해시 기반이라 서로 다른 텍스트 간 cosine ≈ 0이다(실측 mean −0.00007).
 * 그걸로 "서술형 쿼리는 벡터 경로가 기여한다"를 검증하면 **공허한 그린**이 난다.
 * 그래서 여기 embedder는 질의 문자열 → 벡터의 **명시적 표**이고, 청크 벡터도 손으로 심는다.
 * 검증 대상은 임베딩 품질이 아니라 `$vectorSearch`가 그 벡터로 무엇을 하는가다.
 */
import { ObjectId, type Db } from "mongodb";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { createRetriever, type Retriever } from "./retrieve.js";
import type { RetrievalConfig } from "./config.js";
import {
  buildSearchIndexPlans,
  ensureSearchIndexes,
  waitForSearchIndexesReady,
} from "../db/search-indexes.js";
import type { Embedder } from "../embedder/types.js";
import {
  ATLAS_LOCAL_BOOT_TIMEOUT_MS,
  dockerAvailable,
  pollUntil,
  startAtlasLocal,
  warnDockerMissing,
  type AtlasLocalHandle,
} from "../testing/atlas-local.js";

const CONTAINER_NAME = `sentinel-t011-${process.pid}`;
const DB_NAME = "sentinel_t011_int";
/** 테스트 전용 차원. 실제 모델 차원과 무관해야 env가 소스임이 드러난다. */
const DIM = 4;
const EMBEDDING_VERSION = 1;
const STALE_EMBEDDING_VERSION = 0;
/**
 * `$limit` 순서 픽스처 전용 버전. 이 청크들은 다른 어떤 테스트의 후보 풀에도 들어가면 안 된다 —
 * 22건이 벡터 후보 목록을 밀어내면 기존 단언들이 픽스처 때문에 흔들린다. `embeddingVersion`
 * 필터가 두 경로 모두에 걸리므로, 별도 버전을 주는 것만으로 완전히 격리된다.
 */
const PROBE_EMBEDDING_VERSION = 2;
const QUERY_TIMEOUT_MS = 90_000;

const HAS_DOCKER = dockerAvailable();
if (!HAS_DOCKER) {
  warnDockerMissing("T-011", "retrieve.int.spec.ts", "하이브리드 검색(Acceptance 3)");
}

/* --------------------------------------------------------------------------
 * 픽스처
 * ----------------------------------------------------------------------- */

/** 한국어 서술형. `lucene.standard`가 "끊길까"·"응답이"를 통째 토큰으로 잡아 매칭에 실패한다. */
const KOREAN_PROSE_QUERY = "왜 응답이 자꾸 끊길까";
/** 영문 식별자. 텍스트 경로가 본래 잘하는 것 — 임베딩이 약한 리터럴이다. */
const LITERAL_QUERY = "proxy_buffering";

/**
 * `$limit`이 실제로 바인딩되는 규모를 만드는 전용 토큰. 다른 픽스처 텍스트와 절대 겹치지 않도록
 * 사전에 없는 문자열을 쓴다(`lucene.standard`가 통째 토큰으로 잡는다).
 */
const LIMIT_PROBE_TOKEN = "zzlimitprobe";

/** 질의 문자열 → 벡터. 임베딩 품질에 기대지 않으려고 표로 고정한다. */
const QUERY_VECTORS: Record<string, number[]> = {
  [KOREAN_PROSE_QUERY]: [1, 0, 0, 0],
  [LITERAL_QUERY]: [0, 0, 1, 0],
  [LIMIT_PROBE_TOKEN]: [0, 1, 0, 0],
};

const embedder: Embedder = {
  dim: DIM,
  version: EMBEDDING_VERSION,
  embed: (texts) => Promise.resolve(texts.map((t) => QUERY_VECTORS[t] ?? [0, 1, 0, 0])),
};

const R_LONG = new ObjectId();
const R_SHORT = [new ObjectId(), new ObjectId(), new ObjectId()];
const R_LITERAL = new ObjectId();
const R_OTHER_PROJECT = new ObjectId();
const R_DIVERGENCE = new ObjectId();
const R_STALE = new ObjectId();
/** 질의 벡터의 정반대만 남는 격리된 프로젝트. `maxVectorScore < 0`을 만드는 유일한 경로다. */
const R_ANTIPODAL = new ObjectId();
const ANTIPODAL_PROJECT = "antipodal-only";

interface ChunkFixture {
  recordId: ObjectId;
  section: string;
  seq: number;
  text: string;
  embedding: number[];
  type?: string;
  project?: string;
  flags?: string[];
  embeddingVersion?: number;
}

/** 장문 레코드 1건이 청크 6개(T-005 F-3의 "28청크까지 간다"의 축소판). 전부 질의 벡터에 가깝다. */
const LONG_SECTIONS = [
  "symptom",
  "rootCause",
  "resolution",
  "prevention",
  "expected",
  "actual",
];
const LONG_CHUNKS: ChunkFixture[] = LONG_SECTIONS.map((section, i) => ({
  recordId: R_LONG,
  section,
  seq: 0,
  text: `장문 사례 섹션${String(i)} 게이트웨이 타임아웃 조사 기록`,
  embedding: [1, i / 1000, 0, 0],
}));

const CHUNKS: ChunkFixture[] = [
  ...LONG_CHUNKS,
  ...R_SHORT.map((recordId, i) => ({
    recordId,
    section: "symptom",
    seq: 0,
    text: `짧은 사례 ${String(i)} 커넥션풀 고갈 관측`,
    // 장문보다 약간 멀다 — 후보 앞줄은 장문이 독점한다.
    embedding: [0.98, 0.2, 0, 0],
  })),
  {
    recordId: R_LITERAL,
    section: "resolution",
    seq: 0,
    text: "nginx proxy_buffering off 를 넣어 SSE 버퍼링을 껐다",
    // 질의 벡터 [0,0,1,0]의 정반대 — 벡터 경로에서는 꼴찌다.
    embedding: [0, 0, -1, 0],
    flags: ["injection-suspect"],
  },
  {
    recordId: R_OTHER_PROJECT,
    section: "symptom",
    seq: 0,
    text: "다른 프로젝트의 무관한 기록 게이트웨이 언급",
    // 질의 벡터 [0,0,1,0]와 거의 같은 방향 — 벡터 경로 1위다.
    embedding: [0, 0, 0.99, 0.1],
    project: "bizcare-web",
  },
  {
    recordId: R_DIVERGENCE,
    section: "correction",
    seq: 0,
    text: "에이전트 산출물 이격 기록 게이트웨이 관련",
    embedding: [0, 0, 0.9, 0.3],
    type: "divergence",
  },
  {
    recordId: R_STALE,
    section: "symptom",
    seq: 0,
    text: "구버전 임베딩으로 남은 청크 게이트웨이",
    embedding: [0, 0, 1, 0],
    embeddingVersion: STALE_EMBEDDING_VERSION,
  },
  {
    recordId: R_ANTIPODAL,
    section: "symptom",
    seq: 0,
    text: "고립된 프로젝트의 정반대 벡터 기록",
    // 질의 [0,0,1,0]의 정반대. 이 프로젝트로 필터하면 후보가 이것뿐이다.
    embedding: [0, 0, -1, 0],
    project: ANTIPODAL_PROJECT,
  },
];

/* --------------------------------------------------------------------------
 * `$search → $match → $limit` 순서 픽스처 (검증 지적 2)
 *
 * 순서 단언(`retrieve.spec.ts`의 스테이지 배열)만으로는 **행동**이 지켜지지 않는다.
 * 리팩터링으로 배열 모양이 바뀌면 방어선이 통째로 사라진다. 그래서 여기서는
 * `$limit`이 **실제로 바인딩되는 규모**를 만들고 **결과 건수로** 잠근다.
 *
 * 설계:
 *  - 같은 토큰에 매칭되는 청크를 `textK × candidateOverfetch`(= 16)보다 많이 넣는다(22건).
 *  - 그중 필터(project)를 통과하는 것은 **BM25 점수가 낮은 소수**(2건)뿐이다.
 *    노이즈는 토큰을 여러 번 담은 짧은 문서라 tf·길이정규화 양쪽에서 앞선다.
 *  - 따라서 `$limit`이 `$match` 앞으로 가면 상위 16건은 전부 노이즈가 되고,
 *    필터 통과분 2건은 **결과에서 사라진다**(0건).
 *
 * `embeddingVersion`을 따로 주어 다른 테스트의 후보 풀에서 완전히 격리한다.
 * ----------------------------------------------------------------------- */

const LIMIT_PROBE_NOISE_PROJECT = "limit-probe-noise";
const LIMIT_PROBE_TARGET_PROJECT = "limit-probe-target";
/** 16(= textK 4 × overfetch 4)을 넘겨야 `$limit`이 실제로 자른다. */
const LIMIT_PROBE_NOISE_COUNT = 20;
const LIMIT_PROBE_TARGET_COUNT = 2;

const LIMIT_PROBE_NOISE_IDS = Array.from({ length: LIMIT_PROBE_NOISE_COUNT }, () => new ObjectId());
const LIMIT_PROBE_TARGET_IDS = Array.from(
  { length: LIMIT_PROBE_TARGET_COUNT },
  () => new ObjectId(),
);

/** 토큰을 여러 번 담은 짧은 문서 — tf가 높고 길이가 짧아 BM25 상위를 독점한다. */
const LIMIT_PROBE_NOISE_CHUNKS: ChunkFixture[] = LIMIT_PROBE_NOISE_IDS.map((recordId) => ({
  recordId,
  section: "symptom",
  seq: 0,
  text: Array.from({ length: 8 }, () => LIMIT_PROBE_TOKEN).join(" "),
  embedding: [0, 1, 0, 0],
  project: LIMIT_PROBE_NOISE_PROJECT,
  embeddingVersion: PROBE_EMBEDDING_VERSION,
}));

/**
 * 토큰 1회 + 긴 filler — BM25 최하위로 밀려 목록 뒤쪽에 선다.
 * 벡터도 노이즈의 정반대로 둔다: 벡터 경로가 타깃을 끌어올리면 "텍스트 경로에서 잘렸다"는
 * 판정이 흐려져 아래 전제 테스트가 간헐적으로 갈린다.
 */
const LIMIT_PROBE_TARGET_CHUNKS: ChunkFixture[] = LIMIT_PROBE_TARGET_IDS.map((recordId, i) => ({
  recordId,
  section: "resolution",
  seq: 0,
  text: `${LIMIT_PROBE_TOKEN} ${String(i)} ${Array.from(
    { length: 60 },
    (_, w) => `filler${String(w)}`,
  ).join(" ")}`,
  embedding: [0, -1, 0, 0],
  project: LIMIT_PROBE_TARGET_PROJECT,
  embeddingVersion: PROBE_EMBEDDING_VERSION,
}));

const ALL_CHUNKS: ChunkFixture[] = [
  ...CHUNKS,
  ...LIMIT_PROBE_NOISE_CHUNKS,
  ...LIMIT_PROBE_TARGET_CHUNKS,
];

const RECORD_IDS = [
  R_LONG,
  ...R_SHORT,
  R_LITERAL,
  R_OTHER_PROJECT,
  R_DIVERGENCE,
  R_STALE,
  R_ANTIPODAL,
  ...LIMIT_PROBE_NOISE_IDS,
  ...LIMIT_PROBE_TARGET_IDS,
];

const CONFIG: RetrievalConfig = {
  vectorK: 4,
  textK: 4,
  finalK: 4,
  rrfK: 60,
  numCandidates: 64,
  candidateOverfetch: 4,
  maxChunksPerRecord: 2,
  relationExpansion: false,
};

let handle: AtlasLocalHandle | undefined;
let db: Db;
let retriever: Retriever;

beforeAll(async () => {
  if (!HAS_DOCKER) return;
  handle = await startAtlasLocal({ containerName: CONTAINER_NAME, dbName: DB_NAME });
  db = handle.db;

  await ensureSearchIndexes(db, { dim: DIM });
  await waitForSearchIndexesReady(db, buildSearchIndexPlans(DIM), {
    pollIntervalMs: 500,
    readyTimeoutMs: 180_000,
  });

  await db.collection("records").insertMany(
    RECORD_IDS.map((id) => ({
      _id: id,
      title: `제목 ${id.toHexString()}`,
      summary: `요약 ${id.toHexString()}`,
    })),
  );
  await db.collection("chunks").insertMany(
    ALL_CHUNKS.map((chunk) => ({
      recordId: chunk.recordId,
      section: chunk.section,
      seq: chunk.seq,
      text: chunk.text,
      embedding: chunk.embedding,
      meta: {
        type: chunk.type ?? "incident",
        project: chunk.project ?? "sentinel-kb",
        severity: "SEV2",
        tags: [],
        sanitizeFlags: chunk.flags ?? [],
      },
      embeddingVersion: chunk.embeddingVersion ?? EMBEDDING_VERSION,
    })),
  );

  retriever = createRetriever({ db, embedder, config: CONFIG });

  // 검색 인덱스는 READY 이후에도 새 문서를 반영하는 데 잠깐 걸린다.
  await pollUntil(
    () => retriever.retrieve({ query: LITERAL_QUERY }),
    (result) => result.textCandidateCount > 0 && result.vectorCandidateCount > 0,
    QUERY_TIMEOUT_MS,
  );
  // 정반대 벡터 픽스처(격리 프로젝트)도 반영될 때까지 기다린다.
  await pollUntil(
    () => retriever.retrieve({ query: LITERAL_QUERY, project: ANTIPODAL_PROJECT }),
    (result) => result.vectorCandidateCount > 0,
    QUERY_TIMEOUT_MS,
  );
  // `$limit` 순서 픽스처 22건이 전부 색인될 때까지. 덜 색인된 상태로 세면 건수 단언이 흔들린다.
  const probe = createRetriever({
    db,
    embedder: { ...embedder, version: PROBE_EMBEDDING_VERSION },
    config: CONFIG,
  });
  await pollUntil(
    () => probe.retrieve({ query: LIMIT_PROBE_TOKEN }),
    (result) => result.textCandidateCount === CONFIG.textK * CONFIG.candidateOverfetch,
    QUERY_TIMEOUT_MS,
  );
}, ATLAS_LOCAL_BOOT_TIMEOUT_MS);

afterAll(async () => {
  await handle?.stop();
});

describe.skipIf(!HAS_DOCKER)("컨테이너와 인덱스가 실제로 살아 있다", () => {
  it("ping이 통하고 두 인덱스가 READY다", async () => {
    // 아래 단언들이 죽은 연결 위에서 공허하게 통과하지 않도록 먼저 확인한다.
    expect((await db.admin().command({ ping: 1 }))["ok"]).toBe(1);

    const indexes: Record<string, unknown>[] = await db
      .collection("chunks")
      .listSearchIndexes()
      .toArray();
    expect(indexes.map((i) => [i["name"], i["status"]]).sort()).toEqual([
      ["text_idx", "READY"],
      ["vec_idx", "READY"],
    ]);
  });
});

/**
 * T-010 F-7 방어선. `pnpm db:search-indexes`는 dim만 대조하므로 기존 인덱스의
 * `similarity`가 `euclidean`으로 드리프트해도 READY/exit 0을 보고한다. 그 순간
 * 점수가 0–1 cosine 척도가 아니게 되고 `SIMILARITY_THRESHOLD` 게이트가 조용히 오작동한다.
 * **retriever가 돌려주는 점수의 척도를 여기서 단언한다.**
 */
describe.skipIf(!HAS_DOCKER)("cosine 점수 척도 (T-010 F-7)", () => {
  it("동일 방향 벡터면 maxVectorScore가 1에 붙는다", async () => {
    // 장문 청크 0번의 embedding이 질의 벡터 [1,0,0,0]과 정확히 같다.
    const result = await retriever.retrieve({ query: KOREAN_PROSE_QUERY });

    expect(result.maxVectorScore).not.toBeNull();
    expect(result.maxVectorScore).toBeGreaterThan(0.99);
    expect(result.maxVectorScore).toBeLessThanOrEqual(1);
  });

  it("hit별 vectorScore는 원시 cosine 범위 −1..1 안에 있다", async () => {
    const result = await retriever.retrieve({ query: KOREAN_PROSE_QUERY });

    const scores = result.hits.map((h) => h.vectorScore).filter((s): s is number => s !== null);
    expect(scores.length).toBeGreaterThan(0);
    for (const score of scores) {
      // 0이 아니라 −1이 하한이다. retriever가 Atlas의 정규화 값을 원시 cosine으로 되돌린다.
      expect(score).toBeGreaterThanOrEqual(-1);
      expect(score).toBeLessThanOrEqual(1);
    }
  });

  /**
   * **척도를 양 끝과 중간에서 못박는다: 동일 ≈1 / 직교 ≈0 / 정반대 ≈−1.**
   *
   * Atlas가 주는 `vectorSearchScore`는 원시 cosine이 아니라 `(1 + cos) / 2`로 정규화된
   * 0–1 값이다(실측: 동일 1.0 / 45° 0.8536 / 60° 0.75 / 직교 **0.5** / 120° 0.25 / 정반대 **0.0**).
   * retriever의 `toRawCosine`이 `cos = 2·s − 1`로 되돌리므로 여기 기대값은 원시 cosine이다.
   * (이 테스트는 이전에 Atlas 원본 값인 `0.5`/`0.0`을 단언했다. 삭제하지 않고 환산 후 값으로 갱신했다.)
   *
   * 이 단언이 T-010 F-7의 마지막 방어선이다 — `vec_idx`의 `similarity`가 euclidean으로
   * 드리프트하면 정규화 식 자체가 달라져 "동일 1 / 직교 0 / 정반대 −1"이 깨진다.
   *
   * 직교 쪽은 특정 청크를 지목하지 않는다 — 직교 청크들의 점수가 전부 정확히 같아 Atlas가
   * 그중 어느 것을 후보로 올릴지는 정해져 있지 않다. 지목하면 간헐적으로 실패한다(실측).
   */
  it("동일 ≈1, 직교 ≈0, 정반대 ≈−1 — 원시 cosine 척도다", async () => {
    const identical = await retriever.retrieve({ query: KOREAN_PROSE_QUERY });
    // 장문 청크 0번이 질의 벡터와 같은 방향이다. Atlas 원본은 1.0이었다.
    expect(identical.maxVectorScore).toBeCloseTo(1, 2);

    const result = await retriever.retrieve({ query: LITERAL_QUERY, limit: 8 });

    // 질의 [0,0,1,0]과 x–y 평면에 있는 장문·짧은 사례 청크들은 전부 직교한다.
    const orthogonalRecords = new Set([R_LONG, ...R_SHORT].map((id) => id.toHexString()));
    const orthogonal = result.hits.filter((h) => orthogonalRecords.has(h.recordId));
    expect(orthogonal.length).toBeGreaterThan(0);
    for (const hit of orthogonal) {
      // Atlas 원본은 0.5였다.
      expect(hit.vectorScore).toBeCloseTo(0, 2);
    }

    // 반대쪽 끝: R_LITERAL의 벡터는 질의 벡터의 정반대다. Atlas 원본은 0.0이었다.
    const antipodal = result.hits.find((h) => h.recordId === R_LITERAL.toHexString());
    expect(antipodal?.vectorScore).toBeCloseTo(-1, 2);
  });

  /**
   * **`null`과 음수는 다른 것이다.** null은 "벡터 경로가 0건이라 판정 불가", 음수는
   * "벡터 경로가 일했고 아주 안 맞음"이다. T-018의 `SIMILARITY_THRESHOLD` 게이트는 이 둘을
   * 다른 분기로 다뤄야 하므로, 음수가 실제로 발생 가능하다는 것을 여기서 잠근다.
   * (환산이 없던 시절에는 이 값이 0.0이라 음수가 나올 수 없었다.)
   */
  it("정반대 벡터만 후보인 질의는 maxVectorScore가 음수다 — null이 아니다", async () => {
    const result = await retriever.retrieve({
      query: LITERAL_QUERY,
      project: ANTIPODAL_PROJECT,
    });

    expect(result.vectorCandidateCount).toBe(1);
    expect(result.maxVectorScore).not.toBeNull();
    expect(result.maxVectorScore).toBeLessThan(0);
    expect(result.maxVectorScore).toBeCloseTo(-1, 2);

    // 대조군: 벡터 경로가 0건이면 음수가 아니라 null이다.
    const none = await retriever.retrieve({ query: LITERAL_QUERY, project: "no-such-project" });
    expect(none.vectorCandidateCount).toBe(0);
    expect(none.maxVectorScore).toBeNull();
  });
});

/**
 * 검증 지적 2. `$search → $match → $limit` 순서를 **행동으로** 잠근다.
 *
 * `retrieve.spec.ts`의 스테이지 배열 단언은 모양만 본다 — 배열을 리팩터링하면 방어선이
 * 사라진다. 여기서는 `$limit`(= textK 4 × overfetch 4 = 16)이 실제로 바인딩되는 규모(22건)를
 * 넣고, 필터를 통과하는 소수(2건)를 BM25 하위에 둔다. 순서가 뒤집히면 상위 16건이 전부
 * 노이즈가 되어 필터 통과분이 **결과에서 사라진다**.
 */
describe.skipIf(!HAS_DOCKER)("$search → $match → $limit 순서 (재현율)", () => {
  const probeRetriever = (): Retriever =>
    createRetriever({
      db,
      embedder: { ...embedder, version: PROBE_EMBEDDING_VERSION },
      config: CONFIG,
    });

  it("필터 없이는 $limit이 실제로 바인딩된다 — 픽스처가 공허하지 않다", async () => {
    // 매칭 22건 > $limit 16. 이 단언이 깨지면 아래 테스트는 순서를 구별하지 못한다.
    expect(LIMIT_PROBE_NOISE_COUNT + LIMIT_PROBE_TARGET_COUNT).toBeGreaterThan(
      CONFIG.textK * CONFIG.candidateOverfetch,
    );

    const result = await probeRetriever().retrieve({ query: LIMIT_PROBE_TOKEN });

    expect(result.textCandidateCount).toBe(CONFIG.textK * CONFIG.candidateOverfetch);
  });

  it("필터를 통과하는 하위 소수가 $limit에 밀려 사라지지 않는다", async () => {
    const result = await probeRetriever().retrieve({
      query: LIMIT_PROBE_TOKEN,
      project: LIMIT_PROBE_TARGET_PROJECT,
    });

    // $limit이 $match 앞으로 가면 상위 16건이 전부 노이즈라 이 값이 0이 된다.
    expect(result.textCandidateCount).toBe(LIMIT_PROBE_TARGET_COUNT);
    expect(result.hits.map((h) => h.project)).toEqual(
      Array.from({ length: LIMIT_PROBE_TARGET_COUNT }, () => LIMIT_PROBE_TARGET_PROJECT),
    );
  });

  it("전제: 필터 통과분은 BM25 하위에 있다 — 상위였다면 순서를 구별하지 못한다", async () => {
    const unfiltered = await probeRetriever().retrieve({
      query: LIMIT_PROBE_TOKEN,
      limit: CONFIG.textK * CONFIG.candidateOverfetch,
    });

    const targets = new Set(LIMIT_PROBE_TARGET_IDS.map((id) => id.toHexString()));
    // $limit 16건 안에 타깃이 들어 있다면 순서를 뒤집어도 살아남는다 — 픽스처가 무의미해진다.
    expect(unfiltered.hits.filter((h) => targets.has(h.recordId))).toHaveLength(0);
  });
});

/**
 * Acceptance 3. 두 경로가 각각 언제 일을 하는지 실제 인덱스로 판정한다.
 */
describe.skipIf(!HAS_DOCKER)("경로별 기여 (Acceptance 3)", () => {
  /**
   * T-010 F-6: `lucene.standard`는 한국어 형태소 분석을 하지 않는다. "끊길까"·"응답이"가
   * 통째 토큰이라 어느 청크와도 매칭되지 않는다. **그래도 결과가 나와야 한다.**
   */
  it("한국어 서술형 쿼리는 텍스트 경로가 0건이고 벡터 경로만으로 답한다", async () => {
    const result = await retriever.retrieve({ query: KOREAN_PROSE_QUERY });

    expect(result.textCandidateCount).toBe(0);
    expect(result.vectorCandidateCount).toBeGreaterThan(0);
    expect(result.hits.length).toBeGreaterThan(0);
    expect(result.hits.every((h) => h.textRank === null)).toBe(true);
    expect(result.hits.every((h) => h.vectorRank !== null)).toBe(true);
  });

  /**
   * 반대쪽: 영문 식별자는 텍스트 경로가 잡는다. 이 청크의 벡터는 질의 벡터의 **정반대**라
   * (cosine −1) 벡터 후보 목록에 아예 들지 못한다. 그런데도 결과에 있고 벡터 2위 청크보다
   * 위에 온다면, 텍스트 경로가 순위를 실제로 바꿨다는 뜻이다 — 공허한 그린이 아니다.
   */
  it("식별자 쿼리는 벡터 경로가 못 내놓은 청크를 텍스트 경로가 끌어올린다", async () => {
    const result = await retriever.retrieve({ query: LITERAL_QUERY });
    const ids = result.hits.map((h) => h.recordId);

    expect(result.textCandidateCount).toBeGreaterThan(0);
    const literal = result.hits.find((h) => h.recordId === R_LITERAL.toHexString());
    expect(literal).toBeDefined();
    // 벡터 후보 목록에 없었다 — 순전히 텍스트 경로가 데려왔다.
    expect(literal?.vectorRank).toBeNull();
    expect(literal?.textRank).toBe(1);

    const vectorSecond = result.hits.find((h) => h.vectorRank === 2);
    expect(vectorSecond).toBeDefined();
    expect(ids.indexOf(R_LITERAL.toHexString())).toBeLessThan(
      ids.indexOf(vectorSecond?.recordId ?? ""),
    );
  });

  it("injection-suspect 청크는 결과에 남고 flags로 표시된다", async () => {
    const result = await retriever.retrieve({ query: LITERAL_QUERY });
    const suspect = result.hits.find((h) => h.recordId === R_LITERAL.toHexString());

    expect(suspect?.flags).toEqual(["injection-suspect"]);
  });

  it("hit에 record의 title·summary가 붙어 있다", async () => {
    const result = await retriever.retrieve({ query: KOREAN_PROSE_QUERY });

    expect(result.hits.length).toBeGreaterThan(0);
    for (const hit of result.hits) {
      expect(hit.title).toBe(`제목 ${hit.recordId}`);
      expect(hit.summary).toBe(`요약 ${hit.recordId}`);
      expect(hit.text.length).toBeGreaterThan(0);
    }
  });
});

/**
 * T-005 F-3. 장문 레코드 1건(청크 6개) + 짧은 레코드 여러 건을 넣고, 장문이 최종 결과를
 * 독점하지 않는지 본다. 후보 상한을 무력화한 대조군을 함께 돌려 **상한이 실제로 일한다**는
 * 것까지 보인다 — 그게 없으면 "원래 독점이 안 일어났을 뿐"과 구별되지 않는다.
 */
describe.skipIf(!HAS_DOCKER)("장문 레코드의 후보 슬롯 독점 (T-005 F-3)", () => {
  it("장문 레코드가 최종 결과를 독점하지 않는다", async () => {
    const result = await retriever.retrieve({ query: KOREAN_PROSE_QUERY });

    const longHits = result.hits.filter((h) => h.recordId === R_LONG.toHexString());
    expect(longHits).toHaveLength(CONFIG.maxChunksPerRecord);
    expect(new Set(result.hits.map((h) => h.recordId)).size).toBeGreaterThan(1);
  });

  it("대조군: 상한을 청크 수만큼 풀면 장문이 결과를 통째로 먹는다", async () => {
    const unbounded = createRetriever({
      db,
      embedder,
      config: { ...CONFIG, maxChunksPerRecord: LONG_CHUNKS.length },
    });

    const result = await unbounded.retrieve({ query: KOREAN_PROSE_QUERY });

    expect(new Set(result.hits.map((h) => h.recordId)).size).toBe(1);
    expect(result.hits[0]?.recordId).toBe(R_LONG.toHexString());
  });
});

/**
 * `vec_idx`의 filter 필드는 `meta.type`·`meta.project`·`embeddingVersion` 셋뿐이다.
 * 텍스트 경로는 `text_idx`에 그 필드들이 없어 `$match`로 같은 필터를 건다 — **두 경로가
 * 같은 결과를 걸러내는지**가 여기서 판정된다.
 */
describe.skipIf(!HAS_DOCKER)("필터", () => {
  it("project 필터가 두 경로 모두에서 걸린다", async () => {
    const mine = await retriever.retrieve({ query: LITERAL_QUERY, project: "sentinel-kb" });
    expect(mine.hits.map((h) => h.project)).not.toContain("bizcare-web");
    expect(mine.hits.every((h) => h.project === "sentinel-kb")).toBe(true);

    const other = await retriever.retrieve({ query: LITERAL_QUERY, project: "bizcare-web" });
    expect(other.hits.map((h) => h.recordId)).toEqual([R_OTHER_PROJECT.toHexString()]);

    const none = await retriever.retrieve({ query: LITERAL_QUERY, project: "no-such-project" });
    expect(none.hits).toEqual([]);
    expect(none.maxVectorScore).toBeNull();
  });

  it("type 필터가 두 경로 모두에서 걸린다", async () => {
    const divergences = await retriever.retrieve({ query: LITERAL_QUERY, type: "divergence" });
    expect(divergences.hits.map((h) => h.recordId)).toEqual([R_DIVERGENCE.toHexString()]);
    expect(divergences.hits.every((h) => h.type === "divergence")).toBe(true);

    const incidents = await retriever.retrieve({ query: LITERAL_QUERY, type: "incident" });
    expect(incidents.hits.every((h) => h.type === "incident")).toBe(true);
  });

  /**
   * specs/02 마이그레이션 규칙은 구·신 버전 청크의 **공존을 정상 상태**로 정의한다.
   * 이 필터가 빠지면 구버전 벡터가 신버전 질의 벡터와 섞여 점수가 무의미해진다.
   */
  it("embeddingVersion 필터가 구버전 청크를 걸러낸다", async () => {
    const current = await retriever.retrieve({ query: LITERAL_QUERY });
    expect(current.hits.map((h) => h.recordId)).not.toContain(R_STALE.toHexString());

    const stale = createRetriever({
      db,
      embedder: { ...embedder, version: STALE_EMBEDDING_VERSION },
      config: CONFIG,
    });
    const staleResult = await stale.retrieve({ query: LITERAL_QUERY });
    expect(staleResult.hits.map((h) => h.recordId)).toEqual([R_STALE.toHexString()]);
  });
});
