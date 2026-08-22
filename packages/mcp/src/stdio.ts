/**
 * stdio 어댑터(로컬 개발용). 출처: specs/07-mcp.md / specs/01-architecture.md
 * > MCP 전송 | Streamable HTTP (+ stdio 로컬 어댑터)
 *
 * ---
 * ## stdio에서 인증은 어떻게 되는가 — T-014 D-4(후반)
 *
 * stdio에는 **HTTP가 없다.** 401을 내보낼 상태 줄도, `WWW-Authenticate`를 실을 헤더도 없다.
 * 전송은 부모 프로세스가 직접 spawn한 파이프라 인증할 원격 상대도 없다 — 파이프 반대편은
 * 이미 이 프로세스를 띄운 그 사람이다. 스펙은 이 경우를 정하지 않았다.
 *
 * **결정: stdio의 인증 실패는 부팅 실패다.** 프로세스 시작 시 `SENTINEL_KB_KEY`를
 * `API_KEYS`에 대조해 project를 확정하고, 확정할 수 없으면 **뜨지 않는다**(비정상 종료).
 *
 * 근거 두 가지.
 * 1. specs/07이 요구하는 것은 "Bearer → **project 스코프 주입**"이다. project를 모르는
 *    stdio 서버는 인증을 건너뛰는 게 아니라 **스코프 없이 쓰는 서버**가 된다. 그런 서버가
 *    조용히 뜨면 로컬에서 기록한 사례가 엉뚱한 project로 들어가고, 그건 나중에 검색으로만
 *    발견된다. 늦게 죽는 것보다 부팅에서 죽는 게 싸다(T-006·`api/src/server.ts` 인계 패턴).
 * 2. 인증 판정 코드는 HTTP 모드와 **같은 `resolveAuth`**를 쓴다. 모드마다 판정이 갈리면
 *    "로컬에선 되는데 서버에선 401"이 재현 불가능한 형태로 생긴다.
 */
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { Transport } from "@modelcontextprotocol/sdk/shared/transport.js";

import { McpAuthError, resolveAuth, type AuthContext } from "./auth.js";
import { createCoreApiClient, type CoreApiClient } from "./core-api-client.js";
import { createMcpServer, type McpServerFactory } from "./server.js";

/**
 * stdio 부팅 실패 문구. **HTTP 경로의 무오라클 메시지를 그대로 쓰지 않는다.**
 *
 * `resolveAuth`의 메시지는 "유효한 `Authorization: Bearer <key>` 헤더가 필요하다"인데,
 * stdio에는 HTTP 헤더가 **존재하지 않는다**. 그 문구가 stderr로 나가면 운영자는 있지도 않은
 * 헤더를 찾게 되고 실제 원인(`SENTINEL_KB_KEY` 미설정/미등록)에 닿지 못한다.
 *
 * D-4가 인용한 "키 유효성 오라클 방지"는 **원격 요청자**를 향한 논거다. stdio는 이 프로세스를
 * 자기 손으로 spawn한 사람이 파이프 반대편이고, 그 사람은 이미 키의 주인이다 — 그에게 감출
 * 것이 없다. HTTP 경로의 무오라클 응답은 그대로 둔다. (그래도 **키 값 자체는 찍지 않는다.**
 * stderr는 CI 로그·터미널 스크롤백으로 흘러나가는 경로다.)
 *
 * 미설정과 미등록을 한 문장으로 합쳐 두는 것은 의도적이다 — 어차피 조치가 같다.
 */
export const STDIO_AUTH_FAILURE_MESSAGE =
  "`SENTINEL_KB_KEY`가 설정되지 않았거나 `API_KEYS`에 등록되어 있지 않다. " +
  "stdio 모드는 project 스코프를 확정하지 못하면 기동하지 않는다(엉뚱한 project로 기록되는 것보다 낫다).";

export interface StdioOptions {
  /** 부팅 시 1회 파싱된 키→project 맵. */
  readonly apiKeys: ReadonlyMap<string, string>;
  /** 이 프로세스가 쓸 project 키. `SENTINEL_KB_KEY`. */
  readonly bearerKey: string | undefined;
  readonly coreApiBaseUrl: string;
  readonly coreApiTimeoutMs?: number;
  readonly coreApiMaxAttempts?: number;
  /** 테스트 주입용. */
  readonly createCoreApi?: (bearerKey: string) => CoreApiClient;
  /**
   * 서버 팩토리. 기본값은 `createMcpServer`이고 프로덕션은 기본값만 쓴다.
   * HTTP 쪽과 **대칭으로** 주입 가능하다 — 이유는 `McpServerFactory` 주석 참조
   * (넘어가는 `McpContext.project`를 주입 지점에서 관측하기 위해서다).
   */
  readonly createServer?: McpServerFactory;
  /**
   * 전송 팩토리. 기본값은 `new StdioServerTransport()`.
   * 테스트가 실제 `process.stdin`/`stdout`을 물지 않고 부팅 경로를 태우기 위한 자리다.
   */
  readonly createTransport?: () => Transport;
}

/**
 * stdio 전송에 서버를 붙인다. 인증이 안 되면 `McpAuthError`를 던지고 **뜨지 않는다.**
 *
 * 서버는 HTTP 모드와 **같은 `createMcpServer`**에서 나온다 — 이것이 Acceptance 3의
 * "동일 서버 인스턴스"가 기계로 검증되는 지점이다.
 */
export async function startStdioServer(options: StdioOptions): Promise<McpServer> {
  let auth: AuthContext;
  try {
    auth = resolveAuth(
      options.bearerKey === undefined ? undefined : `Bearer ${options.bearerKey}`,
      options.apiKeys,
    );
  } catch (error: unknown) {
    // 판정은 HTTP와 **같은 `resolveAuth`**가 한다. 갈라지는 것은 진단 문구뿐이다
    // (STDIO_AUTH_FAILURE_MESSAGE 주석 참조).
    if (error instanceof McpAuthError) throw new McpAuthError(STDIO_AUTH_FAILURE_MESSAGE);
    throw error;
  }
  const { project, key } = auth;

  const coreApi =
    options.createCoreApi?.(key) ??
    createCoreApiClient({
      baseUrl: options.coreApiBaseUrl,
      bearerKey: key,
      ...(options.coreApiTimeoutMs === undefined ? {} : { timeoutMs: options.coreApiTimeoutMs }),
      ...(options.coreApiMaxAttempts === undefined
        ? {}
        : { maxAttempts: options.coreApiMaxAttempts }),
    });

  const server = (options.createServer ?? createMcpServer)({ project, coreApi });
  await server.connect(options.createTransport?.() ?? new StdioServerTransport());
  return server;
}
