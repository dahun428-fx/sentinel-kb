/**
 * `@sentinel/core` 인증 설정 파싱 배럴 (T-037).
 *
 * 여기 있는 것은 **판정이 아니라 파싱**이다. 401을 낼지, 어떤 예외로 낼지, 어떤 헤더를
 * 붙일지는 전송(api/mcp)이 각자 정한다 — 그쪽이 실제로 전송 고유한 지식이다.
 *
 * `./db`·`./testing`과 달리 `package.json`의 서브패스로 가르지 않는다.
 * 외부 의존이 없는 순수 문자열 처리라 메인 배럴에 실려도 안전하다(`sanitizer`와 같은 근거).
 */
export { ApiKeyConfigError, parseApiKeys } from "./api-keys.js";
export { extractBearerKey } from "./bearer.js";
