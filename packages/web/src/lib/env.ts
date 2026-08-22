/**
 * 웹이 core-api를 부르기 위한 서버 전용 설정.
 * 출처: specs/01(web → core-api 내부 HTTP), specs/04(Bearer 인증), NFR-04.
 *
 * 변수 이름에 `NEXT_PUBLIC_` 접두사를 절대 쓰지 않는다. Next.js는 그 접두사가 붙은
 * 값만 클라이언트 번들에 인라인하므로, 접두사를 붙이는 순간 API 키가 브라우저로 샌다.
 * `client-safety.spec.ts`가 이 규칙을 소스 스캔으로 강제한다.
 */

/** core-api 접속 설정. 키는 서버 프로세스 밖으로 나가지 않는다. */
export interface CoreApiConfig {
  readonly baseUrl: string;
  readonly apiKey: string;
}

/** `.env.example`의 `CORE_API_PORT=3001`에 대응하는 로컬 폴백. */
const DEFAULT_BASE_URL = "http://localhost:3001";

export const CORE_API_URL_ENV = "CORE_API_URL";
export const CORE_API_KEY_ENV = "CORE_API_KEY";

/**
 * 환경변수에서 core-api 설정을 읽는다.
 *
 * 키가 없으면 던진다 — 조용히 익명 요청을 보내면 core-api가 401을 돌려주고,
 * 그 401은 화면에서 "검색 결과 없음"과 구분되지 않는다. 설정 오류는 설정 오류로 보여야 한다.
 */
export function readCoreApiConfig(
  env: Record<string, string | undefined> = process.env,
): CoreApiConfig {
  const apiKey = env[CORE_API_KEY_ENV]?.trim();
  if (apiKey === undefined || apiKey === "") {
    throw new Error(
      `${CORE_API_KEY_ENV}가 설정되지 않았다 — core-api는 Bearer 인증을 요구한다 (specs/04, NFR-04).`,
    );
  }

  const rawBaseUrl = env[CORE_API_URL_ENV]?.trim();
  const baseUrl = rawBaseUrl === undefined || rawBaseUrl === "" ? DEFAULT_BASE_URL : rawBaseUrl;

  return { baseUrl: baseUrl.replace(/\/+$/, ""), apiKey };
}
