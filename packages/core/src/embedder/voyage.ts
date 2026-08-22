/**
 * HTTP 임베딩 provider. 출처: specs/03-rag-pipeline.md §1-3, T-006 Scope.
 *
 * SDK를 붙이지 않고 `fetch`로 직접 호출한다 — 의존성 하나를 아끼려는 게 아니라,
 * provider 교체(NFR-06)가 SDK 버전 문제로 막히지 않게 하려는 것이다.
 * CLAUDE.md의 "LLM 호출은 llm/ 경유"와 충돌하지 않는다: **임베딩은 `embedder`
 * 인터페이스 경유**가 규칙이고, 이 파일이 그 인터페이스의 유일한 HTTP 구현이다.
 *
 * 모델명·차원은 이 파일 어디에도 리터럴로 존재하지 않는다(T-006 Acceptance 3).
 * 전부 호출자가 env에서 읽어 주입한다.
 */
import {
  EMBEDDER_ERROR_CODES,
  EmbedderError,
  realSleep,
  type Embedder,
  type FetchLike,
  type HttpResponseLike,
  type SleepFn,
} from "./types.js";

/** provider의 고정 엔드포인트. 모델·차원과 달리 튜닝 대상이 아니다. */
const EMBEDDINGS_ENDPOINT = "https://api.voyageai.com/v1/embeddings";

/** 429/5xx 재시도 횟수. specs/03·T-006 Scope "지수백오프 재시도 3회". */
const DEFAULT_MAX_RETRIES = 3;

/** 첫 재시도까지의 대기(ms). 이후 매 시도마다 두 배로 늘어난다. */
const DEFAULT_BACKOFF_BASE_MS = 200;

/** 지수백오프 배수. */
const BACKOFF_FACTOR = 2;

/** 에러 메시지에 싣는 응답 본문 길이 상한 — 로그를 응답 전문으로 채우지 않는다. */
const ERROR_BODY_MAX_CHARS = 200;

export interface VoyageCredentials {
  readonly model: string;
  readonly apiKey: string;
}

/**
 * provider 자격증명을 env에서 읽는다. 키가 없으면 **생성 시점에** 실패시켜
 * 첫 임베딩 잡이 돌 때까지 문제를 숨기지 않는다.
 */
export function readVoyageCredentials(env: NodeJS.ProcessEnv = process.env): VoyageCredentials {
  const model = env["EMBEDDING_MODEL"]?.trim();
  if (!model) {
    throw new EmbedderError(
      EMBEDDER_ERROR_CODES.MODEL_MISSING,
      "EMBEDDING_MODEL이 설정되지 않았다. 모델명은 코드가 아니라 env가 소스다(NFR-06). .env.example 참고.",
    );
  }

  const apiKey = env["VOYAGE_API_KEY"]?.trim();
  if (!apiKey) {
    throw new EmbedderError(
      EMBEDDER_ERROR_CODES.API_KEY_MISSING,
      "VOYAGE_API_KEY가 설정되지 않았다. 시크릿 하드코딩 금지 — SSM/.env로 주입하라.",
    );
  }

  return { model, apiKey };
}

export interface VoyageEmbedderOptions {
  readonly model: string;
  readonly apiKey: string;
  readonly dim: number;
  readonly version: number;
  readonly batchSize: number;
  /** 테스트가 HTTP를 대체하는 지점(specs/05 결정론 원칙). 기본은 `globalThis.fetch`. */
  readonly fetch?: FetchLike;
  /** 테스트가 백오프 대기를 즉시 resolve로 바꾸는 지점. 기본은 실제 타이머. */
  readonly sleep?: SleepFn;
  readonly maxRetries?: number;
  readonly backoffBaseMs?: number;
}

const defaultFetch: FetchLike = (url, init) => globalThis.fetch(url, init);

export function createVoyageEmbedder(options: VoyageEmbedderOptions): Embedder {
  const { model, apiKey, dim, version, batchSize } = options;
  if (!apiKey) {
    throw new EmbedderError(
      EMBEDDER_ERROR_CODES.API_KEY_MISSING,
      "VOYAGE_API_KEY가 비어 있다 — embedder를 만들 수 없다.",
    );
  }
  if (!model) {
    throw new EmbedderError(
      EMBEDDER_ERROR_CODES.MODEL_MISSING,
      "EMBEDDING_MODEL이 비어 있다 — embedder를 만들 수 없다.",
    );
  }

  const doFetch = options.fetch ?? defaultFetch;
  const sleep = options.sleep ?? realSleep;
  const maxRetries = options.maxRetries ?? DEFAULT_MAX_RETRIES;
  const backoffBaseMs = options.backoffBaseMs ?? DEFAULT_BACKOFF_BASE_MS;

  async function requestBatch(batch: string[]): Promise<number[][]> {
    let attempt = 0;
    for (;;) {
      const outcome = await attemptBatch(batch);
      if (outcome.kind === "ok") return outcome.vectors;
      if (attempt >= maxRetries) {
        throw new EmbedderError(
          EMBEDDER_ERROR_CODES.RETRY_EXHAUSTED,
          `임베딩 요청이 재시도 ${String(maxRetries)}회를 모두 소진했다: ${outcome.reason}`,
          outcome.cause,
        );
      }
      await sleep(backoffBaseMs * BACKOFF_FACTOR ** attempt);
      attempt += 1;
    }
  }

  type Attempt =
    { kind: "ok"; vectors: number[][] } | { kind: "retry"; reason: string; cause?: unknown };

  async function attemptBatch(batch: string[]): Promise<Attempt> {
    let response: HttpResponseLike;
    try {
      response = await doFetch(EMBEDDINGS_ENDPOINT, {
        method: "POST",
        headers: {
          "content-type": "application/json",
          authorization: `Bearer ${apiKey}`,
        },
        body: JSON.stringify({ model, input: batch }),
      });
    } catch (cause) {
      // 네트워크 자체가 실패한 경우 — 일시 장애로 보고 백오프 재시도 대상에 넣는다.
      return { kind: "retry", reason: `네트워크 오류: ${describe(cause)}`, cause };
    }

    if (response.ok) {
      return { kind: "ok", vectors: await parseVectors(response, batch.length, dim) };
    }

    // 429는 레이트리밋(기다리면 풀린다), 5xx는 서버 일시 장애 — 둘만 재시도한다.
    // 그 밖의 4xx(인증 실패·잘못된 요청)는 몇 번을 더 보내도 같은 응답이라 즉시 던진다.
    const retryable = response.status === 429 || response.status >= 500;
    const body = await readBodySafely(response);
    if (!retryable) {
      throw new EmbedderError(
        EMBEDDER_ERROR_CODES.REQUEST_FAILED,
        `임베딩 요청이 거부됐다(status=${String(response.status)}, 재시도 불가): ${body}`,
      );
    }
    return { kind: "retry", reason: `status=${String(response.status)} ${body}` };
  }

  return {
    dim,
    version,
    async embed(texts: string[]): Promise<number[][]> {
      // 빈 입력에 HTTP를 태우지 않는다 — 워커가 빈 섹션만 있는 record를 물고 왔을 때의 정상 경로다.
      if (texts.length === 0) return [];

      // 배치를 **순차** 처리하고 결과를 이어붙인다. 병렬로 쪼개면 레이트리밋을 더 자주 때리고,
      // 무엇보다 `texts[i]` ↔ 반환값 `[i]` 대응이 흐트러질 여지가 생긴다.
      const vectors: number[][] = [];
      for (let start = 0; start < texts.length; start += batchSize) {
        vectors.push(...(await requestBatch(texts.slice(start, start + batchSize))));
      }
      return vectors;
    },
  };
}

/**
 * 응답을 입력 순서로 되돌린다. provider는 `data[]`에 `index`를 실어 보내며 그 순서를
 * 보장하지 않는다 — 배열 순서를 그대로 믿으면 텍스트와 벡터가 어긋난 채 저장된다.
 */
async function parseVectors(
  response: HttpResponseLike,
  expected: number,
  dim: number,
): Promise<number[][]> {
  let payload: unknown;
  try {
    payload = await response.json();
  } catch (cause) {
    throw new EmbedderError(
      EMBEDDER_ERROR_CODES.RESPONSE_INVALID,
      `임베딩 응답을 JSON으로 읽지 못했다: ${describe(cause)}`,
      cause,
    );
  }

  const data = readDataArray(payload);
  if (data.length !== expected) {
    throw new EmbedderError(
      EMBEDDER_ERROR_CODES.RESPONSE_INVALID,
      `임베딩 개수가 입력과 다르다(입력 ${String(expected)}, 응답 ${String(data.length)}).`,
    );
  }

  const slots: (number[] | undefined)[] = new Array<number[] | undefined>(expected).fill(undefined);
  for (const item of data) {
    const { index, embedding } = readItem(item, dim);
    if (!Number.isInteger(index) || index < 0 || index >= expected) {
      throw new EmbedderError(
        EMBEDDER_ERROR_CODES.RESPONSE_INVALID,
        `임베딩 index가 범위를 벗어났다: ${String(index)}`,
      );
    }
    if (slots[index] !== undefined) {
      throw new EmbedderError(
        EMBEDDER_ERROR_CODES.RESPONSE_INVALID,
        `임베딩 index가 중복됐다: ${String(index)}`,
      );
    }
    slots[index] = embedding;
  }

  return slots.map((vector, index) => {
    if (vector === undefined) {
      throw new EmbedderError(
        EMBEDDER_ERROR_CODES.RESPONSE_INVALID,
        `입력 ${String(index)}번에 대응하는 임베딩이 응답에 없다.`,
      );
    }
    return vector;
  });
}

function readDataArray(payload: unknown): unknown[] {
  if (typeof payload !== "object" || payload === null || !("data" in payload)) {
    throw new EmbedderError(
      EMBEDDER_ERROR_CODES.RESPONSE_INVALID,
      "임베딩 응답에 data 배열이 없다.",
    );
  }
  const { data } = payload as { data: unknown };
  if (!Array.isArray(data)) {
    throw new EmbedderError(
      EMBEDDER_ERROR_CODES.RESPONSE_INVALID,
      "임베딩 응답의 data가 배열이 아니다.",
    );
  }
  return data;
}

function readItem(item: unknown, dim: number): { index: number; embedding: number[] } {
  if (typeof item !== "object" || item === null) {
    throw new EmbedderError(
      EMBEDDER_ERROR_CODES.RESPONSE_INVALID,
      "임베딩 응답 항목이 객체가 아니다.",
    );
  }
  const { index, embedding } = item as { index?: unknown; embedding?: unknown };
  if (typeof index !== "number") {
    throw new EmbedderError(
      EMBEDDER_ERROR_CODES.RESPONSE_INVALID,
      "임베딩 응답 항목에 숫자 index가 없다 — 입력 순서를 복원할 수 없다.",
    );
  }
  if (
    !Array.isArray(embedding) ||
    !embedding.every((v) => typeof v === "number" && Number.isFinite(v))
  ) {
    throw new EmbedderError(
      EMBEDDER_ERROR_CODES.RESPONSE_INVALID,
      `임베딩 ${String(index)}이(가) 유한 숫자 배열이 아니다.`,
    );
  }
  if (embedding.length !== dim) {
    throw new EmbedderError(
      EMBEDDER_ERROR_CODES.RESPONSE_INVALID,
      `임베딩 차원이 EMBEDDING_DIM과 다르다(기대 ${String(dim)}, 받음 ${String(embedding.length)}). ` +
        "vec_idx의 dim과 어긋난 벡터는 저장해도 검색되지 않는다(specs/02).",
    );
  }
  return { index, embedding };
}

async function readBodySafely(response: HttpResponseLike): Promise<string> {
  try {
    const text = await response.text();
    return text.slice(0, ERROR_BODY_MAX_CHARS);
  } catch {
    return "<본문 읽기 실패>";
  }
}

function describe(cause: unknown): string {
  return cause instanceof Error ? cause.message : String(cause);
}
