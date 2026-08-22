/**
 * MCP 표면의 Bearer 인증. 출처: specs/07-mcp.md
 * > 인증: `Authorization: Bearer <project-key>` → project 스코프 주입.
 *
 * ---
 * **왜 `@sentinel/api`의 `parseApiKeys`를 재사용하지 않는가 (T-014 D-3).**
 *
 * 같은 로직이 `packages/api/src/auth.ts`에 이미 있다. 그것을 import하면
 * `mcp → api` 간선이 생기는데, specs/01-architecture.md의 의존 방향은
 * `web/mcp/api → core → contracts`다. mcp와 api는 **형제**이고 형제 간 import는 역행이다.
 * **툴체인이 막아 주지는 않는다.** 처음에는 `tsc -b` 프로젝트 참조가 이 간선을 강제로
 * 드러낸다고 적었지만 T-014 검증에서 반증됐다 — `packages/mcp/tsconfig.json`에 `../api`
 * 참조를 넣지 않고 `import { PUBLIC_PATHS } from "@sentinel/api"`를 써도 `tsc -b`도
 * eslint도 통과했고 런타임도 정상이었다(pnpm 워크스페이스가 이미 해석해 준다).
 * 그래서 `eslint.config.js`에 형제 간선을 막는 `no-restricted-paths` zone을 넣었다.
 * 이 규칙이 지금 그 자리를 지킨다(`packages/mcp/lint-fixtures/violation-imports-api.ts`가
 * 실제 발화를 잠근다). 복제의 근거는 **툴체인이 아니라 specs/01의 의존 방향** 그 자체다.
 *
 * 올바른 최종 해법은 이 순수 문자열 파싱을 `@sentinel/core`로 올리는 것이다
 * (core는 HTTP를 모르지만 `API_KEYS` 문자열 파싱은 HTTP가 아니다). 그런데 그건
 * `packages/api`·`packages/core`를 **수정**해야 하고 T-014의 Context budget
 * (`packages/mcp/**`) 밖이라 이 태스크에서는 할 수 없다 → Findings F-1.
 *
 * 그래서 **복제**하되, 갈라지는 것을 방치하지 않는다: `auth.spec.ts`의 드리프트
 * 트립와이어가 두 파일의 파싱 함수 본문을 주석·공백만 지운 뒤 **직접 대조**한다.
 * 한쪽만 바뀌면 테스트가 죽고, 사람이 사본을 맞추거나 F-1을 실행하도록 강제된다.
 *
 * 고정 다이제스트는 **명시적으로 기각했다**(F-1) — 사본을 고친 사람이 상수만 갱신하고
 * 넘어가도 통과하므로 **가드를 끄는 것이 고치는 것보다 쉬워진다.** 대조에는 그 우회로가 없다.
 *
 * 규칙 자체는 원본과 **한 글자도 다르지 않게** 유지한다. 애매한 입력은 추측하지 않고 던진다 —
 * 인증 설정에서 조용한 폴백은 "아무 키도 안 통하는 서버" 아니면 "엉뚱한 project로 쓰이는
 * 레코드" 둘 중 하나가 된다.
 */

/** `API_KEYS` 형식이 깨졌을 때. 부팅을 멈추는 것이 목적이라 코드를 붙여 던진다. */
export class ApiKeyConfigError extends Error {
  readonly code = "API_KEYS_INVALID";

  constructor(message: string) {
    super(message);
    this.name = "ApiKeyConfigError";
  }
}

/**
 * 인증 실패. **메시지에 토큰을 절대 싣지 않는다** — 이 에러는 401 응답 본문과
 * 로그 양쪽으로 나가는 값이라, 여기 토큰이 들어가면 그대로 유출 경로가 된다
 * (T-012가 `/v1/search` 로그에서 원문 쿼리를 뺀 것과 같은 이유).
 */
export class McpAuthError extends Error {
  readonly code = "UNAUTHORIZED";
  readonly statusCode = 401;

  constructor(message: string) {
    super(message);
    this.name = "McpAuthError";
  }
}

/**
 * `API_KEYS=<key>:<projectSlug>,<key>:<project>`를 키→project 맵으로 파싱한다.
 *
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
export function extractBearerKey(header: string | undefined): string | undefined {
  if (header === undefined) return undefined;
  const match = /^Bearer[ \t]+(\S+)$/i.exec(header.trim());
  return match?.[1];
}

/**
 * 요청의 project 클레임을 해석한다. 실패하면 `McpAuthError`를 던진다.
 *
 * 실패 이유(헤더 없음 / 형식 오류 / 미등록 키)를 **응답에서 구분하지 않는다.**
 * 구분하면 "이 키는 형식은 맞는데 등록이 안 됐다"가 키 유효성 오라클이 된다.
 *
 * 반환값은 `{project, key}`다. `key`가 필요한 이유는 MCP가 core-api를 부를 때
 * **호출자의 토큰을 그대로 전달**하기 때문이다(T-014 D-5) — MCP가 별도 서비스 키를
 * 들면 쓰기 요청의 project가 core-api에서 MCP 자신의 것으로 해석되는 confused deputy가 된다.
 */
export interface AuthContext {
  /** 인증 키에서 해석한 project 클레임. **클라이언트가 준 값은 어디서도 쓰지 않는다.** */
  readonly project: string;
  /** core-api로 그대로 전달할 원본 키. 로그·에러에 실으면 안 된다. */
  readonly key: string;
}

export function resolveAuth(
  header: string | undefined,
  apiKeys: ReadonlyMap<string, string>,
): AuthContext {
  const key = extractBearerKey(header);
  const project = key === undefined ? undefined : apiKeys.get(key);
  if (key === undefined || project === undefined) {
    throw new McpAuthError("유효한 `Authorization: Bearer <key>` 헤더가 필요하다.");
  }
  return { project, key };
}
