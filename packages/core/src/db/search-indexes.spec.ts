/**
 * T-010 unit. 두 가지를 잠근다.
 *
 * 1. **정의 JSON이 specs/02 §인덱스와 문자 그대로 일치하는가.** 기대값을 구현 상수에서
 *    끌어오면 자기충족적이 되어(정의를 고치면 기대값도 따라 바뀜) 스펙 드리프트를 못 잡는다.
 *    그래서 파일을 fs로 직접 읽고 기대값은 **리터럴로** 박는다. (T-003·T-006 교훈)
 * 2. **컨테이너로는 잡히지 않는 로직.** atlas-local은 같은 이름의 검색 인덱스를 중복
 *    생성해도 조용히 성공한다(실측) — 즉 멱등 가드를 지워도 통합 테스트가 통과한다.
 *    여기서 드라이버 스텁으로 "이미 있으면 createSearchIndex를 부르지 않는다"를 직접 잠근다.
 */
import { readFileSync } from "node:fs";

import type { Document } from "mongodb";
import { describe, expect, it, vi } from "vitest";

import { readEmbeddingDim } from "../embedder/config.js";

import {
  buildSearchIndexPlans,
  DEFAULT_SEARCH_INDEX_POLL_INTERVAL_MS,
  DEFAULT_SEARCH_INDEX_READY_TIMEOUT_MS,
  EMBEDDING_DIM_PLACEHOLDER,
  ensureSearchIndexes,
  loadSearchIndexDefinitions,
  readSearchIndexWaitConfig,
  readVectorNumDimensions,
  SEARCH_INDEX_DEFINITION_FILES,
  SearchIndexError,
  waitForSearchIndexesReady,
  type SearchIndexCollectionLike,
  type SearchIndexDbLike,
  type SearchIndexPlan,
  type SearchIndexType,
} from "./search-indexes.js";

/** 테스트 전용 차원. 실제 모델 차원(1024 등)을 쓰지 않는다 — env가 소스임을 흐리지 않기 위해. */
const TEST_DIM = 7;

function readDefinitionJson(file: string): Record<string, unknown> {
  const url = new URL(`./search-indexes/${file}`, import.meta.url);
  return JSON.parse(readFileSync(url, "utf8")) as Record<string, unknown>;
}

describe("정의는 코드가 아니라 JSON 파일에 있다 (Acceptance 2)", () => {
  it("두 정의 파일이 실재하고 파싱된다", () => {
    // 파일을 못 읽으면 아래 단언들이 공허하게 통과한다 — 먼저 실재를 확인한다.
    expect([...SEARCH_INDEX_DEFINITION_FILES]).toEqual(["vec_idx.json", "text_idx.json"]);
    for (const file of SEARCH_INDEX_DEFINITION_FILES) {
      expect(Object.keys(readDefinitionJson(file)).length, `${file}이 비어 있다`).toBeGreaterThan(0);
    }
  });

  /**
   * specs/02 §인덱스:
   *   chunks: Atlas Vector Search `vec_idx` — path embedding, cosine, dim=EMBEDDING_DIM,
   *   filter 필드: meta.type, meta.project, embeddingVersion
   *
   * 그리고 skills/mongo-vector-ops: "필터로 쓸 필드는 반드시 인덱스에 filter로 선언해야 한다.
   * 빠뜨리면 필터가 무시되는 게 아니라 쿼리가 실패한다." 세 개 전부가 여기 잠긴다.
   */
  it("vec_idx.json이 specs/02와 문자 그대로 일치한다", () => {
    expect(readDefinitionJson("vec_idx.json")).toMatchObject({
      name: "vec_idx",
      collection: "chunks",
      type: "vectorSearch",
      definition: {
        fields: [
          {
            type: "vector",
            path: "embedding",
            numDimensions: "${EMBEDDING_DIM}",
            similarity: "cosine",
          },
          { type: "filter", path: "meta.type" },
          { type: "filter", path: "meta.project" },
          { type: "filter", path: "embeddingVersion" },
        ],
      },
    });
  });

  it("vec_idx.json의 filter 선언이 정확히 3개다", () => {
    // toMatchObject는 배열 길이는 보지만, 순서가 바뀌거나 하나가 더 붙는 변형을
    // 따로 잠가 둔다 — 필터 누락은 쿼리 실패로만 드러나는 종류의 결함이다.
    const definition = readDefinitionJson("vec_idx.json")["definition"] as Document;
    const fields = definition["fields"] as { type: string; path: string }[];
    expect(fields.filter((f) => f.type === "filter").map((f) => f.path)).toEqual([
      "meta.type",
      "meta.project",
      "embeddingVersion",
    ]);
    expect(fields.filter((f) => f.type === "vector")).toHaveLength(1);
  });

  /** specs/02 §인덱스: chunks: Atlas Search `text_idx` — path text (lucene.standard) */
  it("text_idx.json이 specs/02와 문자 그대로 일치한다", () => {
    expect(readDefinitionJson("text_idx.json")).toMatchObject({
      name: "text_idx",
      collection: "chunks",
      type: "search",
      definition: {
        mappings: {
          dynamic: false,
          fields: { text: { type: "string", analyzer: "lucene.standard" } },
        },
      },
    });
  });

  it("JSON에는 실제 차원이 하드코딩되어 있지 않다 (NFR-06)", () => {
    const raw = readFileSync(new URL("./search-indexes/vec_idx.json", import.meta.url), "utf8");
    expect(raw).toContain(EMBEDDING_DIM_PLACEHOLDER);
    // 흔한 임베딩 차원이 리터럴로 박히면 env가 소스가 아니게 된다.
    for (const dim of [256, 384, 512, 768, 1024, 1536, 3072]) {
      expect(raw).not.toContain(`"numDimensions": ${dim}`);
    }
  });

  it("loadSearchIndexDefinitions는 placeholder를 치환하지 않은 원본을 준다", () => {
    const vec = loadSearchIndexDefinitions().find((d) => d.name === "vec_idx");
    const fields = vec?.definition["fields"] as { numDimensions?: unknown }[];
    expect(fields[0]?.numDimensions).toBe(EMBEDDING_DIM_PLACEHOLDER);
  });
});

describe("buildSearchIndexPlans", () => {
  it("EMBEDDING_DIM을 placeholder 자리에 주입한다", () => {
    const plans = buildSearchIndexPlans(TEST_DIM);
    const vec = plans.find((p) => p.name === "vec_idx");
    expect(readVectorNumDimensions(vec?.definition ?? {})).toBe(TEST_DIM);
  });

  it("치환해도 filter 선언과 similarity는 그대로 남는다", () => {
    const vec = buildSearchIndexPlans(TEST_DIM).find((p) => p.name === "vec_idx");
    expect(vec?.definition["fields"]).toEqual([
      { type: "vector", path: "embedding", numDimensions: TEST_DIM, similarity: "cosine" },
      { type: "filter", path: "meta.type" },
      { type: "filter", path: "meta.project" },
      { type: "filter", path: "embeddingVersion" },
    ]);
  });

  it("text_idx는 치환 대상이 없어 그대로 통과한다", () => {
    const text = buildSearchIndexPlans(TEST_DIM).find((p) => p.name === "text_idx");
    expect(text?.type).toBe("search");
    expect(text?.definition).toEqual({
      mappings: {
        dynamic: false,
        fields: { text: { type: "string", analyzer: "lucene.standard" } },
      },
    });
  });

  it("원본 정의를 변형하지 않는다(깊은 복사)", () => {
    buildSearchIndexPlans(TEST_DIM);
    const fields = loadSearchIndexDefinitions()[0]?.definition["fields"] as {
      numDimensions?: unknown;
    }[];
    expect(fields[0]?.numDimensions).toBe(EMBEDDING_DIM_PLACEHOLDER);
  });
});

/* ------------------------------------------------------------------ *
 * 드라이버 스텁 — 컨테이너 없이 로직만 잠근다
 * ------------------------------------------------------------------ */

interface StubIndex {
  name: string;
  status?: string;
  queryable?: boolean;
  latestDefinition?: Document;
}

interface StubDb extends SearchIndexDbLike {
  readonly created: { name: string; type: SearchIndexType; definition: Document }[];
  readonly createdCollections: string[];
}

function createStubDb(existing: StubIndex[], options: { collections?: string[] } = {}): StubDb {
  const created: { name: string; type: SearchIndexType; definition: Document }[] = [];
  const createdCollections: string[] = [];
  const collections = new Set(options.collections ?? ["chunks"]);
  const indexes = [...existing];

  const collection: SearchIndexCollectionLike = {
    listSearchIndexes: (name?: string) => ({
      toArray: async () =>
        indexes.filter((i) => name === undefined || i.name === name) as unknown as Document[],
    }),
    createSearchIndex: async (description) => {
      created.push(description);
      indexes.push({
        name: description.name,
        status: "PENDING",
        queryable: false,
        latestDefinition: description.definition,
      });
      return description.name;
    },
  };

  return {
    created,
    createdCollections,
    listCollections: (filter: Document) => ({
      toArray: async () => {
        const name = filter["name"];
        return typeof name === "string" && collections.has(name) ? [{ name }] : [];
      },
    }),
    createCollection: async (name: string) => {
      createdCollections.push(name);
      collections.add(name);
      return undefined;
    },
    collection: () => collection,
  };
}

describe("ensureSearchIndexes (Acceptance 1: 멱등)", () => {
  it("아무것도 없으면 두 인덱스를 만든다", async () => {
    const db = createStubDb([]);
    const results = await ensureSearchIndexes(db, { dim: TEST_DIM });

    expect(results.map((r) => [r.name, r.action])).toEqual([
      ["vec_idx", "created"],
      ["text_idx", "created"],
    ]);
    expect(db.created.map((c) => c.name)).toEqual(["vec_idx", "text_idx"]);
  });

  /**
   * **핵심 가드.** 실 Atlas의 `createSearchIndex`는 같은 이름이 있으면 `IndexAlreadyExists`로
   * 죽는다. atlas-local 컨테이너는 그걸 조용히 삼키므로 통합 테스트로는 이 가드의 부재를
   * 잡을 수 없다 — 여기가 유일한 잠금 지점이다.
   */
  it("이미 있으면 createSearchIndex를 부르지 않는다", async () => {
    const db = createStubDb([
      {
        name: "vec_idx",
        status: "READY",
        queryable: true,
        latestDefinition: {
          fields: [{ type: "vector", path: "embedding", numDimensions: TEST_DIM }],
        },
      },
      { name: "text_idx", status: "READY", queryable: true, latestDefinition: {} },
    ]);

    const results = await ensureSearchIndexes(db, { dim: TEST_DIM });

    expect(results.map((r) => r.action)).toEqual(["existing", "existing"]);
    expect(db.created).toEqual([]);
  });

  it("2회 연속 실행해도 생성은 첫 회에 한 번뿐이다", async () => {
    const db = createStubDb([]);
    await ensureSearchIndexes(db, { dim: TEST_DIM });
    const second = await ensureSearchIndexes(db, { dim: TEST_DIM });

    expect(second.map((r) => r.action)).toEqual(["existing", "existing"]);
    expect(db.created).toHaveLength(2);
  });

  it("컬렉션이 없으면 만든다 (createSearchIndex는 NamespaceNotFound로 죽는다)", async () => {
    const db = createStubDb([], { collections: [] });
    await ensureSearchIndexes(db, { dim: TEST_DIM });
    expect(db.createdCollections).toContain("chunks");
  });

  it("컬렉션이 이미 있으면 만들지 않는다", async () => {
    const db = createStubDb([], { collections: ["chunks"] });
    await ensureSearchIndexes(db, { dim: TEST_DIM });
    expect(db.createdCollections).toEqual([]);
  });

  it("dim을 안 주면 EMBEDDING_DIM에서 읽는다", async () => {
    vi.stubEnv("EMBEDDING_DIM", String(TEST_DIM));
    try {
      const db = createStubDb([]);
      await ensureSearchIndexes(db);
      expect(readVectorNumDimensions(db.created[0]?.definition ?? {})).toBe(TEST_DIM);
    } finally {
      vi.unstubAllEnvs();
    }
  });

  it("EMBEDDING_DIM이 없으면 EMBEDDER_DIM_INVALID로 실패한다", async () => {
    vi.stubEnv("EMBEDDING_DIM", "");
    try {
      await expect(ensureSearchIndexes(createStubDb([]))).rejects.toMatchObject({
        code: "EMBEDDER_DIM_INVALID",
      });
    } finally {
      vi.unstubAllEnvs();
    }
  });

  /**
   * **T-010 검증 C3(생존 뮤테이션)을 막는 테스트.**
   *
   * `readEmbeddingDim`은 `readEmbedderConfig`와 같은 파서를 공유한다고 선언돼 있다(config.ts).
   * 그런데 그 위임을 끊고 인덱스 경로만 관대한 `parseInt`로 바꿔도 lint·typecheck·unit 702개가
   * **전부 통과했다** — 주장은 참이었지만 무방비였다. 그러면 `EMBEDDING_DIM="1536abc"`가
   * 인덱스는 1536으로 만들고 embedder는 설정 오류로 거부하는, **차원 대조가 무의미해지는
   * 정확히 그 상태**가 조용히 성립한다(T-006 F-4가 T-010에 넘긴 문제의 핵심).
   *
   * 그래서 여기서 두 가지를 함께 잠근다: (a) 인덱스 경로가 오형식 dim을 거부하는가,
   * (b) 두 경로가 **같은 입력에 같은 판정**을 내리는가.
   */
  describe("오형식 EMBEDDING_DIM은 두 경로가 똑같이 거부한다", () => {
    const MALFORMED = ["1536abc", "1.5", "0", "-8", "abc", " "];

    it.each(MALFORMED)("인덱스 경로가 %j를 거부한다", async (raw) => {
      vi.stubEnv("EMBEDDING_DIM", raw);
      try {
        await expect(ensureSearchIndexes(createStubDb([]))).rejects.toMatchObject({
          code: "EMBEDDER_DIM_INVALID",
        });
      } finally {
        vi.unstubAllEnvs();
      }
    });

    it.each(MALFORMED)("embedder 경로도 %j를 거부한다 — 판정이 갈리지 않는다", (raw) => {
      expect(() => readEmbeddingDim({ EMBEDDING_DIM: raw })).toThrowError(
        expect.objectContaining({ code: "EMBEDDER_DIM_INVALID" }) as Error,
      );
    });
  });

  it("EMBEDDING_PROVIDER·EMBEDDING_VERSION 없이도 돈다 (T-006 F-4)", async () => {
    // 인덱스 부트스트랩은 임베딩 자격증명 없는 환경에서도 돌아야 한다.
    vi.stubEnv("EMBEDDING_DIM", String(TEST_DIM));
    vi.stubEnv("EMBEDDING_PROVIDER", "");
    vi.stubEnv("EMBEDDING_VERSION", "");
    try {
      await expect(ensureSearchIndexes(createStubDb([]))).resolves.toHaveLength(2);
    } finally {
      vi.unstubAllEnvs();
    }
  });
});

describe("ensureSearchIndexes: dim 대조 (Acceptance 2 후반)", () => {
  it("기존 vec_idx의 numDimensions가 다르면 DIM_MISMATCH로 실패한다", async () => {
    const db = createStubDb([
      {
        name: "vec_idx",
        status: "READY",
        latestDefinition: {
          fields: [{ type: "vector", path: "embedding", numDimensions: TEST_DIM + 1 }],
        },
      },
    ]);

    await expect(ensureSearchIndexes(db, { dim: TEST_DIM })).rejects.toMatchObject({
      code: "SEARCH_INDEX_DIM_MISMATCH",
    });
  });

  it("불일치를 만나면 조용히 재생성하지 않는다", async () => {
    // 자동 재생성은 구버전 청크를 통째로 검색 불가로 만든다 (specs/02 §마이그레이션 규칙).
    const db = createStubDb([
      {
        name: "vec_idx",
        latestDefinition: {
          fields: [{ type: "vector", path: "embedding", numDimensions: TEST_DIM + 1 }],
        },
      },
    ]);

    await expect(ensureSearchIndexes(db, { dim: TEST_DIM })).rejects.toThrow(SearchIndexError);
    expect(db.created).toEqual([]);
  });

  it("에러 메시지가 마이그레이션 절차를 가리킨다", async () => {
    const db = createStubDb([
      {
        name: "vec_idx",
        latestDefinition: { fields: [{ type: "vector", path: "embedding", numDimensions: 3 }] },
      },
    ]);

    await expect(ensureSearchIndexes(db, { dim: TEST_DIM })).rejects.toThrow(/EMBEDDING_VERSION/);
  });

  it("기존 정의에서 numDimensions를 못 읽어도 통과시키지 않는다", async () => {
    const db = createStubDb([{ name: "vec_idx", latestDefinition: {} }]);
    await expect(ensureSearchIndexes(db, { dim: TEST_DIM })).rejects.toMatchObject({
      code: "SEARCH_INDEX_DIM_MISMATCH",
    });
  });

  it("text_idx는 dim 대조 대상이 아니다", async () => {
    const db = createStubDb([{ name: "text_idx", latestDefinition: {} }]);
    const results = await ensureSearchIndexes(db, { dim: TEST_DIM });
    expect(results.find((r) => r.name === "text_idx")?.action).toBe("existing");
  });
});

describe("waitForSearchIndexesReady", () => {
  const plans: SearchIndexPlan[] = [
    { name: "vec_idx", collection: "chunks", type: "vectorSearch", definition: {} },
  ];

  it("전부 READY면 즉시 반환한다", async () => {
    const db = createStubDb([{ name: "vec_idx", status: "READY", queryable: true }]);
    await expect(
      waitForSearchIndexesReady(db, plans, { pollIntervalMs: 1, readyTimeoutMs: 100 }),
    ).resolves.toBeUndefined();
  });

  it("PENDING이면 기다렸다가 READY가 되면 반환한다", async () => {
    const index: StubIndex = { name: "vec_idx", status: "PENDING", queryable: false };
    const db = createStubDb([index]);
    let slept = 0;

    await waitForSearchIndexesReady(db, plans, {
      pollIntervalMs: 1,
      readyTimeoutMs: 1000,
      sleep: async () => {
        slept += 1;
        if (slept >= 2) {
          index.status = "READY";
          index.queryable = true;
        }
      },
    });

    expect(slept).toBe(2);
  });

  it("타임아웃이면 NOT_READY로 실패한다", async () => {
    const db = createStubDb([{ name: "vec_idx", status: "PENDING", queryable: false }]);
    let clock = 0;

    await expect(
      waitForSearchIndexesReady(db, plans, {
        pollIntervalMs: 1,
        readyTimeoutMs: 10,
        sleep: async () => {
          clock += 5;
        },
        now: () => clock,
      }),
    ).rejects.toMatchObject({ code: "SEARCH_INDEX_NOT_READY" });
  });

  it("FAILED면 기다리지 않고 BUILD_FAILED로 실패한다", async () => {
    const db = createStubDb([{ name: "vec_idx", status: "FAILED" }]);
    await expect(
      waitForSearchIndexesReady(db, plans, { pollIntervalMs: 1, readyTimeoutMs: 1000 }),
    ).rejects.toMatchObject({ code: "SEARCH_INDEX_BUILD_FAILED" });
  });

  it("status가 READY여도 queryable:false면 기다린다", async () => {
    // READY지만 아직 못 쓰는 창이 있다 — 여기서 통과시키면 뒤따르는 쿼리가 죽는다.
    const db = createStubDb([{ name: "vec_idx", status: "READY", queryable: false }]);
    let clock = 0;
    await expect(
      waitForSearchIndexesReady(db, plans, {
        pollIntervalMs: 1,
        readyTimeoutMs: 5,
        sleep: async () => {
          clock += 10;
        },
        now: () => clock,
      }),
    ).rejects.toMatchObject({ code: "SEARCH_INDEX_NOT_READY" });
  });

  it("인덱스가 아예 없으면 READY로 치지 않는다", async () => {
    const db = createStubDb([]);
    let clock = 0;
    await expect(
      waitForSearchIndexesReady(db, plans, {
        pollIntervalMs: 1,
        readyTimeoutMs: 5,
        sleep: async () => {
          clock += 10;
        },
        now: () => clock,
      }),
    ).rejects.toThrow(/없음/);
  });
});

describe("readSearchIndexWaitConfig (specs/03 §6)", () => {
  it("미설정이면 기본값", () => {
    expect(readSearchIndexWaitConfig({})).toEqual({
      readyTimeoutMs: DEFAULT_SEARCH_INDEX_READY_TIMEOUT_MS,
      pollIntervalMs: DEFAULT_SEARCH_INDEX_POLL_INTERVAL_MS,
    });
  });

  it("env 값을 읽는다", () => {
    expect(
      readSearchIndexWaitConfig({
        SEARCH_INDEX_READY_TIMEOUT_MS: "1234",
        SEARCH_INDEX_POLL_INTERVAL_MS: "56",
      }),
    ).toEqual({ readyTimeoutMs: 1234, pollIntervalMs: 56 });
  });

  it("0·음수·비수치는 기본값으로 되돌린다", () => {
    // 오설정이 폴링을 0으로 만들어 대기를 무력화하면 안 된다.
    for (const bad of ["0", "-1", "abc", "  "]) {
      expect(
        readSearchIndexWaitConfig({
          SEARCH_INDEX_READY_TIMEOUT_MS: bad,
          SEARCH_INDEX_POLL_INTERVAL_MS: bad,
        }),
      ).toEqual({
        readyTimeoutMs: DEFAULT_SEARCH_INDEX_READY_TIMEOUT_MS,
        pollIntervalMs: DEFAULT_SEARCH_INDEX_POLL_INTERVAL_MS,
      });
    }
  });

  it("기본 타임아웃이 기본 폴링 간격보다 충분히 크다", () => {
    expect(DEFAULT_SEARCH_INDEX_READY_TIMEOUT_MS).toBeGreaterThan(
      DEFAULT_SEARCH_INDEX_POLL_INTERVAL_MS * 10,
    );
  });
});
