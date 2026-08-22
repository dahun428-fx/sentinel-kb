/**
 * `API_KEYS` 설정 문자열 파싱. **여기가 유일한 구현이다** (T-037).
 *
 * ---
 * ## 왜 core인가
 *
 * T-014는 이 규칙을 `packages/api`와 `packages/mcp`에 **복제**했다. `mcp → api`는 형제 간선이라
 * specs/01의 의존 방향(`web/mcp/api/worker → core → contracts`)에 어긋나고, 공용 위치인 core로
 * 올리는 것은 그 태스크의 Context budget 밖이었기 때문이다(T-014 F-1).
 *
 * `API_KEYS` 파싱은 **HTTP 지식이 아니라 문자열 파싱**이다. `Authorization` 헤더도, 상태 코드도,
 * 전송도 모른다 — 콤마로 갈린 `<key>:<projectSlug>` 목록을 맵으로 바꾸는 것이 전부다.
 * 그래서 "core는 HTTP·MCP를 모른다"를 어기지 않고 core에 놓인다. 401 판정 본체는 각 전송에
 * 그대로 남는다(`api`의 `resolveProject`, `mcp`의 `resolveAuth`) — 그쪽은 실제로 전송 고유다.
 *
 * ## 애매한 입력은 추측하지 않고 던진다
 *
 * 인증 설정에서 조용한 폴백은 "아무 키도 안 통하는 서버" 아니면 "엉뚱한 project로 쓰이는
 * 레코드" 둘 중 하나가 된다. 그래서 전부 던진다.
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
 * `API_KEYS=<key>:<projectSlug>,<key>:<project>`를 키→project 맵으로 파싱한다.
 *
 * - 값이 비었다 → 던진다. 빈 맵으로 부팅하면 모든 요청이 401이 되고 원인은 로그 어디에도 없다.
 * - 콜론이 없거나 둘 이상이다 → 던진다. `key:proj:extra`가 어느 쪽으로 갈리는지는 규약에 없다.
 * - 키나 project가 빈 문자열이다 → 던진다.
 * - 같은 키가 두 번 나왔다 → 던진다. 뒤가 이기는지 앞이 이기는지는 아무 데도 안 적혀 있다.
 *
 * 후행 콤마로 생긴 빈 조각만 건너뛴다 — `.env` 편집에서 흔하고 모호하지 않다.
 *
 * ---
 * ## 에러 메시지는 원문을 싣지 않는다 (T-037, T-014 F-1의 잔여 노출)
 *
 * 예전 문구는 문제가 된 세그먼트(`"key:proj:extra"`)와 중복된 **키 값 자체**를 메시지에 넣었다.
 * 이 메시지는 `api/src/server.ts`·`mcp/src/{http,stdio}.cli.ts`의 부팅 실패 경로에서
 * **stderr로 나가고** 컨테이너 로그 → CI 로그 → 로그 수집기로 그대로 흘러간다.
 * T-014에서는 드리프트 감시기가 두 사본의 문자 동일성을 강제해 고칠 수 없었다.
 * 복제가 사라진 지금 양쪽을 함께 고친다.
 *
 * **진단성은 인덱스로 보존한다.** 값 대신 `API_KEYS`를 콤마로 가른 **1-based 항목 번호**를
 * 말한다(빈 조각도 자리를 차지한다 — 운영자가 세는 콤마 수와 일치한다). 운영자는 몇 번째
 * 항목이 틀렸는지 알 수 있고, 로그에는 자격증명 후보 문자열이 남지 않는다.
 */
export function parseApiKeys(raw: string | undefined): ReadonlyMap<string, string> {
  const trimmed = raw?.trim();
  if (!trimmed) {
    throw new ApiKeyConfigError(
      "API_KEYS가 설정되지 않았다. `<key>:<projectSlug>` 형식을 콤마로 구분해 주입하라(.env.example 참조).",
    );
  }

  const byKey = new Map<string, string>();
  /** 키 → 그 키가 처음 나온 항목 번호. 중복 진단을 값 없이 하기 위한 것이다. */
  const firstSeenAt = new Map<string, number>();

  const segments = trimmed.split(",");
  for (let i = 0; i < segments.length; i += 1) {
    const position = i + 1;
    const entry = segments[i]?.trim() ?? "";
    if (entry === "") continue;

    const parts = entry.split(":");
    if (parts.length !== 2) {
      throw new ApiKeyConfigError(
        `API_KEYS의 ${String(position)}번째 항목 형식이 올바르지 않다(콜론이 정확히 하나여야 한다). ` +
          "`<key>:<projectSlug>` 여야 한다. 값은 로그로 새지 않도록 싣지 않는다.",
      );
    }
    const key = parts[0]?.trim() ?? "";
    const project = parts[1]?.trim() ?? "";
    if (key === "" || project === "") {
      throw new ApiKeyConfigError(
        `API_KEYS의 ${String(position)}번째 항목에 빈 키나 빈 project가 있다.`,
      );
    }
    const previous = firstSeenAt.get(key);
    if (previous !== undefined) {
      throw new ApiKeyConfigError(
        `API_KEYS의 ${String(position)}번째 항목의 키가 ${String(previous)}번째 항목과 같다. ` +
          "어느 project로 해석할지 규약이 없다.",
      );
    }
    firstSeenAt.set(key, position);
    byKey.set(key, project);
  }

  if (byKey.size === 0) {
    throw new ApiKeyConfigError("API_KEYS에 유효한 항목이 하나도 없다.");
  }
  return byKey;
}
