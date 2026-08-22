/**
 * embed job 삽입. 출처: specs/03-rag-pipeline.md §1-1
 * > record가 `published`로 저장되면 `jobs`에 `{type:"embed", recordId}` 삽입 (트랜잭션 불필요, 멱등)
 * 형상: specs/02-data-model.md `jobs` 블록 = contracts `JobSchema`.
 *
 * ## `{type:"embed", recordId}`는 **약칭이지 도큐먼트가 아니다**
 * specs/03이 적은 두 필드만 넣으면 잡이 큐에 들어가긴 하지만 **워커가 영원히 집지 못한다**
 * (T-008 F-5). `packages/worker/src/jobs.ts`의 `claimNextJob` 필터가 요구하는 것은:
 *   - `status: "pending"` — 없으면 필터에 매칭되지 않는다
 *   - `type: "embed"` — 큐를 공유하므로 종류를 건다
 *   - `$expr`로 `updatedAt + backoff(attempts) <= now` — **`attempts`와 `updatedAt`이 없으면**
 *     `$add`/`$cond`가 `null`을 내고 `$lte` 비교가 false가 되어 **조용히 건너뛴다.**
 *     에러도 로그도 남지 않는다. 잡은 큐에 영원히 앉아 있고 레코드는 검색되지 않는다.
 *   - `sort: {createdAt: 1}` — 없으면 정렬 키가 결측이라 순서가 미정이 된다
 * 그래서 `JobSchema` **전형**을 넣는다. 축약하지 않는다.
 *
 * ## 언제 넣는가
 * 생성 시 `published`면 넣는다. T-002가 생성 기본값을 `published`로 정했으므로
 * **전환(draft→published)에만 걸면 대부분의 레코드가 임베딩되지 않는다.**
 * PATCH는 specs/04("본문 섹션 변경 시 재임베딩 job")대로 섹션이 바뀌었을 때, 그리고
 * draft에서 published로 올라왔을 때 넣는다.
 */
import type { JobSchema } from "@sentinel/contracts";
import type { Db, ObjectId } from "mongodb";

/**
 * 저장되는 잡 도큐먼트. **`JobSchema`에서 파생한다 — 형상을 다시 적지 않는다**(CLAUDE.md).
 *
 * 손으로 다시 적으면 안 되는 이유가 구체적이다: specs/02의 jobs 블록이 `claimedBy`·
 * `leaseExpiresAt`(크래시 좀비 회수, T-003 F-3) 추가를 예고해 뒀는데, 그때 사본은
 * **조용히 통과하고 워커가 잡을 못 집는다.** `claimNextJob`의 `$expr`가 결측 필드에
 * `null`을 내고 `$lte`가 false가 되어 **에러도 로그도 없이 건너뛰기** 때문이다.
 * 파생시켜 두면 그 순간 컴파일이 깨져 사람이 결정하게 된다.
 *
 * `_id`는 Mongo가 만들고, `recordId`는 계약의 24자 hex 대신 DB 경계의 `ObjectId`이며,
 * `lastError`는 워커만 쓴다. `status`는 삽입 시점에 항상 `pending`이다.
 */
type PendingEmbedJob = Omit<JobSchema, "_id" | "recordId" | "lastError" | "status"> & {
  readonly recordId: ObjectId;
  readonly status: "pending";
};

/**
 * 멱등성은 specs/03 §1-1이 "트랜잭션 불필요, 멱등"이라고 적은 대로 **인제스트 쪽**이 보장한다
 * (`{recordId, section, seq, embeddingVersion}` 유니크 upsert). 그래서 같은 record에 잡이
 * 두 번 들어가도 청크는 중복되지 않는다. 여기서 중복 삽입을 막지 않는 이유가 그것이다 —
 * "pending 잡이 이미 있으면 건너뛴다"로 쓰면 워커가 방금 집어 `running`으로 바꾼 직후의
 * 수정이 **재임베딩 없이 사라진다.**
 */
export async function enqueueEmbedJob(db: Db, recordId: ObjectId, now: Date): Promise<void> {
  const job: PendingEmbedJob = {
    type: "embed",
    recordId,
    status: "pending",
    attempts: 0,
    createdAt: now,
    updatedAt: now,
  };
  await db.collection<PendingEmbedJob>("jobs").insertOne(job);
}
