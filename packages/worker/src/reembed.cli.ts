/**
 * `pnpm --filter @sentinel/worker reembed` — 현재 `EMBEDDING_VERSION`보다 워터마크가 낮은 published 레코드에
 * embed 잡을 넣는다 (T-053). 잡은 실행 중인 워커가 처리한다.
 */
import { EmbedderError, readEmbedderConfig } from "@sentinel/core";
import { closeDb, getDb } from "@sentinel/core/db";

import { enqueueReembedJobs } from "./reembed.js";

try {
  const { version } = readEmbedderConfig();
  const db = await getDb();
  const count = await enqueueReembedJobs(db, version, new Date());
  console.log(`[reembed] embeddingVersion=${String(version)} — 잡 ${String(count)}건을 넣었다`);
} catch (error) {
  console.error(
    error instanceof EmbedderError ? `[reembed] ${error.code}: ${error.message}` : `[reembed] ${String(error)}`,
  );
  process.exitCode = error instanceof EmbedderError ? 78 : 1;
} finally {
  await closeDb();
}
