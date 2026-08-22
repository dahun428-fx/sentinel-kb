/**
 * T-006 Acceptance 1·2 + 순서 보존·재시도 경계.
 *
 * 기대값은 구현 상수(`MAX_EMBEDDING_BATCH_SIZE`, `DEFAULT_MAX_RETRIES`, 백오프 베이스)를
 * **참조하지 않고 리터럴로 박는다** — 테스트가 구현을 미러링하면 배치 32→16으로 바꿔도
 * 초록불이 유지되어 아무것도 검증하지 못한다. (T-004·T-005 교훈)
 *
 * 실제 API는 절대 부르지 않는다(specs/05 결정론 원칙). `fetch`와 `sleep`을 주입한다.
 */
import { describe, expect, it } from "vitest";

import { createEmbedder } from "./index.js";
import {
  EMBEDDER_ERROR_CODES,
  EmbedderError,
  type FetchLike,
  type HttpResponseLike,
} from "./types.js";

/** specs/03 §1-3이 정한 배치 상한. 구현에서 끌어오지 않는다. */
const EXPECTED_DEFAULT_BATCH = 32;

/** 테스트용 차원·버전. env가 소스임을 증명하려고 실제 모델값과 무관한 숫자를 쓴다. */
const DIM = 8;
const VERSION = 7;

const BASE_ENV: NodeJS.ProcessEnv = {
  EMBEDDING_PROVIDER: "voyage",
  EMBEDDING_MODEL: "model-from-env",
  EMBEDDING_DIM: String(DIM),
  EMBEDDING_VERSION: String(VERSION),
  VOYAGE_API_KEY: "key-from-env",
};

const TEXT_PREFIX = "text-";

function makeTexts(count: number): string[] {
  return Array.from({ length: count }, (_, i) => `${TEXT_PREFIX}${String(i)}`);
}

/** 텍스트 → 그 텍스트를 식별하는 마커 숫자. 순서 검증의 근거. */
function markerOf(text: string): number {
  return Number(text.slice(TEXT_PREFIX.length));
}

function markerVector(text: string, dim = DIM): number[] {
  const vector = new Array<number>(dim).fill(0);
  vector[0] = markerOf(text);
  return vector;
}

interface RequestBody {
  model: string;
  input: string[];
}

function response(status: number, payload: unknown): HttpResponseLike {
  return {
    ok: status >= 200 && status < 300,
    status,
    json: () => Promise.resolve(payload),
    text: () => Promise.resolve(JSON.stringify(payload)),
  };
}

interface PayloadOptions {
  readonly shuffle?: boolean;
  readonly dim?: number;
  readonly drop?: number;
}

function embeddingsPayload(input: string[], options: PayloadOptions = {}): unknown {
  const items = input.map((text, index) => ({
    object: "embedding",
    index,
    embedding: markerVector(text, options.dim ?? DIM),
  }));
  const kept = options.drop === undefined ? items : items.slice(0, items.length - options.drop);
  return {
    object: "list",
    data: options.shuffle === true ? [...kept].reverse() : kept,
    usage: { total_tokens: kept.length },
  };
}

type Responder = (input: string[], callIndex: number) => HttpResponseLike;

function mockFetch(responder: Responder): { calls: RequestBody[]; fetchImpl: FetchLike } {
  const calls: RequestBody[] = [];
  const fetchImpl: FetchLike = (_url, init) => {
    const body = JSON.parse(init.body) as RequestBody;
    calls.push(body);
    return Promise.resolve(responder(body.input, calls.length - 1));
  };
  return { calls, fetchImpl };
}

function recordingSleep(): { sleeps: number[]; sleep: (ms: number) => Promise<void> } {
  const sleeps: number[] = [];
  return {
    sleeps,
    sleep: (ms: number) => {
      sleeps.push(ms);
      return Promise.resolve();
    },
  };
}

const alwaysOk: Responder = (input) => response(200, embeddingsPayload(input));

describe("voyage embedder — 배치 분할", () => {
  it("100개 입력을 32개씩 4회로 나눠 호출한다 (Acceptance 1)", async () => {
    const { calls, fetchImpl } = mockFetch(alwaysOk);
    const { sleep } = recordingSleep();
    const embedder = createEmbedder({ env: BASE_ENV, fetch: fetchImpl, sleep });

    const vectors = await embedder.embed(makeTexts(100));

    expect(calls).toHaveLength(4);
    expect(calls.map((c) => c.input.length)).toEqual([32, 32, 32, 4]);
    expect(vectors).toHaveLength(100);
  });

  it("EMBEDDING_BATCH_SIZE가 배치 크기를 바꾼다", async () => {
    const { calls, fetchImpl } = mockFetch(alwaysOk);
    const embedder = createEmbedder({
      env: { ...BASE_ENV, EMBEDDING_BATCH_SIZE: "10" },
      fetch: fetchImpl,
      sleep: () => Promise.resolve(),
    });

    await embedder.embed(makeTexts(25));

    expect(calls.map((c) => c.input.length)).toEqual([10, 10, 5]);
  });

  it("상한 32를 넘는 EMBEDDING_BATCH_SIZE는 32로 눌린다 (specs/03 §1-3)", async () => {
    const { calls, fetchImpl } = mockFetch(alwaysOk);
    const embedder = createEmbedder({
      env: { ...BASE_ENV, EMBEDDING_BATCH_SIZE: "500" },
      fetch: fetchImpl,
      sleep: () => Promise.resolve(),
    });

    await embedder.embed(makeTexts(33));

    expect(calls.map((c) => c.input.length)).toEqual([EXPECTED_DEFAULT_BATCH, 1]);
  });

  it("빈 배열은 HTTP를 한 번도 태우지 않는다", async () => {
    const { calls, fetchImpl } = mockFetch(alwaysOk);
    const embedder = createEmbedder({ env: BASE_ENV, fetch: fetchImpl });

    await expect(embedder.embed([])).resolves.toEqual([]);
    expect(calls).toHaveLength(0);
  });
});

describe("voyage embedder — 순서 보존", () => {
  it("입력 i와 출력 i가 대응한다", async () => {
    const { fetchImpl } = mockFetch(alwaysOk);
    const embedder = createEmbedder({ env: BASE_ENV, fetch: fetchImpl });

    const vectors = await embedder.embed(makeTexts(100));

    // 마커가 0..99 순서 그대로여야 한다 — 배치 경계에서 섞이면 여기서 죽는다.
    expect(vectors.map((v) => v[0])).toEqual(Array.from({ length: 100 }, (_, i) => i));
  });

  it("응답 data가 뒤섞여 와도 index로 입력 순서를 복원한다", async () => {
    const { fetchImpl } = mockFetch((input) =>
      response(200, embeddingsPayload(input, { shuffle: true })),
    );
    const embedder = createEmbedder({ env: BASE_ENV, fetch: fetchImpl });

    const vectors = await embedder.embed(makeTexts(40));

    expect(vectors.map((v) => v[0])).toEqual(Array.from({ length: 40 }, (_, i) => i));
  });
});

describe("voyage embedder — 재시도", () => {
  it("429를 두 번 받고 세 번째에 성공한다 (Acceptance 2)", async () => {
    const { calls, fetchImpl } = mockFetch((input, callIndex) =>
      callIndex < 2
        ? response(429, { detail: "rate limited" })
        : response(200, embeddingsPayload(input)),
    );
    const { sleeps, sleep } = recordingSleep();
    const embedder = createEmbedder({ env: BASE_ENV, fetch: fetchImpl, sleep });

    const vectors = await embedder.embed(makeTexts(3));

    expect(calls).toHaveLength(3);
    expect(vectors.map((v) => v[0])).toEqual([0, 1, 2]);
    // 백오프가 지수적으로 늘어난다: 두 번째 대기는 첫 번째의 2배.
    expect(sleeps).toHaveLength(2);
    expect(sleeps[0]).toBeGreaterThan(0);
    expect(sleeps[1]).toBe((sleeps[0] ?? 0) * 2);
  });

  it("5xx도 재시도 대상이고, 3회를 모두 소진하면 RETRY_EXHAUSTED로 실패한다", async () => {
    const { calls, fetchImpl } = mockFetch(() => response(503, { detail: "unavailable" }));
    const { sleeps, sleep } = recordingSleep();
    const embedder = createEmbedder({ env: BASE_ENV, fetch: fetchImpl, sleep });

    const error = await embedder.embed(makeTexts(1)).catch((e: unknown) => e);

    expect(error).toBeInstanceOf(EmbedderError);
    expect((error as EmbedderError).code).toBe(EMBEDDER_ERROR_CODES.RETRY_EXHAUSTED);
    // 최초 1회 + 재시도 3회 = 4회 호출, 대기는 3회.
    expect(calls).toHaveLength(4);
    expect(sleeps).toHaveLength(3);
    expect(sleeps[1]).toBe((sleeps[0] ?? 0) * 2);
    expect(sleeps[2]).toBe((sleeps[1] ?? 0) * 2);
  });

  it("네트워크 예외도 재시도한 뒤 성공하면 정상 반환한다", async () => {
    let attempts = 0;
    const fetchImpl: FetchLike = (_url, init) => {
      attempts += 1;
      if (attempts === 1) return Promise.reject(new Error("ECONNRESET"));
      const body = JSON.parse(init.body) as RequestBody;
      return Promise.resolve(response(200, embeddingsPayload(body.input)));
    };
    const { sleeps, sleep } = recordingSleep();
    const embedder = createEmbedder({ env: BASE_ENV, fetch: fetchImpl, sleep });

    await expect(embedder.embed(makeTexts(1))).resolves.toHaveLength(1);
    expect(attempts).toBe(2);
    expect(sleeps).toHaveLength(1);
  });

  it("429가 아닌 4xx는 재시도하지 않는다", async () => {
    const { calls, fetchImpl } = mockFetch(() => response(401, { detail: "bad key" }));
    const { sleeps, sleep } = recordingSleep();
    const embedder = createEmbedder({ env: BASE_ENV, fetch: fetchImpl, sleep });

    const error = await embedder.embed(makeTexts(1)).catch((e: unknown) => e);

    expect(error).toBeInstanceOf(EmbedderError);
    expect((error as EmbedderError).code).toBe(EMBEDDER_ERROR_CODES.REQUEST_FAILED);
    expect(calls).toHaveLength(1);
    expect(sleeps).toHaveLength(0);
  });

  it("400도 재시도하지 않는다", async () => {
    const { calls, fetchImpl } = mockFetch(() => response(400, { detail: "bad request" }));
    const embedder = createEmbedder({
      env: BASE_ENV,
      fetch: fetchImpl,
      sleep: () => Promise.resolve(),
    });

    await expect(embedder.embed(makeTexts(1))).rejects.toThrow(EmbedderError);
    expect(calls).toHaveLength(1);
  });
});

describe("voyage embedder — 응답 검증과 env 주입", () => {
  it("모델명·차원·버전이 env에서 온다", async () => {
    const { calls, fetchImpl } = mockFetch(alwaysOk);
    const embedder = createEmbedder({ env: BASE_ENV, fetch: fetchImpl });

    const vectors = await embedder.embed(makeTexts(1));

    expect(embedder.dim).toBe(DIM);
    expect(embedder.version).toBe(VERSION);
    expect(calls[0]?.model).toBe("model-from-env");
    expect(vectors[0]).toHaveLength(DIM);
  });

  it("차원이 EMBEDDING_DIM과 다르면 RESPONSE_INVALID로 던진다", async () => {
    const { fetchImpl } = mockFetch((input) =>
      response(200, embeddingsPayload(input, { dim: DIM + 1 })),
    );
    const embedder = createEmbedder({ env: BASE_ENV, fetch: fetchImpl });

    const error = await embedder.embed(makeTexts(2)).catch((e: unknown) => e);

    expect((error as EmbedderError).code).toBe(EMBEDDER_ERROR_CODES.RESPONSE_INVALID);
  });

  it("임베딩 개수가 입력보다 적으면 RESPONSE_INVALID로 던진다", async () => {
    const { fetchImpl } = mockFetch((input) =>
      response(200, embeddingsPayload(input, { drop: 1 })),
    );
    const embedder = createEmbedder({ env: BASE_ENV, fetch: fetchImpl });

    const error = await embedder.embed(makeTexts(3)).catch((e: unknown) => e);

    expect((error as EmbedderError).code).toBe(EMBEDDER_ERROR_CODES.RESPONSE_INVALID);
  });

  it("API 키가 없으면 생성 시점에 실패하고 HTTP를 태우지 않는다", () => {
    const { calls, fetchImpl } = mockFetch(alwaysOk);
    const env = { ...BASE_ENV, VOYAGE_API_KEY: "" };

    expect(() => createEmbedder({ env, fetch: fetchImpl })).toThrow(EmbedderError);
    try {
      createEmbedder({ env, fetch: fetchImpl });
    } catch (error) {
      expect((error as EmbedderError).code).toBe(EMBEDDER_ERROR_CODES.API_KEY_MISSING);
    }
    expect(calls).toHaveLength(0);
  });

  it("EMBEDDING_MODEL이 없으면 생성 시점에 실패한다", () => {
    const env = { ...BASE_ENV, EMBEDDING_MODEL: "" };

    try {
      createEmbedder({ env });
      expect.unreachable("모델명 없이 embedder가 만들어지면 안 된다");
    } catch (error) {
      expect((error as EmbedderError).code).toBe(EMBEDDER_ERROR_CODES.MODEL_MISSING);
    }
  });
});

/**
 * T-006 MK 회귀. `parseVectors`의 다섯 검사(개수·index 범위·index 중복·차원·슬롯 미충족) 중
 * **범위·중복·미충족 셋이 서로를 가려주고 있었다** — 개별로 지우면 다른 검사가 대신 잡아
 * 뮤턴트가 죽지만, 범위와 미충족을 **함께** 지우면 35개 테스트가 전부 통과했다.
 *
 * 그때 실제로 벌어지는 일: 입력 3개에 `index`가 `(0,1,5)`로 오면
 * **길이 6에 구멍이 `undefined`로 박힌 배열이 에러 없이 반환된다.**
 * 정확히 "엉뚱한 텍스트에 엉뚱한 벡터가 붙어 조용히 저장되는" 실패 모드다.
 * 그래서 여기서는 개별 검사가 아니라 **불변식 자체**를 단언한다 —
 * 반환 배열은 입력과 길이가 같고 구멍이 없어야 한다.
 */
describe("voyage — 응답 슬롯 불변식 (T-006 MK)", () => {
  function payloadWithIndices(input: string[], indices: number[]): unknown {
    return {
      object: "list",
      data: input.map((text, i) => ({
        object: "embedding",
        index: indices[i] ?? i,
        embedding: markerVector(text),
      })),
      usage: { total_tokens: input.length },
    };
  }

  it.each([
    ["범위를 벗어난 index", [0, 1, 5]],
    ["음수 index", [0, 1, -1]],
    ["중복 index", [0, 1, 1]],
    ["소수 index", [0, 1, 1.5]],
  ])("%s 는 조용히 통과하지 않는다", async (_name, indices) => {
    const texts = makeTexts(3);
    const { fetchImpl } = mockFetch((input) => response(200, payloadWithIndices(input, indices)));
    const embedder = createEmbedder({ env: BASE_ENV, fetch: fetchImpl, sleep: () => Promise.resolve() });

    await expect(embedder.embed(texts)).rejects.toMatchObject({
      code: EMBEDDER_ERROR_CODES.RESPONSE_INVALID,
    });
  });

  it("성공 경로에서 반환 배열은 입력과 길이가 같고 구멍이 없다", async () => {
    // 검사들이 서로를 가려도 이 단언은 남는다 — 불변식을 직접 본다.
    const texts = makeTexts(70);
    const { fetchImpl } = mockFetch((input) => response(200, embeddingsPayload(input, { shuffle: true })));
    const embedder = createEmbedder({ env: BASE_ENV, fetch: fetchImpl, sleep: () => Promise.resolve() });

    const vectors = await embedder.embed(texts);

    expect(vectors).toHaveLength(texts.length);
    for (const [i, vector] of vectors.entries()) {
      expect(vector, `${String(i)}번 슬롯이 비었다`).toBeDefined();
      expect(vector).toHaveLength(DIM);
      expect(vector[0], `${String(i)}번 벡터가 다른 텍스트의 것이다`).toBe(i);
    }
  });
});
