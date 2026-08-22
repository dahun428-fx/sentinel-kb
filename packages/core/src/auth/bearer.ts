/**
 * `Authorization: Bearer <key>` 헤더 값에서 키를 뽑는다. **여기가 유일한 구현이다** (T-037).
 *
 * 이름에 "Bearer"가 들어가지만 이 함수가 아는 것은 **문자열 하나의 모양**뿐이다 —
 * 요청도, 응답도, 상태 코드도 모른다. 헤더를 어디서 꺼내오고 실패를 401로 바꿀지는
 * 전송(`api`의 `resolveProject`, `mcp`의 `resolveAuth`)이 정한다.
 * 그래서 `parseApiKeys`와 같은 이유로 core에 있다 (specs/01의 의존 방향, T-014 F-1).
 */

/** 스킴 이름은 대소문자를 가리지 않는다(RFC 7235). 값이 없거나 모양이 다르면 `undefined`. */
export function extractBearerKey(header: string | undefined): string | undefined {
  if (header === undefined) return undefined;
  const match = /^Bearer[ \t]+(\S+)$/i.exec(header.trim());
  return match?.[1];
}
