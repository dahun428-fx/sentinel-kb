/**
 * 야간 아티클 트리거 배치 진입점 (specs/08 §1). 1회 실행하고 종료한다 —
 * `worker.cli.ts`처럼 상주하지 않는다. §7이 "검색·기록 경로와 리소스 격리(야간 배치)"를
 * 요구하므로 스케줄러(cron)가 하루 한 번 부르는 형태가 맞다.
 *
 * src에 두는 이유는 `worker.cli.ts`와 같다 — tsconfig `include`가 `src`뿐이라
 * 밖에 두면 `pnpm typecheck`가 이 파일을 검사하지 않는다.
 *
 * **후보만 적재하고 아무것도 발행하지 않는다.** 생성·발행은 사람이 후보 목록에서 개시한다(§1).
 */
import { closeDb, DbConnectionError, getDb } from "@sentinel/core/db";

import { runArticleTriggerBatch } from "./article-batch.js";

const EXIT_CONFIG_ERROR = 78; // EX_CONFIG (sysexits.h)
const EXIT_UNAVAILABLE = 69; // EX_UNAVAILABLE (sysexits.h)
const EXIT_FAILURE = 1;

try {
  const db = await getDb();
  const result = await runArticleTriggerBatch({ db });
  console.log(
    `[article-batch] 재료=${String(result.materialCount)} 제안=${String(result.proposed)} ` +
      `신규후보=${String(result.inserted)} 기존=${String(result.skippedExisting)} ` +
      `억제=${String(result.skippedSuperseded)}`,
  );
} catch (error) {
  if (error instanceof DbConnectionError) {
    console.error(`[article-batch] ${error.code}: ${error.message}`);
    process.exitCode = error.code === "DB_CONNECTION_FAILED" ? EXIT_UNAVAILABLE : EXIT_CONFIG_ERROR;
  } else {
    console.error("[article-batch] ARTICLE_BATCH_FAILED:", error);
    process.exitCode = EXIT_FAILURE;
  }
} finally {
  await closeDb();
}
