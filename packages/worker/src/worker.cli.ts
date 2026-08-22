/**
 * `pnpm --filter @sentinel/worker dev` 진입점 — 임베딩 잡 소비 프로세스.
 *
 * 이 파일이 존재하는 이유 하나: **부팅 시 embedder를 1회 생성해 fail-fast로 만드는 것**(T-006 인계).
 * 설정 오류는 `createEmbedder` 생성 시점에 던져진다. 잡마다 생성하면 오설정이 큐 전체를
 * `attempts++ → dead`로 조용히 태우지만, 여기서 만들면 프로세스가 첫 잡을 집기도 전에 죽는다.
 *
 * src에 두는 이유는 `ensure-indexes.cli.ts`와 같다 — tsconfig `include`가 `src`뿐이라
 * 밖에 두면 `pnpm typecheck`가 이 파일을 검사하지 않는다.
 */
import { createEmbedder, EmbedderError } from "@sentinel/core";
import { closeDb, DbConnectionError, getDb } from "@sentinel/core/db";

import { createEmbedWorker, type JobOutcome } from "./worker.js";

const EXIT_CONFIG_ERROR = 78; // EX_CONFIG (sysexits.h) — env 오설정
const EXIT_UNAVAILABLE = 69; // EX_UNAVAILABLE (sysexits.h) — DB에 닿지 못함
const EXIT_FAILURE = 1;

/** SIGTERM/SIGINT를 기다린다. compose·systemd가 보내는 종료 신호가 유일한 정상 종료 경로다. */
function waitForShutdownSignal(): Promise<NodeJS.Signals> {
  return new Promise((resolve) => {
    for (const signal of ["SIGTERM", "SIGINT"] as const) {
      process.once(signal, () => {
        resolve(signal);
      });
    }
  });
}

function logOutcome(outcome: JobOutcome): void {
  if (outcome.status === "done") {
    console.log(
      `[worker] job=${outcome.jobId} record=${outcome.recordId} done ` +
        `chunks=${String(outcome.chunkCount)} orphansDeleted=${String(outcome.deletedOrphans)}`,
    );
    return;
  }
  console.error(
    `[worker] job=${outcome.jobId} record=${outcome.recordId} ${outcome.status} ` +
      `attempts=${String(outcome.attempts)} ${outcome.error ?? ""}`,
  );
}

async function main(): Promise<void> {
  // 순서가 중요하다: 오설정으로 죽을 거라면 DB 커넥션을 잡기 전에 죽는 편이 낫다.
  const embedder = createEmbedder();
  const db = await getDb();

  const worker = createEmbedWorker({
    db,
    embedder,
    onOutcome: logOutcome,
    onError: (error) => {
      console.error("[worker] QUEUE_POLL_FAILED:", error);
    },
  });

  console.log(`[worker] 시작 — embeddingVersion=${String(embedder.version)}`);
  const loop = worker.start();
  const signal = await waitForShutdownSignal();

  // 진행 중 잡이 끝날 때까지 기다린다. 여기서 즉시 죽으면 클레임한 잡이 running으로 남아
  // 아무도 되살리지 않는 좀비가 된다(T-003 F-3).
  console.log(`[worker] ${signal} 수신 — 진행 중 잡을 마치고 종료한다`);
  await worker.stop();
  await loop;
  console.log("[worker] 종료");
}

try {
  await main();
} catch (error) {
  if (error instanceof EmbedderError) {
    console.error(`[worker] ${error.code}: ${error.message}`);
    process.exitCode = EXIT_CONFIG_ERROR;
  } else if (error instanceof DbConnectionError) {
    console.error(`[worker] ${error.code}: ${error.message}`);
    process.exitCode = error.code === "DB_CONNECTION_FAILED" ? EXIT_UNAVAILABLE : EXIT_CONFIG_ERROR;
  } else {
    console.error("[worker] WORKER_FAILED:", error);
    process.exitCode = EXIT_FAILURE;
  }
} finally {
  await closeDb();
}
