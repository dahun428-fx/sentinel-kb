/**
 * 컴포지션 루트. env를 읽는 **유일한** 지점이다.
 *
 * 오설정은 첫 요청이 아니라 **부팅에서** 드러나야 한다(T-006 인계 패턴). `API_KEYS`가 비었거나
 * 형식이 깨졌으면 `parseApiKeys`가 여기서 던지고 프로세스가 죽는다 — 빈 맵으로 부팅해
 * 모든 요청을 401로 돌려주는 서버는 원인을 어디에도 남기지 않는다.
 */
import { readSanitizeOptions, VERSION } from "@sentinel/core";
import { closeDb, getDb } from "@sentinel/core/db";

import { createApp } from "./app.js";
import { parseApiKeys } from "./auth.js";

/** `.env.example`의 `CORE_API_PORT`. 스펙에 있는 값이라 코드에 기본값을 박지 않고 여기서만 폴백한다. */
const DEFAULT_PORT = 3001;

function readPort(raw: string | undefined): number {
  const parsed = Number(raw?.trim());
  return Number.isSafeInteger(parsed) && parsed > 0 ? parsed : DEFAULT_PORT;
}

/**
 * `/health`가 보고할 임베딩 세대. `readEmbedderConfig()`를 부르지 않는 이유는
 * 그쪽이 `EMBEDDING_DIM`·`EMBEDDING_PROVIDER`까지 요구하며 던지기 때문이다 —
 * API는 임베딩을 하지 않으므로 그 설정이 없다고 헬스체크가 죽으면 안 된다.
 * 값이 없으면 0(미설정)으로 보고한다. `HealthResponse`가 `nonnegative()`라 계약을 만족한다.
 */
function readEmbeddingVersion(env: NodeJS.ProcessEnv): number {
  const parsed = Number(env["EMBEDDING_VERSION"]?.trim());
  return Number.isSafeInteger(parsed) && parsed >= 0 ? parsed : 0;
}

export async function start(): Promise<void> {
  const apiKeys = parseApiKeys(process.env["API_KEYS"]);
  const sanitizeOptions = readSanitizeOptions();
  const db = await getDb();

  const app = createApp({
    db,
    apiKeys,
    sanitizeOptions,
    embeddingVersion: readEmbeddingVersion(process.env),
    version: VERSION,
    logger: true,
  });

  const shutdown = async (): Promise<void> => {
    await app.close();
    await closeDb();
  };
  process.once("SIGTERM", () => void shutdown());
  process.once("SIGINT", () => void shutdown());

  await app.listen({ port: readPort(process.env["CORE_API_PORT"]), host: "0.0.0.0" });
}

// `tsx src/server.ts`로 직접 실행될 때만 뜬다. import만으로는 포트를 잡지 않는다.
if (process.argv[1]?.endsWith("server.ts") === true) {
  start().catch((error: unknown) => {
    console.error(error);
    process.exitCode = 1;
  });
}
