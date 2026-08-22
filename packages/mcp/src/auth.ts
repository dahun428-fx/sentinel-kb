/**
 * MCP 표면의 Bearer 인증. 출처: specs/07-mcp.md
 * > 인증: `Authorization: Bearer <project-key>` → project 스코프 주입.
 *
 * ---
 * **T-037: 복제를 회수했다.** T-014는 `parseApiKeys`·`extractBearerKey`를 여기에
 * **복제**했다 — `mcp → api`는 형제 간선이라 specs/01의 의존 방향 위반이고
 * (`web/mcp/api/worker → core → contracts`, 형제 간 간선 없음), 공용 위치인
 * `@sentinel/core`로 올리는 것은 T-014의 Context budget 밖이었기 때문이다(T-014 F-1).
 * 그 복제가 갈라지는 것을 막던 `auth.spec.ts`의 드리프트 감시기도 함께 회수됐다 —
 * 감시할 사본이 없어졌으므로 남겨두면 **항상 참인 죽은 테스트**가 된다.
 *
 * 이제 파싱은 `@sentinel/core`에 한 벌만 있고, 여기 남은 것은 **MCP 전송 고유한 것**뿐이다:
 * 실패를 `McpAuthError`(401 + `WWW-Authenticate`)로 바꾸는 판정과, core-api로
 * 패스스루할 원본 키를 함께 돌려주는 `AuthContext`.
 *
 * 형제 간선을 막는 것은 여전히 `eslint.config.js`의 `no-restricted-paths` 형제 zone이고
 * (`packages/mcp/lint-fixtures/violation-imports-api.ts`가 발화를 잠근다), 그 규칙은
 * 그대로 남는다 — 해법이 "간선을 여는 것"이 아니라 "core로 올리는 것"이었기 때문이다.
 */
import { extractBearerKey } from "@sentinel/core";

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
