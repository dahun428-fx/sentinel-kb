/**
 * Fastify 앱 조립. 출처: specs/01-architecture.md(core-api), specs/04-api.md.
 *
 * **의존을 전부 인자로 받는다.** `getDb()` 싱글턴이나 `process.env`를 여기서 부르지 않는다 —
 * 그러면 통합 테스트가 env에 결합되고, CI의 `MONGODB_URI`는 존재하지 않는 시크릿이라
 * 빈 문자열이 들어온다(T-003이 확인). 실제 env 읽기는 `server.ts`(컴포지션 루트)의 몫이다.
 */
import { HealthResponse } from "@sentinel/contracts";
import {
  SanitizeInputTooLargeError,
  type ResolvedSanitizeOptions,
  type Retriever,
} from "@sentinel/core";
import Fastify, {
  type FastifyError,
  type FastifyInstance,
  type FastifyServerOptions,
} from "fastify";
import type { Db } from "mongodb";

import { registerAuth } from "./auth.js";
import { API_ERROR_CODES, HttpError, sendError } from "./errors.js";
import { registerOpenApiRoute, trackRoutes, type RouteRef } from "./openapi.js";
import { registerRecordRoutes } from "./records.js";
import { registerSearchRoutes } from "./search.js";

declare module "fastify" {
  interface FastifyInstance {
    /**
     * 이 인스턴스에 실제로 등록된 라우트 목록(HEAD 제외). 드리프트 가드가 openapi 문서와
     * 대조하는 **한쪽 근거**다. Fastify는 라우터를 열거하는 공개 API를 주지 않으므로
     * (`hasRoute`는 존재 확인만 된다) `onRoute` 훅으로 모아 여기에 실어 둔다.
     */
    readonly registeredRoutes: readonly RouteRef[];
  }
}

export interface AppOptions {
  readonly db: Db;
  /** 부팅 시 1회 파싱된 키→project 맵. `parseApiKeys`가 만든다. */
  readonly apiKeys: ReadonlyMap<string, string>;
  /** 부팅 시 1회 해석된 새니타이즈 옵션. 요청마다 env를 읽지 않기 위한 것이다(T-004 F-4). */
  readonly sanitizeOptions: ResolvedSanitizeOptions;
  /** `/health`가 보고하는 임베딩 세대. `EMBEDDING_VERSION`이 없으면 0(미설정)이다. */
  readonly embeddingVersion: number;
  /** `/health`가 보고하는 서비스 버전. */
  readonly version: string;
  /**
   * `/v1/search`가 쓰는 하이브리드 검색기. **주면 라우트가 뜨고, 안 주면 뜨지 않는다.**
   *
   * 선택 의존인 이유는 검색을 하지 않는 소비자가 실제로 있기 때문이다 — 시드 적재
   * (`scripts/seed.ts`)와 T-007의 records 통합 테스트는 `POST /v1/records`만 부른다.
   * 필수로 만들면 그 호출부들이 **쓰지도 않을 embedder를 만들어야** 하고, 시드는
   * Voyage 자격증명 없이는 돌지 못하게 된다.
   *
   * 운영에서 조용히 빠질 위험은 컴포지션 루트가 닫는다: `server.ts`는 이 값을 **항상**
   * 만들어 넘긴다. 거기서 embedder 설정이 없으면 라우트가 404가 되는 게 아니라
   * **부팅이 실패한다**(T-006 인계 패턴).
   */
  readonly retriever?: Retriever;
  readonly now?: () => Date;
  /**
   * `boolean` 외에 pino 옵션 객체도 받는다 — 테스트가 `stream`을 주입해 **실제로 나간
   * 로그 줄**을 검사할 수 있어야 한다. 레이턴시 로깅(NFR-01)은 필드가 하나 빠져도
   * 조용히 무의미해지므로, 형상만 단언하는 것으로는 부족하다.
   */
  readonly logger?: FastifyServerOptions["logger"];
}

/**
 * 새니타이즈 상한 초과에 쓰는 상태 코드.
 *
 * **413을 택했다.** 스펙에 문면이 없어(Findings) 400과 413 사이의 선택이었는데,
 * 400은 "스키마를 고쳐라"로 읽히고 413은 "본문을 나눠 올려라"로 읽힌다.
 * 클라이언트가 실제로 취해야 할 조치가 후자이고, 스키마 위반과 **다른 분기**를 타야
 * 자동화된 기록 도구(MCP `record_knowledge`)가 재시도 전략을 가를 수 있다.
 */
export const PAYLOAD_TOO_LARGE_STATUS = 413;

export function createApp(options: AppOptions): FastifyInstance {
  const app = Fastify({ logger: options.logger ?? false });

  // **가장 먼저 단다.** `onRoute`는 훅 등록 뒤에 붙은 라우트만 통지하므로, 이 줄이 내려가면
  // 그 위에서 등록된 라우트가 인벤토리에서 조용히 빠지고 가드가 그만큼 눈이 먼다.
  app.decorate("registeredRoutes", trackRoutes(app));

  registerAuth(app, options.apiKeys);

  app.get("/health", async (_request, reply) => {
    // ping이 실패해도 던지지 않는다 — DB 장애에 500으로 답하면 진단이 불가능하다.
    let mongo: "up" | "down" = "down";
    try {
      await options.db.admin().command({ ping: 1 });
      mongo = "up";
    } catch {
      mongo = "down";
    }
    return reply.send(
      HealthResponse.parse({
        status: mongo === "up" ? "ok" : "degraded",
        mongo,
        embeddingVersion: options.embeddingVersion,
        version: options.version,
      }),
    );
  });

  // specs/04:29 — contracts가 생성한 문서를 그대로 서빙. 인증 정책의 근거는 `openapi.ts`에 있다.
  registerOpenApiRoute(app);

  registerRecordRoutes(app, {
    db: options.db,
    sanitizeOptions: options.sanitizeOptions,
    now: options.now ?? ((): Date => new Date()),
  });

  if (options.retriever !== undefined) {
    registerSearchRoutes(app, { retriever: options.retriever });
  }

  app.setNotFoundHandler(async (request, reply) =>
    sendError(
      reply,
      404,
      API_ERROR_CODES.RECORD_NOT_FOUND,
      `${request.method} ${request.url}에 해당하는 경로가 없다.`,
    ),
  );

  /**
   * 모든 에러가 `{error:{code, message, details?}}`로 나가는 단 하나의 출구다(specs/04 규약).
   * Fastify 기본 핸들러를 그대로 두면 malformed JSON 같은 프레임워크 에러가
   * `{statusCode, error, message}` 형상으로 새어 나가 계약이 두 가지가 된다.
   */
  app.setErrorHandler((error: FastifyError, request, reply) => {
    if (error instanceof HttpError) {
      return sendError(reply, error.statusCode, error.code, error.message, error.details);
    }

    /**
     * **잡지 않으면 500이 난다.** core는 상한 초과 입력을 자르지 않고 던진다 —
     * 조용한 절단은 "검사되지 않은 시크릿을 호출자가 모르고 저장"하는 경로이기 때문이다(T-004).
     * 그 명시적 실패를 4xx로 옮기는 것이 T-007의 몫이다.
     */
    if (error instanceof SanitizeInputTooLargeError) {
      return sendError(
        reply,
        PAYLOAD_TOO_LARGE_STATUS,
        API_ERROR_CODES.SANITIZE_INPUT_TOO_LARGE,
        error.message,
        { length: error.length, maxLength: error.maxLength },
      );
    }

    // Fastify가 만든 4xx(빈 바디, 잘못된 JSON, 지원하지 않는 Content-Type 등).
    const statusCode = error.statusCode ?? 500;
    if (statusCode >= 400 && statusCode < 500) {
      return sendError(reply, statusCode, API_ERROR_CODES.VALIDATION_FAILED, error.message);
    }

    request.log.error({ err: error }, "처리되지 않은 오류");
    // 내부 메시지를 그대로 내보내지 않는다 — 스택·쿼리 조각이 응답으로 새는 경로다.
    return sendError(
      reply,
      500,
      API_ERROR_CODES.INTERNAL_ERROR,
      "요청을 처리하는 중 내부 오류가 발생했다.",
    );
  });

  return app;
}
