/**
 * 재임베딩 잡 투입 (T-053, P1 리뷰 C1). specs/03 §1-4가 "회수는 백필 도구의 몫이며 아직 없다"고 적은 그 도구다.
 *
 * `EMBEDDING_VERSION`을 올리면 기존 레코드는 새 세대 청크가 없어 두 검색 경로(`embeddingVersion` 필터)에서
 * 사라진다. 워터마크(`records.embeddingVersion`)가 새 버전보다 낮은 published 레코드마다 embed 잡을 넣는다.
 * 이미 `pending`·`running` 잡이 있는 레코드는 건너뛴다 — 넣어도 인제스트가 멱등이라 해는 없지만 큐만 불어난다.
 */
import type { Db, ObjectId } from "mongodb";

import type { JobDocument } from "./jobs.js";

export async function enqueueReembedJobs(db: Db, version: number, now: Date): Promise<number> {
  const stale = await db
    .collection<{ _id: ObjectId }>("records")
    .find({ status: "published", embeddingVersion: { $lt: version } }, { projection: { _id: 1 } })
    .toArray();
  if (stale.length === 0) return 0;

  const queued = new Set(
    (
      await db
        .collection<JobDocument>("jobs")
        .find(
          { type: "embed", status: { $in: ["pending", "running"] }, recordId: { $in: stale.map((r) => r._id) } },
          { projection: { recordId: 1 } },
        )
        .toArray()
    ).map((job) => job.recordId.toHexString()),
  );

  const jobs: Omit<JobDocument, "_id">[] = stale
    .filter((record) => !queued.has(record._id.toHexString()))
    .map((record) => ({
      type: "embed",
      recordId: record._id,
      status: "pending",
      attempts: 0,
      createdAt: now,
      updatedAt: now,
    }));
  if (jobs.length === 0) return 0;
  await db.collection<Omit<JobDocument, "_id">>("jobs").insertMany(jobs);
  return jobs.length;
}
