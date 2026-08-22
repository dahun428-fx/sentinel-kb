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
 */
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

/** `API_KEYS` 형식이 깨졌을 때. 부팅을 멈추는 것이 목적이라 코드를 붙여 던진다. */
export class ApiKeyConfigError extends Error {
  readonly code = "API_KEYS_INVALID";

  constructor(message: string) {
    super(message);
    this.name = "ApiKeyConfigError";
  }
}

/** 인증 헤더가 없어도 통과하는 경로. specs/04: `/health`는 인증 불요. */
export const PUBLIC_PATHS: readonly string[] = ["/health"];

/**
 * `API_KEYS=<key>:<projectSlug>,<key>:<project>`를 키→project 맵으로 파싱한다.
 *
 * 애매한 입력은 **추측하지 않고 던진다.** 인증 설정에서 조용한 폴백은
 * "아무 키도 안 통하는 서버" 아니면 "엉뚱한 project로 쓰이는 레코드" 둘 중 하나가 된다.
 * - 값이 비었다 → 던진다. 빈 맵으로 부팅하면 모든 요청이 401이 되고 원인은 로그 어디에도 없다.
 * - 콜론이 없거나 둘 이상이다 → 던진다. `key:proj:extra`가 어느 쪽으로 갈리는지는 규약에 없다.
 * - 키나 project가 빈 문자열이다 → 던진다.
 * - 같은 키가 두 번 나왔다 → 던진다. 뒤가 이기는지 앞이 이기는지는 아무 데도 안 적혀 있다.
 *
 * 후행 콤마로 생긴 빈 조각만 건너뛴다 — `.env` 편집에서 흔하고 모호하지 않다.
 */
export function parseApiKeys(raw: string | undefined): ReadonlyMap<string, string> {
  const trimmed = raw?.trim();
  if (!trimmed) {
    throw new ApiKeyConfigError(
      "API_KEYS가 설정되지 않았다. `<key>:<projectSlug>` 형식을 콤마로 구분해 주입하라(.env.example 참조).",
    );
  }

  const byKey = new Map<string, string>();
  for (const segment of trimmed.split(",")) {
    const entry = segment.trim();
    if (entry === "") continue;

    const parts = entry.split(":");
    if (parts.length !== 2) {
      throw new ApiKeyConfigError(
        `API_KEYS 항목 형식이 올바르지 않다: "${entry}". \`<key>:<projectSlug>\` 여야 한다.`,
      );
    }
    const key = parts[0]?.trim() ?? "";
    const project = parts[1]?.trim() ?? "";
    if (key === "" || project === "") {
      throw new ApiKeyConfigError(`API_KEYS 항목에 빈 키나 빈 project가 있다: "${entry}".`);
    }
    if (byKey.has(key)) {
      throw new ApiKeyConfigError(
        `API_KEYS에 같은 키가 두 번 나온다: "${key}". 어느 project로 해석할지 규약이 없다.`,
      );
    }
    byKey.set(key, project);
  }

  if (byKey.size === 0) {
    throw new ApiKeyConfigError("API_KEYS에 유효한 항목이 하나도 없다.");
  }
  return byKey;
}

/** `Authorization: Bearer <key>`에서 키를 뽑는다. 스킴 이름은 대소문자를 가리지 않는다(RFC 7235). */
function extractBearerKey(header: string | undefined): string | undefined {
  if (header === undefined) return undefined;
  const match = /^Bearer[ \t]+(\S+)$/i.exec(header.trim());
  return match?.[1];
}

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
