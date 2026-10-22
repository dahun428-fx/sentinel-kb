/**
 * `failed`·`dead` 잡 재투입 (T-054, P1 리뷰 C3). specs/03 §1-4가 "failed도 dead도 되살리는 주체가 없다"고 적은 공백이다.
 *
 * 영구 실패(`failed`)는 키 오타처럼 설정을 고치면 풀리는 경우가 대부분이고, `dead`는 일시 장애가 길었던 경우다.
 * 원인을 고친 뒤 사람이 부른다. `attempts`를 0으로 되돌린다 — 이전 횟수를 안고 시작하면 순단 한 번에 다시 `dead`가 된다.
 * `lastError`는 남긴다(진단용). 성공하면 `completeJob`이 지운다.
 */
import type { JobStatus } from "@sentinel/contracts";
import type { Db } from "mongodb";

import type { JobDocument } from "./jobs.js";

export const REQUEUEABLE_STATUSES = ["failed", "dead"] as const satisfies readonly JobStatus[];
export type RequeueableStatus = (typeof REQUEUEABLE_STATUSES)[number];

export async function requeueJobs(
  db: Db,
  statuses: readonly RequeueableStatus[],
  now: Date,
): Promise<number> {
  if (statuses.length === 0) return 0;
  const result = await db
    .collection<JobDocument>("jobs")
    .updateMany(
      { type: "embed", status: { $in: [...statuses] } },
      { $set: { status: "pending", attempts: 0, updatedAt: now } },
    );
  return result.modifiedCount;
}

/** `--status=failed,dead` 인자 해석. 없으면 둘 다. 모르는 값은 던진다. */
export function parseRequeueStatuses(argv: readonly string[]): RequeueableStatus[] {
  const arg = argv.find((value) => value.startsWith("--status="));
  if (arg === undefined) return [...REQUEUEABLE_STATUSES];
  const values = arg
    .slice("--status=".length)
    .split(",")
    .map((value) => value.trim());
  for (const value of values) {
    if (!(REQUEUEABLE_STATUSES as readonly string[]).includes(value)) {
      throw new Error(`--status는 ${REQUEUEABLE_STATUSES.join("|")} 중에서 고른다: ${value}`);
    }
  }
  return values as RequeueableStatus[];
}
