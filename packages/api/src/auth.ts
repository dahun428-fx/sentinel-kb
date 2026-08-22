/**
 * Bearer 인증. 출처: specs/04-api.md("인증: `Authorization: Bearer <key>` → `{project}` 클레임"),
 * NFR-04("모든 외부 표면 Bearer 인증, 프로젝트별 키"), `.env.example`의 `API_KEYS`.
 *
 * **키 맵은 부팅 시 1회 파싱한다.** 요청마다 `process.env`를 다시 읽으면
 * (a) 오설정이 첫 요청까지 숨었다가 런타임에 터지고,
 * (b) 프로세스가 도는 중에 키 집합이 조용히 바뀌어 재현 불가능한 인증 결과가 나온다.
 * T-006이 embedder 설정에서 같은 결론을 냈고, 여기서도 같은 이유로 컴포지션 루트가 한 번 읽는다.
 *
 * **클라이언트가 준 project 값은 어디서도 쓰지 않는다.** 이 훅이 붙인 값만이 쓰기 범위다.
 *
 * `API_KEYS` 파싱(`parseApiKeys`)과 Bearer 헤더 추출(`extractBearerKey`)은 T-037에서
 * `@sentinel/core`로 올라갔다 — 순수 문자열 파싱이라 HTTP를 모르는 core에 두는 것이
 * 의존 방향에 맞고, `packages/mcp`가 형제 간선 없이 같은 한 벌을 쓸 수 있다(T-014 F-1).
 * 여기 남은 것은 **HTTP 고유한 것**뿐이다: 401 판정과 Fastify 훅 등록.
 */
import { extractBearerKey } from "@sentinel/core";
import type { FastifyInstance, FastifyRequest } from "fastify";

import { API_ERROR_CODES, HttpError } from "./errors.js";

declare module "fastify" {
  interface FastifyRequest {
    /**
     * 인증 키에서 해석한 project 클레임. **인증 훅만이 이 값을 쓴다.**
     * 요청 바디·쿼리의 어떤 값도 여기 들어오지 않는다.
     */
    project: string;
  }
}

/** 인증 헤더가 없어도 통과하는 경로. specs/04: `/health`는 인증 불요. */
export const PUBLIC_PATHS: readonly string[] = ["/health"];

/**
 * 요청의 project 클레임을 해석한다.
 *
 * 실패 이유(헤더 없음 / 형식 오류 / 미등록 키)를 **응답에서 구분하지 않는다.**
 * 구분하면 "이 키는 형식은 맞는데 등록이 안 됐다"가 키 유효성 오라클이 된다.
 */
export function resolveProject(
  header: string | undefined,
  apiKeys: ReadonlyMap<string, string>,
): string {
  const key = extractBearerKey(header);
  const project = key === undefined ? undefined : apiKeys.get(key);
  if (project === undefined) {
    throw new HttpError(
      401,
      API_ERROR_CODES.UNAUTHORIZED,
      "유효한 `Authorization: Bearer <key>` 헤더가 필요하다.",
    );
  }
  return project;
}

/** 쿼리스트링을 뗀 경로. 라우팅이 매칭되기 전(`onRequest`)이라 `request.url`이 유일한 출처다. */
function pathOf(url: string): string {
  return url.split("?")[0] ?? url;
}

/**
 * 인증 훅을 등록한다. `onRequest`에 다는 것이 요점이다 —
 * 바디 파싱보다 먼저 걸려야 미인증 요청이 파서·핸들러에 도달하지 않는다.
 * (동기 콜백이 아니라 async 훅인 이유: 던진 `HttpError`가 에러 핸들러로 가야 한다.)
 */
export function registerAuth(app: FastifyInstance, apiKeys: ReadonlyMap<string, string>): void {
  app.decorateRequest("project", "");
  app.addHook("onRequest", async (request: FastifyRequest): Promise<void> => {
    if (!PUBLIC_PATHS.includes(pathOf(request.url))) {
      request.project = resolveProject(request.headers.authorization, apiKeys);
    }
    await Promise.resolve();
  });
}
