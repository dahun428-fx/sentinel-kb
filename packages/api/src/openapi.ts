/**
 * `/v1/openapi.json` 서빙 + 스펙-코드 드리프트 가드. 출처: specs/04-api.md:29
 * > `packages/contracts`에서 zod-to-openapi로 생성, `/v1/openapi.json` 서빙. **수기 작성 금지.**
 *
 * 이 모듈의 진짜 산출물은 라우트가 아니라 **가드**다. 라우트 하나를 더하는 것은 쉽고,
 * 등록된 오퍼레이션과 실제 라우트가 갈라지는 것을 **아무도 눈치채지 못하는 상태**가 문제다.
 * 그 상태에서 서빙되는 문서는 조용히 거짓말을 시작하고, 그 거짓말은 이 레포가 아니라
 * 문서로 코드를 생성한 **클라이언트 쪽에서** 터진다.
 *
 * ## 대조 단위를 경로+메서드로 **한정한** 이유 (T-036 Findings, T-007 R-2)
 *
 * T-007 R-2가 남긴 것: 413 `SANITIZE_INPUT_TOO_LARGE`가 openapi에 미등록이다.
 * "가드를 상태코드까지 넓힐까?"에 대한 답은 **넓히지 않는다**이고, 근거는 관측 가능성이다.
 *
 * 경로와 메서드는 Fastify 라우터에서 **기계적으로 읽어낼 수 있다.** 반면 한 오퍼레이션이
 * 낼 수 있는 상태코드 집합은 라우터에 없다 — 핸들러 로직과 `app.setErrorHandler`에서
 * 창발한다. 그것을 대조하려면 "이 라우트가 낼 수 있는 상태코드" 목록을 **손으로** 유지해야 하는데,
 * 그 목록은 코드와 아무 기계적 연결이 없으므로 조용히 썩는다. 즉 04:29가 금지한 **수기 작성**을
 * 가드 안쪽에 다시 들여오는 꼴이고, 권위 있어 보이는데 검증되지 않는다는 점에서
 * 가드가 아예 없는 것보다 **나쁘다.**
 *
 * → 413 미등록은 이 가드가 아니라 `packages/contracts`에서 고칠 일이다(오퍼레이션에 413 추가).
 *   contracts는 T-036의 수정 범위 밖이므로 후속 태스크로 넘긴다.
 *
 * ## 이 가드가 `pnpm verify`에 들어가 **머지를 막는** 이유
 *
 * `.github/workflows/ci.yml`의 `spec-drift` 잡은 실패해도 머지를 막지 않는다. 그 판단은 옳다 —
 * 그쪽은 **산문 스펙과 코드**를 대조하는 휴리스틱이라 오탐이 구조적으로 존재하고,
 * 오탐이 섞인 신호를 막는 게이트로 쓰면 사람이 게이트를 무시하는 법을 배운다.
 *
 * 이 가드는 다르다. **기계가 생성한 두 산출물**(openapi 레지스트리 ↔ Fastify 라우터)을 대조하며
 * 자연어 추론이 한 단계도 끼지 않는다. 오탐 표면이 0이고, 실패는 언제나 둘 중 하나의 실제 결함이다:
 * 라우트 없는 오퍼레이션, 또는 문서 없는 라우트. 게다가 드리프트의 실패 양식은 **조용하고 하류에서**
 * 터지는 종류라(생성된 클라이언트가 깨진다) 하드 게이트의 값이 가장 큰 부류다.
 * 고치는 비용도 기계적이다 — 오퍼레이션을 등록하거나, 라우트를 지우거나, 아래 allowlist에 명시하거나.
 */
import { buildOpenApiDocument } from "@sentinel/contracts/openapi";
import type { FastifyInstance } from "fastify";

/** 생성된 OpenAPI 문서를 서빙하는 경로. specs/04:29가 문면으로 못박은 값이다. */
export const OPENAPI_ROUTE = "/v1/openapi.json";

/**
 * 라우트 하나. `path`는 항상 `normalizePath`를 거친 OpenAPI 표기(`{id}`)다.
 * `method`는 대문자 HTTP 메서드.
 */
export interface RouteRef {
  readonly method: string;
  readonly path: string;
}

/** 드리프트 대조 결과. 세 항목이 **모두** 비어야 통과다. */
export interface DriftReport {
  /** openapi에 등록됐는데 Fastify에 라우트가 없다 — 문서가 없는 엔드포인트를 약속했다. */
  readonly documentedButNotRouted: readonly string[];
  /** 라우트는 있는데 openapi에 없다 — 서빙되는 문서가 API를 다 설명하지 못한다. */
  readonly routedButNotDocumented: readonly string[];
  /**
   * 라우트가 생겼는데 아직 `PENDING_OPERATIONS`에 남아 있는 항목.
   * **유예 목록이 썩는 것을 막는 자정 장치**다 — 아래 `PENDING_OPERATIONS` 주석 참조.
   */
  readonly stalePending: readonly string[];
}

/** 아직 라우트가 없는 오퍼레이션과, 그것을 채울 태스크. */
export interface PendingOperation {
  readonly key: string;
  readonly task: string;
}

/**
 * **아직 구현되지 않은 오퍼레이션의 유예 목록.**
 *
 * contracts는 specs/04 표의 8개 오퍼레이션을 **한꺼번에** 등록해 뒀는데 라우트는 태스크마다
 * 하나씩 들어온다. 그 시차를 인정하지 않으면 이 가드는 마지막 라우트가 들어오는 날까지
 * 계속 빨갛고, 계속 빨간 게이트는 꺼진 게이트와 같다.
 *
 * **그러나 유예는 조용히 늙으면 안 된다.** 그래서 이 목록은 정확해야 한다 —
 * 여기 적힌 오퍼레이션의 라우트가 실제로 생기면 `stalePending`에 잡혀 가드가 실패한다.
 * 즉 T-012가 `/v1/search`를 구현하는 순간 이 파일에서 그 줄을 **지워야만** 초록이 된다.
 * 유예를 늘리는 것도 지우는 것도 리뷰어의 눈에 보이는 명시적 행위가 된다.
 */
export const PENDING_OPERATIONS: readonly PendingOperation[] = [
  // T-012(/v1/search)와 T-022(/v1/feedback)는 통합 브랜치에서 실제로 라우트가 섰다.
  // `stalePending`이 그 사실을 알려서 이 두 줄을 지웠다 — 자정 장치가 설계대로 작동한 첫 사례다.
  { key: "POST /v1/answer", task: "T-019" },
];

/**
 * 문서에 없어도 되는 라우트. **의도적으로 짧게 유지한다.**
 *
 * `/v1/openapi.json` 자신이 유일한 항목이다. 문서가 자기 자신을 기술하게 하려면
 * `packages/contracts`에 9번째 오퍼레이션을 등록해야 하는데, 그건 T-036의 수정 범위 밖이고
 * (contracts 변경 금지) contracts의 기존 테스트가 "specs/04 표의 8개"를 단언하고 있어
 * 그 테스트를 고쳐야만 통과한다 — 즉 금지된 경로다.
 *
 * 여기 한 줄을 더하는 것은 **리뷰어의 눈에 보이는 명시적 행위**여야 한다.
 * 가드를 통과시키려고 조용히 항목을 늘리는 순간 이 파일 전체가 무의미해진다.
 */
export const UNDOCUMENTED_ROUTES: readonly string[] = [`GET ${OPENAPI_ROUTE}`];

/** OpenAPI가 오퍼레이션으로 인정하는 메서드. `HEAD`는 뒤에서 따로 다룬다. */
const HTTP_METHODS = ["get", "post", "put", "patch", "delete", "options", "trace"] as const;

/** `${METHOD} ${path}` — 사람이 읽는 실패 메시지이자 대조 키다. */
export function routeKey(route: RouteRef): string {
  return `${route.method} ${route.path}`;
}

/**
 * 경로 표기를 OpenAPI 쪽으로 통일한다: Fastify의 `:id` → OpenAPI의 `{id}`.
 * 두 표기를 그대로 두고 비교하면 **모든** 파라미터 경로가 영구 오탐이 되고,
 * 그러면 가드는 첫날에 꺼진다.
 */
export function normalizePath(path: string): string {
  return path.replace(/:([A-Za-z0-9_]+)/g, "{$1}");
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/**
 * OpenAPI 문서에서 오퍼레이션 목록을 뽑는다.
 *
 * 인자를 `unknown`으로 받는 이유: `openapi3-ts` 타입에 결합하지 않기 위해서다
 * (그 패키지는 contracts의 devDependency이고 api의 의존이 아니다).
 *
 * **형상이 깨졌으면 빈 배열이 아니라 throw한다.** 빈 배열을 돌려주면 문서가 망가진 순간
 * 가드가 "드리프트 없음"으로 통과한다 — 감시가 필요한 바로 그때 감시가 꺼진다.
 */
export function documentedOperations(document: unknown): RouteRef[] {
  if (!isRecord(document) || !isRecord(document["paths"])) {
    throw new Error(
      "OpenAPI 문서에 `paths` 객체가 없다. 드리프트 대조의 한쪽 근거가 사라졌으므로 통과시키지 않는다.",
    );
  }

  const operations: RouteRef[] = [];
  for (const [path, item] of Object.entries(document["paths"])) {
    // `$ref`·`summary`·`servers` 같은 path item 레벨 키를 오퍼레이션으로 오인하지 않도록
    // 알려진 메서드만 훑는다.
    if (!isRecord(item)) continue;
    for (const method of HTTP_METHODS) {
      if (item[method] !== undefined) {
        operations.push({ method: method.toUpperCase(), path: normalizePath(path) });
      }
    }
  }
  return operations;
}

/** 대조에서 면제할 항목. 테스트가 면제를 끄고 가드를 확인할 수 있도록 주입 가능하게 둔다. */
export interface DiffOptions {
  /** 문서에 없어도 되는 라우트. 기본값 `UNDOCUMENTED_ROUTES`. */
  readonly allowlist?: readonly string[];
  /** 라우트가 아직 없어도 되는 오퍼레이션. 기본값 `PENDING_OPERATIONS`. */
  readonly pending?: readonly PendingOperation[];
}

/**
 * 양방향 대조. 한쪽 방향만 보면 가드의 절반이 없는 것과 같다 —
 * "라우트 없는 오퍼레이션"만 잡으면 문서화되지 않은 새 엔드포인트가 무한히 새어 들어오고,
 * 반대만 보면 문서가 약속한 엔드포인트가 영영 안 생겨도 아무도 모른다.
 */
export function diffOperations(
  documented: readonly RouteRef[],
  routed: readonly RouteRef[],
  options: DiffOptions = {},
): DriftReport {
  const allowed = new Set(options.allowlist ?? UNDOCUMENTED_ROUTES);
  const pending = options.pending ?? PENDING_OPERATIONS;
  const pendingKeys = new Set(pending.map((entry) => entry.key));

  const documentedKeys = new Set(documented.map(routeKey));
  const routedKeys = new Set(routed.map(routeKey));

  return {
    documentedButNotRouted: [...documentedKeys]
      .filter((key) => !routedKeys.has(key) && !pendingKeys.has(key))
      .sort(),
    routedButNotDocumented: [...routedKeys]
      .filter((key) => !documentedKeys.has(key) && !allowed.has(key))
      .sort(),
    // 유예해 둔 오퍼레이션의 라우트가 실제로 생겼다 → 유예 항목을 지울 때가 됐다.
    stalePending: pending
      .filter((entry) => routedKeys.has(entry.key))
      .map((entry) => `${entry.key} (${entry.task} 완료됨 — PENDING_OPERATIONS에서 지워라)`)
      .sort(),
  };
}

/**
 * Fastify가 실제로 가진 라우트를 수집한다. `onRoute`는 **훅을 단 뒤에 등록된** 라우트만
 * 통지하므로 `createApp`이 인스턴스를 만든 직후 가장 먼저 불러야 한다.
 *
 * 돌려주는 배열은 라우트가 등록되면서 채워지는 **살아 있는 참조**다.
 *
 * `HEAD`는 담지 않는다. Fastify가 `exposeHeadRoutes` 기본값으로 모든 GET에 HEAD를 자동으로
 * 붙이는데, OpenAPI는 그 파생 오퍼레이션을 모델링하지 않는다. 담으면 GET 라우트 수만큼
 * 영구 오탐이 생긴다 — 우리가 쓴 적 없는 라우트로 가드가 실패하는 것이다.
 */
export function trackRoutes(app: FastifyInstance): RouteRef[] {
  const routes: RouteRef[] = [];
  app.addHook("onRoute", (route) => {
    const methods = Array.isArray(route.method) ? route.method : [route.method];
    for (const method of methods) {
      if (method.toUpperCase() === "HEAD") continue;
      routes.push({ method: method.toUpperCase(), path: normalizePath(route.url) });
    }
  });
  return routes;
}

/**
 * 생성된 문서를 **그대로** 내보낸다. 이 핸들러에는 문서를 손보는 코드가 한 줄도 없어야 한다 —
 * 필드를 덧붙이거나 걸러내는 순간 04:29의 "수기 작성 금지"를 우회하는 사본이 생긴다.
 *
 * 문서는 순수 생성물이라 등록 시점에 한 번만 만든다.
 *
 * ## 인증: Bearer를 **요구한다** (`PUBLIC_PATHS`에 넣지 않는다)
 *
 * specs/04:3이 "Base: `/v1`. 인증: `Authorization: Bearer <key>`"라고 열고,
 * 표에서 인증 불요인 유일한 엔드포인트 `/health`는 **`/v1` 밖에** 놓여 있다(`/v1/health`가 아니다).
 * 그 배치가 규약이다: `/v1` 아래 = 인증 필요, 공개 표면은 `/v1` 밖.
 * `contracts/src/openapi.ts`도 같은 규약을 코드로 박아 뒀다 — 모든 `/v1` 오퍼레이션에 `secured`,
 * `/health`에만 `security: []`.
 *
 * 이 경로를 `PUBLIC_PATHS`에 넣으면 `PUBLIC_PATHS`가 처음으로 `/v1` 경로를 담게 되어
 * "공개 ⇔ `/v1` 밖"이라는 불변식이 깨진다. NFR-04("모든 외부 표면 Bearer 인증")도 같은 쪽을 가리킨다.
 * 문서를 공개하고 싶다면 그건 `/openapi.json`으로 **스펙을 고칠** 일이지 여기서 정할 일이 아니다.
 */
export function registerOpenApiRoute(app: FastifyInstance): void {
  const document = buildOpenApiDocument();
  app.get(OPENAPI_ROUTE, async (_request, reply) => reply.send(document));
}
