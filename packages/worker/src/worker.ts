/**
 * 임베딩 잡 소비 루프. 출처: specs/01(큐 = Mongo jobs 컬렉션 폴링), specs/03 §1, T-008.
 *
 * **embedder는 주입받는다. 여기서 만들지 않는다.** 설정 오류는 `createEmbedder` **생성 시점**에
 * 던져지므로, 잡마다 만들면 오설정 하나가 모든 잡을 `attempts++ → dead`로 태워 큐를 조용히
 * 소각한다(T-006 인계). 생성은 프로세스 부팅 시 1회(worker.cli.ts) — 그래야 fail-fast가 된다.
 */
import type { JobStatus } from "@sentinel/contracts";
import type { Embedder } from "@sentinel/core";
import type { Db } from "mongodb";

import {
  readEmbedJobMaxAttempts,
  readEmbedPollIntervalMs,
  readEmbedRetryBackoffMs,
} from "./config.js";
import { ingestRecord } from "./ingest.js";
import { claimNextJob, completeJob, failJob, type JobDocument } from "./jobs.js";

/** 잡 1건 처리 결과. 로깅·테스트가 "무슨 일이 있었는지"를 아는 유일한 통로다. */
export interface JobOutcome {
  readonly jobId: string;
  readonly recordId: string;
  /** 처리 **후** 잡 상태. `pending`은 일시 실패 후 재큐잉됐다는 뜻이다. */
  readonly status: JobStatus;
  readonly attempts: number;
  readonly chunkCount: number;
  readonly deletedOrphans: number;
  readonly error?: string;
}

export interface EmbedWorkerDeps {
  readonly db: Db;
  /** 부팅 시 1회 생성된 embedder. 청크의 `embeddingVersion` 소스이기도 하다. */
  readonly embedder: Embedder;
  /** 기본값은 `EMBED_JOB_MAX_ATTEMPTS` env. */
  readonly maxAttempts?: number;
  /** 기본값은 `EMBED_POLL_INTERVAL_MS` env. */
  readonly pollIntervalMs?: number;
  /** 재시도 백오프 기준(ms). 실패한 잡이 즉시 다시 집히는 것을 막는다. */
  readonly retryBackoffMs?: number;
  /** 시각 주입 지점. 기본은 실제 시계. */
  readonly now?: () => Date;
  /** 잡 1건이 끝날 때마다 호출된다(성공·실패 모두). 관측용. */
  readonly onOutcome?: (outcome: JobOutcome) => void;
  /** 루프 자체가 실패했을 때(예: DB 순단) 호출된다. 루프는 죽지 않고 다음 폴링을 계속한다. */
  readonly onError?: (error: unknown) => void;
}

export interface EmbedWorker {
  /** pending 잡 하나를 집어 끝까지 처리한다. 집을 잡이 없으면 `undefined`. */
  runOnce(): Promise<JobOutcome | undefined>;
  /** 폴링 루프 시작. 반환 promise는 `stop()` 이후에야 resolve된다. */
  start(): Promise<void>;
  /** SIGTERM 경로. **진행 중 잡이 끝난 뒤** resolve되고, 새 잡은 집지 않는다. */
  stop(): Promise<void>;
}

export function createEmbedWorker(deps: EmbedWorkerDeps): EmbedWorker {
  const { db, embedder } = deps;
  const maxAttempts = deps.maxAttempts ?? readEmbedJobMaxAttempts();
  const pollIntervalMs = deps.pollIntervalMs ?? readEmbedPollIntervalMs();
  const retryBackoffMs = deps.retryBackoffMs ?? readEmbedRetryBackoffMs();
  const now = deps.now ?? ((): Date => new Date());

  let stopping = false;
  let loop: Promise<void> | undefined;
  /** 대기 중인 폴링 간격을 즉시 깨우는 핸들. SIGTERM이 최대 1초를 기다리지 않게 한다. */
  let wake: (() => void) | undefined;

  async function runOnce(): Promise<JobOutcome | undefined> {
    const job = await claimNextJob(db, now(), retryBackoffMs);
    if (job === null) return undefined;
    return processClaimedJob(job);
  }

  async function processClaimedJob(job: JobDocument): Promise<JobOutcome> {
    const base = { jobId: job._id.toHexString(), recordId: job.recordId.toHexString() };
    try {
      const result = await ingestRecord(db, job.recordId, embedder);
      await completeJob(db, job._id, now());
      return {
        ...base,
        status: "done",
        attempts: job.attempts,
        chunkCount: result.chunkCount,
        deletedOrphans: result.deletedOrphans,
      };
    } catch (error) {
      // specs/03 §1-4: record 저장은 롤백하지 않는다. 실패의 흔적은 jobs에만 남는다.
      const failure = await failJob(db, job, error, maxAttempts, now());
      return {
        ...base,
        status: failure.status,
        attempts: failure.attempts,
        chunkCount: 0,
        deletedOrphans: 0,
        error: failure.lastError,
      };
    }
  }

  /**
   * 폴링 루프. **잡 하나를 완전히 끝낸 뒤에만** 종료 플래그를 다시 본다 —
   * 클레임한 잡을 running으로 남긴 채 죽으면 아무도 되살리지 않는 좀비가 된다(T-003 F-3).
   */
  async function runLoop(): Promise<void> {
    while (!stopping) {
      try {
        const outcome = await runOnce();
        if (outcome === undefined) {
          await idle();
          continue;
        }
        deps.onOutcome?.(outcome);
      } catch (error) {
        // 여기까지 온 실패는 잡 처리가 아니라 큐 접근 자체의 실패(DB 순단 등)다.
        // 프로세스를 죽이면 재기동 폭풍이 되므로, 알리고 한 박자 쉰 뒤 계속 폴링한다.
        deps.onError?.(error);
        await idle();
      }
    }
  }

  function idle(): Promise<void> {
    return new Promise<void>((resolve) => {
      const timer = setTimeout(() => {
        wake = undefined;
        resolve();
      }, pollIntervalMs);
      wake = () => {
        clearTimeout(timer);
        wake = undefined;
        resolve();
      };
    });
  }

  function start(): Promise<void> {
    if (loop === undefined) {
      stopping = false;
      loop = runLoop();
    }
    return loop;
  }

  async function stop(): Promise<void> {
    stopping = true;
    wake?.();
    const pending = loop;
    loop = undefined;
    await pending;
  }

  return { runOnce, start, stop };
}
