/**
 * `pnpm --filter @sentinel/worker requeue [--status=failed,dead]` — 원인을 고친 뒤 실패한 embed 잡을 다시 넣는다 (T-054).
 */
import { closeDb, getDb } from "@sentinel/core/db";

import { parseRequeueStatuses, requeueJobs } from "./requeue.js";

try {
  const statuses = parseRequeueStatuses(process.argv.slice(2));
  const db = await getDb();
  const count = await requeueJobs(db, statuses, new Date());
  console.log(`[requeue] ${statuses.join(",")} 잡 ${String(count)}건을 pending으로 되돌렸다`);
} catch (error) {
  console.error(`[requeue] ${error instanceof Error ? error.message : String(error)}`);
  process.exitCode = 1;
} finally {
  await closeDb();
}
