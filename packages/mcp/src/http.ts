/**
 * Streamable HTTP 전송(`POST/GET/DELETE /mcp`). 출처: specs/07-mcp.md
 * > 전송: Streamable HTTP (`/mcp`) + 로컬 개발용 stdio 어댑터.
 * > 인증: `Authorization: Bearer <project-key>` → project 스코프 주입.
 *
 * ---
 * ## 401은 왜 여기(HTTP 레벨)에서 나가는가 — T-014 D-4
 *
 * MCP 프로토콜에는 "인증 실패" 응답이 없다. JSON-RPC 에러로 내리면 클라이언트는
 * **연결은 성립했다**고 믿고 세션을 이어가려 하며, `.mcp.json`의 Bearer 헤더가 틀렸다는
 * 사실이 도구 호출 시점까지 미뤄진다. MCP 명세도 인증은 HTTP 계층의 일이라고 본다.
 * 그래서 이 훅은 **전송에 요청을 넘기기 전에** 걸리고, 401 + `WWW-Authenticate: Bearer`로
 * 끝낸다 — api의 `registerAuth`가 `onRequest`(바디 파싱 이전)에 붙는 것과 같은 자리다.
 *
 * ## stateless인 이유
 * 요청마다 새 서버·새 전송을 만든다. 세션을 들고 있으면 **세션 ID 하나가 project 하나에
 * 묶인 채 메모리에 남는다** — 키가 회수돼도 살아 있는 세션은 계속 그 project로 쓴다.
 * 도구가 5개뿐이고 상태가 없는 서버라 세션을 유지해 얻을 것도 없다.
 *
 * ## 로그에 토큰을 남기지 않는다
 * 로그 엔트리에 `authorization` 헤더도, 그 일부도, 인증 실패한 키도 넣지 않는다.
 * T-012가 `/v1/search` 로그에서 원문 쿼리를 뺀 것과 같은 이유다 —
 * 로그는 백업·전송·열람 경로가 응답보다 훨씬 넓다.
 */
import { ApiError } from "@sentinel/contracts";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import type { Transport } from "@modelcontextprotocol/sdk/shared/transport.js";
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";

import { McpAuthError, resolveAuth } from "./auth.js";
import { createCoreApiClient, type CoreApiClient } from "./core-api-client.js";
import { createMcpServer, type McpServerFactory } from "./server.js";

export const MCP_PATH = "/mcp";

/** 구조화 로그 한 줄. **토큰이 들어갈 자리가 타입에 아예 없다.** */
export interface McpHttpLogEntry {
  readonly method: string;
  readonly path: string;
  readonly status: number;
  readonly durationMs: number;
  /** 인증에 성공했을 때만 붙는다. */
  readonly project?: string;
}

export interface McpHttpOptions {
  /** 부팅 시 1회 파싱된 키→project 맵. `parseApiKeys`가 만든다. */
  readonly apiKeys: ReadonlyMap<string, string>;
  /** core-api 베이스 URL. 예: `http://localhost:3001`. */
  readonly coreApiBaseUrl: string;
  readonly coreApiTimeoutMs?: number;
  readonly coreApiMaxAttempts?: number;
  /** 테스트가 실제 나간 로그 줄을 검사할 수 있게 주입 가능하게 둔다. 기본은 무출력. */
  readonly log?: (entry: McpHttpLogEntry) => void;
  /** 테스트 주입용 — core-api를 실제로 띄우지 않고 도구 경로를 태운다. */
  readonly createCoreApi?: (bearerKey: string) => CoreApiClient;
  /**
   * 서버 팩토리. 기본값은 `createMcpServer`이고, 프로덕션은 기본값만 쓴다.
   * 주입 가능하게 둔 이유는 `McpServerFactory`의 주석에 있다 —
   * **넘어가는 `McpContext.project`를 테스트가 주입 지점에서 관측하기 위해서**다.
   */
  readonly createServer?: McpServerFactory;
}

function sendJson(res: ServerResponse, status: number, body: unknown): void {
  const payload = JSON.stringify(body);
  res.writeHead(status, {
    "content-type": "application/json",
    "content-length": String(Buffer.byteLength(payload)),
  });
  res.end(payload);
}

/** specs/04의 `{error:{code,message}}` 규약을 그대로 쓴다 — contracts 스키마로 검증해서 내보낸다. */
function sendError(res: ServerResponse, status: number, code: string, message: string): void {
  sendJson(res, status, ApiError.parse({ error: { code, message } }));
}

/**
 * SDK 타입과 이 레포의 `exactOptionalPropertyTypes: true` 사이의 표기 차이를 **한 곳에서만** 좁힌다.
 *
 * `StreamableHTTPServerTransport`는 `onclose`/`onerror`/`onmessage`를 getter/setter로 노출해
 * 타입이 `(() => void) | undefined`가 되는데, `Transport` 인터페이스는 `onclose?: () => void`
 * (선택 프로퍼티)다. exactOptionalPropertyTypes 아래에서 이 둘은 assignable하지 않다.
 * **런타임 형상은 완전히 같다** — 순수한 타입 표기 문제다.
 *
 * `any`를 쓰지 않고 `Transport`로 좁히므로 이후 사용은 전부 검사된다.
 * (stdio의 `StdioServerTransport`는 평범한 프로퍼티라 이 처리가 필요 없다.)
 */
function asTransport(transport: StreamableHTTPServerTransport): Transport {
  return transport as unknown as Transport;
}

/** 쿼리스트링을 뗀 경로. */
function pathOf(url: string | undefined): string {
  const raw = url ?? "/";
  return raw.split("?")[0] ?? raw;
}

export function createMcpHttpServer(options: McpHttpOptions): Server {
  const log = options.log ?? ((): void => undefined);
  const makeServer = options.createServer ?? createMcpServer;
  const makeCoreApi =
    options.createCoreApi ??
    ((bearerKey: string): CoreApiClient =>
      createCoreApiClient({
        baseUrl: options.coreApiBaseUrl,
        bearerKey,
        ...(options.coreApiTimeoutMs === undefined ? {} : { timeoutMs: options.coreApiTimeoutMs }),
        ...(options.coreApiMaxAttempts === undefined
          ? {}
          : { maxAttempts: options.coreApiMaxAttempts }),
      }));

  return createServer((req: IncomingMessage, res: ServerResponse) => {
    const startedAt = Date.now();
    const path = pathOf(req.url);
    const method = req.method ?? "GET";
    const finish = (status: number, project?: string): void => {
      log({
        method,
        path,
        status,
        durationMs: Date.now() - startedAt,
        ...(project === undefined ? {} : { project }),
      });
    };

    void (async (): Promise<void> => {
      if (path !== MCP_PATH) {
        sendError(res, 404, "NOT_FOUND", `${method} ${path}에 해당하는 경로가 없다.`);
        finish(404);
        return;
      }

      let project: string;
      let key: string;
      try {
        ({ project, key } = resolveAuth(req.headers.authorization, options.apiKeys));
      } catch (error: unknown) {
        if (error instanceof McpAuthError) {
          // 표준 챌린지. 클라이언트가 "자격증명이 문제"임을 명확히 알아야 한다(RFC 7235).
          res.setHeader("WWW-Authenticate", "Bearer");
          sendError(res, error.statusCode, error.code, error.message);
          finish(error.statusCode);
          return;
        }
        throw error;
      }

      /**
       * 요청 하나 = 서버 하나 = 전송 하나. 서버는 **반드시** `createMcpServer`에서 나온다 —
       * 여기서 직접 조립하면 stdio와 도구 목록이 갈라진다(Acceptance 3).
       */
      const server = makeServer({ project, coreApi: makeCoreApi(key) });
      // `sessionIdGenerator`를 주지 않는 것이 stateless 모드다(SDK: "If not provided,
      // session management is disabled"). 세션 ID가 응답에 실리지 않고 검증도 하지 않는다.
      const transport = new StreamableHTTPServerTransport({});

      res.on("close", () => {
        void transport.close();
        void server.close();
      });

      try {
        await server.connect(asTransport(transport));
        await transport.handleRequest(req, res);
        finish(res.statusCode, project);
      } catch {
        // 원인 객체를 응답에 싣지 않는다 — 스택·요청 헤더가 새는 경로다.
        if (!res.headersSent) {
          sendError(res, 500, "INTERNAL_ERROR", "요청을 처리하는 중 내부 오류가 발생했다.");
        }
        finish(500, project);
      }
    })();
  });
}
