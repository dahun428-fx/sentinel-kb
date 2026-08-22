/**
 * 컴포지션 루트가 쓰는 env 해석. **env를 읽는 유일한 지점이다**
 * (`api/src/server.ts`가 세운 선례를 그대로 따른다).
 *
 * 오설정은 첫 요청이 아니라 **부팅에서** 드러나야 한다. `API_KEYS`가 비었거나 형식이
 * 깨졌으면 `parseApiKeys`가 여기서 던지고 프로세스가 죽는다.
 *
 * ⚠️ `CORE_API_URL`·`CORE_API_TIMEOUT_MS`·`CORE_API_MAX_ATTEMPTS`·`SENTINEL_KB_KEY`는
 * 아직 `.env.example`에 없다. T-014의 Context budget이 `packages/mcp/**`라 루트 설정
 * 파일을 **수정할 수 없어서** 넣지 못했다 → Findings F-2(T-026에서 compose env와 함께 추가).
 * 그때까지는 아래 기본값이 문서 역할을 한다.
 */
import { parseApiKeys } from "@sentinel/core";

/** `.env.example`의 `MCP_PORT`. */
const DEFAULT_MCP_PORT = 3002;
/** `.env.example`의 `CORE_API_PORT`. compose에서는 `http://core-api:3001`이 된다. */
const DEFAULT_CORE_API_URL = "http://localhost:3001";

function readPositiveInt(raw: string | undefined, fallback: number): number {
  const parsed = Number(raw?.trim());
  return Number.isSafeInteger(parsed) && parsed > 0 ? parsed : fallback;
}

export interface McpConfig {
  readonly apiKeys: ReadonlyMap<string, string>;
  readonly port: number;
  readonly coreApiBaseUrl: string;
  readonly coreApiTimeoutMs: number;
  readonly coreApiMaxAttempts: number;
  /** stdio 모드 전용. HTTP 모드에서는 쓰이지 않는다(키는 요청 헤더로 온다). */
  readonly bearerKey: string | undefined;
}

export function readMcpConfig(env: NodeJS.ProcessEnv): McpConfig {
  const bearerKey = env["SENTINEL_KB_KEY"]?.trim();
  return {
    apiKeys: parseApiKeys(env["API_KEYS"]),
    port: readPositiveInt(env["MCP_PORT"], DEFAULT_MCP_PORT),
    coreApiBaseUrl: env["CORE_API_URL"]?.trim() ?? DEFAULT_CORE_API_URL,
    coreApiTimeoutMs: readPositiveInt(env["CORE_API_TIMEOUT_MS"], 10_000),
    coreApiMaxAttempts: readPositiveInt(env["CORE_API_MAX_ATTEMPTS"], 3),
    bearerKey: bearerKey === undefined || bearerKey === "" ? undefined : bearerKey,
  };
}
