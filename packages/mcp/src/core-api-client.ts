/**
 * core-api HTTP 클라이언트. 출처: specs/01-architecture.md
 * > `mcp/  MCP 서버 (core-api HTTP 소비)` / 다이어그램의 `mcp-server ──▶ core-api` 내부 HTTP
 *
 * **MCP는 `@sentinel/core`를 직접 부르지 않는다.** 스펙이 이미 정한 사항이라 T-014가
 * 새로 결정할 것이 아니다. core를 직접 부르면 MCP가 Mongo 연결·임베딩 자격증명을 자기
 * 프로세스에 들여야 하고, specs/01의 "core 분리" 근거(MCP·UI·CLI가 **같은 API**를 소비)가
 * 무너진다. 새니타이즈·project 강제 같은 쓰기 경로의 게이트도 core-api에만 있다.
 *
 * ---
 * ## 재시도 정책 — 멱등 요청만
 *
 * 재시도는 **읽기에서만** 켠다. `record_knowledge`(T-015)는 `POST /v1/records`로 가는
 * 쓰기이고, 이건 멱등하지 않다. 타임아웃은 "요청이 도달하지 않았다"가 아니라
 * **"결과를 모른다"**를 뜻하므로, 타임아웃 뒤 재전송하면 레코드가 두 벌 생긴다.
 * 지식보관소에서 중복 레코드는 조용한 손상이다 — 검색 결과가 같은 사건으로 두 번 차고,
 * 나중에 어느 쪽이 정본인지 아무도 모른다. 그래서 API를 둘로 갈라
 * **호출부가 멱등성을 명시적으로 선언**하게 한다. 기본값은 "재시도 안 함"이다.
 *
 * - `read()`  — `GET /v1/records*`, `POST /v1/search`(부수효과 없는 POST). 재시도함.
 * - `write()` — `POST /v1/records`, `PATCH /v1/records/:id`. **절대 재시도 안 함.**
 *
 * ## 토큰 취급
 * 원본 키는 클로저에만 둔다. 객체 프로퍼티로 들고 있으면 `JSON.stringify(client)`나
 * 구조화 로깅 한 줄에 그대로 실려 나간다. `CoreApiError`도 헤더를 담지 않는다.
 */

/** 응답 본문이 `{error:{code,message}}`(specs/04 규약)일 때 code를 뽑아 함께 들고 간다. */
export class CoreApiError extends Error {
  constructor(
    readonly statusCode: number,
    readonly code: string,
    message: string,
    /** 몇 번 시도한 끝에 난 오류인지. 재시도 정책이 실제로 걸렸는지 진단하는 근거. */
    readonly attempts: number,
  ) {
    super(message);
    this.name = "CoreApiError";
  }
}

/** 전송 실패·타임아웃처럼 HTTP 응답 자체가 없는 경우. */
export class CoreApiTransportError extends Error {
  readonly code = "CORE_API_UNREACHABLE";

  constructor(
    message: string,
    readonly attempts: number,
  ) {
    super(message);
    this.name = "CoreApiTransportError";
  }
}

/**
 * `read()`에 쓰기 경로가 들어왔을 때. **프로그래밍 오류**라 네트워크에 나가기 전에 죽인다.
 *
 * D-2는 "호출부가 멱등성을 선언한다"였는데, 선언만으로는 잘못 선언하는 것을 막지 못한다.
 * `read({method:"POST", path:"/v1/records"})` 한 줄이면 재시도가 켜진 채로 쓰기가 나가고,
 * 타임아웃은 "도달하지 않았다"가 아니라 **"결과를 모른다"**라 같은 사건이 레코드 두 벌로 남는다.
 */
export class CoreApiUnsafeReadError extends Error {
  readonly code = "CORE_API_UNSAFE_READ";

  constructor(message: string) {
    super(message);
    this.name = "CoreApiUnsafeReadError";
  }
}

export interface CoreApiRequest {
  readonly method: "GET" | "POST" | "PATCH";
  /** `/v1/...`로 시작하는 경로. 쿼리스트링을 포함해도 된다. */
  readonly path: string;
  readonly body?: unknown;
}

export interface CoreApiClient {
  /**
   * 부수효과가 없는(멱등한) 요청. 전송 실패·타임아웃·429·5xx에 한해 재시도한다.
   * 4xx는 재시도해 봐야 같은 답이 오므로 즉시 던진다.
   *
   * 레코드 변경 경로(`POST /v1/records`, `PATCH /v1/records/:id`)를 넘기면
   * **네트워크에 나가기 전에** `CoreApiUnsafeReadError`로 거절한다(`assertIdempotent`).
   */
  readonly read: (request: CoreApiRequest) => Promise<unknown>;
  /**
   * 쓰기 요청. **재시도하지 않는다.** 실패는 그대로 호출자에게 올라간다 —
   * 중복 레코드보다 "실패했다"가 낫다.
   */
  readonly write: (request: CoreApiRequest) => Promise<unknown>;
}

export interface CoreApiClientOptions {
  /** 예: `http://core-api:3001`. 끝의 `/`는 있어도 없어도 된다. */
  readonly baseUrl: string;
  /** core-api로 그대로 전달할 호출자의 Bearer 키. 클로저에만 보관된다. */
  readonly bearerKey: string;
  /** 시도 1회당 상한(ms). 기본 10000. */
  readonly timeoutMs?: number;
  /** 멱등 요청의 최대 **시도** 횟수(재시도 횟수가 아니다). 기본 3. 1이면 재시도 없음. */
  readonly maxAttempts?: number;
  /** 재시도 백오프 기준(ms). n번째 실패 후 base * 2^(n-1) 대기. 기본 100. */
  readonly retryBackoffMs?: number;
  /** 테스트 주입용. */
  readonly fetchImpl?: typeof fetch;
  /** 테스트 주입용 — 실제 대기 없이 백오프 로직만 태운다. */
  readonly sleep?: (ms: number) => Promise<void>;
}

export const DEFAULT_TIMEOUT_MS = 10_000;
export const DEFAULT_MAX_ATTEMPTS = 3;
export const DEFAULT_RETRY_BACKOFF_MS = 100;

/** 429 + 5xx만 재시도 대상이다. 4xx는 재전송해도 결과가 같다. */
function isRetryableStatus(status: number): boolean {
  return status === 429 || status >= 500;
}

/**
 * 레코드를 변경하는 경로. `/v1/records`, `/v1/records?...`, `/v1/records/:id`, `/v1/records/:id/...`.
 * `/v1/records-something` 같은 다른 리소스를 잡지 않도록 경계 문자를 요구한다.
 */
const RECORD_MUTATION_PATH = /^\/v1\/records(?:[/?#]|$)/;

/**
 * `read()`의 입구 가드. **타입만으로는 못 막는다** — `CoreApiRequest.method`가
 * `POST`도 포함해야 `POST /v1/search`(부수효과 없는 읽기 POST)를 태울 수 있기 때문이다.
 *
 * 그래서 경로로 가른다: 레코드 변경 계열(`/v1/records...`)로 가는 `POST`/`PATCH`는 던진다.
 * `GET /v1/records*`는 읽기라 통과하고, `POST /v1/search`도 통과한다
 * (`packages/api/src/search.ts`에 insert/update/delete가 없음을 확인했다).
 * 새 쓰기 엔드포인트가 생기면 여기 한 줄을 늘리는 것이 정답이다.
 */
function assertIdempotent(request: CoreApiRequest): void {
  if (request.method === "GET") return;
  if (!RECORD_MUTATION_PATH.test(request.path)) return;
  throw new CoreApiUnsafeReadError(
    `read()는 재시도하는 경로라 쓰기 요청을 받지 않는다: ${request.method} ${request.path}. ` +
      "레코드 변경은 write()로 보내라 — 타임아웃은 '도달하지 않았다'가 아니라 '결과를 모른다'다(D-2).",
  );
}

const defaultSleep = (ms: number): Promise<void> =>
  new Promise((resolve) => setTimeout(resolve, ms));

/** `{error:{code,message}}`를 최대한 살려서 읽는다. 형상이 아니면 상태 코드만으로 만든다. */
function toApiError(status: number, rawBody: string, attempts: number): CoreApiError {
  let code = "CORE_API_ERROR";
  let message = `core-api가 ${String(status)}를 반환했다.`;
  try {
    const parsed: unknown = JSON.parse(rawBody);
    if (typeof parsed === "object" && parsed !== null && "error" in parsed) {
      const error: unknown = (parsed as { error: unknown }).error;
      if (typeof error === "object" && error !== null) {
        const c: unknown = (error as { code?: unknown }).code;
        const m: unknown = (error as { message?: unknown }).message;
        if (typeof c === "string") code = c;
        if (typeof m === "string") message = m;
      }
    }
  } catch {
    // 본문이 JSON이 아니다. 본문을 메시지에 붙이지 않는다 — 프록시 오류 페이지가
    // 통째로 에이전트 컨텍스트에 실려 토큰 예산을 먹는다(NFR-03).
  }
  return new CoreApiError(status, code, message, attempts);
}

export function createCoreApiClient(options: CoreApiClientOptions): CoreApiClient {
  const base = options.baseUrl.replace(/\/+$/, "");
  const timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const maxAttempts = Math.max(1, options.maxAttempts ?? DEFAULT_MAX_ATTEMPTS);
  const backoffMs = options.retryBackoffMs ?? DEFAULT_RETRY_BACKOFF_MS;
  const doFetch = options.fetchImpl ?? globalThis.fetch;
  const sleep = options.sleep ?? defaultSleep;
  // 클로저 안에만 둔다. 반환 객체 어디에도 노출하지 않는다.
  const bearerKey = options.bearerKey;

  async function attempt(request: CoreApiRequest, attemptNo: number): Promise<unknown> {
    const headers: Record<string, string> = {
      authorization: `Bearer ${bearerKey}`,
      accept: "application/json",
    };
    if (request.body !== undefined) headers["content-type"] = "application/json";

    let response: Response;
    try {
      response = await doFetch(`${base}${request.path}`, {
        method: request.method,
        headers,
        ...(request.body === undefined ? {} : { body: JSON.stringify(request.body) }),
        // 시도마다 새 신호를 만든다. 하나를 재사용하면 첫 타임아웃 뒤 재시도가 즉시 중단된다.
        signal: AbortSignal.timeout(timeoutMs),
      });
    } catch (cause: unknown) {
      // 타임아웃도 여기로 온다(AbortError). 원인 객체를 메시지에 펼치지 않는다 —
      // undici 오류에는 요청 헤더가 붙어 있을 수 있다.
      const reason = cause instanceof Error ? cause.name : "UnknownError";
      throw new CoreApiTransportError(
        `core-api ${request.method} ${request.path} 요청이 실패했다(${reason}, 상한 ${String(timeoutMs)}ms).`,
        attemptNo,
      );
    }

    if (!response.ok) {
      throw toApiError(response.status, await response.text(), attemptNo);
    }
    if (response.status === 204) return undefined;
    return await response.json();
  }

  async function send(request: CoreApiRequest, retryable: boolean): Promise<unknown> {
    const limit = retryable ? maxAttempts : 1;
    let lastError: unknown;
    for (let attemptNo = 1; attemptNo <= limit; attemptNo += 1) {
      try {
        return await attempt(request, attemptNo);
      } catch (error: unknown) {
        lastError = error;
        const canRetry =
          error instanceof CoreApiTransportError ||
          (error instanceof CoreApiError && isRetryableStatus(error.statusCode));
        if (!canRetry || attemptNo === limit) throw error;
        await sleep(backoffMs * 2 ** (attemptNo - 1));
      }
    }
    throw lastError;
  }

  return {
    read: async (request) => {
      assertIdempotent(request);
      return await send(request, true);
    },
    write: (request) => send(request, false),
  };
}
