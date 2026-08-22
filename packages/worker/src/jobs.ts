/**
 * `jobs` 큐 접근 계층 — 원자적 클레임과 종료 처리.
 * 출처: specs/02-data-model.md(jobs), specs/03-rag-pipeline.md §1-4, specs/01(큐 결정).
 *
 * 상태 기계(specs/02 jobs.status):
 * ```
 *   pending ──claim──▶ running ──성공──▶ done
 *                         │
 *                         ├─ 일시 실패, attempts < max ──▶ pending   (재큐잉)
 *                         ├─ 일시 실패, attempts >= max ─▶ dead      (재시도 소진)
 *                         └─ 영구 실패 ─────────────────▶ failed    (재시도 무의미)
 * ```
 * **`failed`와 `dead`를 구분해 쓴다.** specs/02는 `dead`를 "재시도를 포기한 종착 상태
 * (specs/03 §1-4의 '3회 초과면 dead')"로 정의한다 — 즉 dead는 **소진**의 뜻이다.
 * 영구 실패는 소진된 적이 없으므로 `failed`에 남긴다. 둘 다 폴링 대상이 아니라 종착이며,
 * `lastError`로 원인이 갈린다. (specs/02가 T-008에 넘긴 "재큐잉 주체" 미정의 항목의 결론:
 * **재큐잉 주체는 워커 자신**이고, 재큐잉은 `running → pending`으로만 일어난다.
 * `failed`를 되살리는 주체는 여전히 없다 — 사람이 판단할 일이라 자동화하지 않았다. Findings 참조.)
 */
import type { JobSchema, JobStatus } from "@sentinel/contracts";
import type { Db, ObjectId } from "mongodb";

import { describeError, isPermanentFailure } from "./errors.js";

/**
 * 저장된 잡 도큐먼트. contracts의 `JobSchema`에서 파생한다 — 형상을 다시 적지 않는다(CLAUDE.md).
 * 다른 점은 식별자 표현뿐이다: contracts는 DB를 모르므로 24자 hex 문자열, DB는 `ObjectId`다.
 */
export type JobDocument = Omit<JobSchema, "_id" | "recordId"> & {
  _id: ObjectId;
  recordId: ObjectId;
};

/** `jobs.lastError`의 계약 상한(contracts `z.string().max(2000)`). 넘기면 잡 갱신이 스키마를 위반한다. */
const LAST_ERROR_MAX_CHARS = 2000;

function jobs(db: Db) {
  return db.collection<JobDocument>("jobs");
}

/**
 * pending 잡 하나를 **원자적으로** 집어 running으로 바꾼다.
 *
 * `findOneAndUpdate`는 도큐먼트 단위 원자 연산이다. `find` 후 `update`로 나누면 두 워커가
 * 같은 잡을 집어 같은 record를 두 번 임베딩한다(비용 2배 + 중복 upsert 경합).
 *
 * `sort: {createdAt: 1}`은 **오름차순이어야 한다.** 내림차순이면 최신 잡 우선 LIFO가 되어
 * 유입이 꾸준할 때 오래된 pending이 영원히 기아 상태가 된다. 이 정렬과 필터는
 * `{status:1, createdAt:1}` 인덱스(T-003 `jobs_status_createdAt`)를 그대로 탄다.
 *
 * 백오프 조건이 없으면 **재시도가 무의미하다** — 실패 즉시 pending으로 돌아간 잡이
 * `createdAt` 최선두라 곧바로 다시 집혀, 10초짜리 순단이 밀리초 안에 attempts를 태운다.
 *
 * `type: "embed"`까지 거는 이유: 큐는 컬렉션 하나를 공유한다. 종류가 늘어나면(스펙 선행 필요,
 * specs/02) 임베딩 워커가 남의 잡을 집어 running으로 잠근 채 영구 실패시키는 사고가 난다.
 */
export async function claimNextJob(
  db: Db,
  now: Date,
  backoffBaseMs: number,
): Promise<JobDocument | null> {
  // 백오프: `attempts`번 실패한 잡은 `updatedAt`이 충분히 오래돼야 다시 집힌다.
  // `$expr`로 도큐먼트마다 다른 임계를 계산한다 — 새 필드 없이(`.strict()`) 지연 재시도를 만든다.
  return jobs(db).findOneAndUpdate(
    {
      status: "pending",
      type: "embed",
      $expr: {
        $lte: [
          {
            $add: [
              "$updatedAt",
              {
                $cond: [
                  { $lte: ["$attempts", 0] },
                  0,
                  { $multiply: [backoffBaseMs, { $pow: [2, { $subtract: ["$attempts", 1] }] }] },
                ],
              },
            ],
          },
          now,
        ],
      },
    },
    { $set: { status: "running", updatedAt: now } },
    { sort: { createdAt: 1 }, returnDocument: "after" },
  );
}

/** 성공 종료. 이전 시도의 `lastError`는 지운다 — 성공한 잡에 남아 있으면 진단을 오도한다. */
export async function completeJob(db: Db, jobId: ObjectId, now: Date): Promise<void> {
  await jobs(db).updateOne(
    { _id: jobId },
    { $set: { status: "done", updatedAt: now }, $unset: { lastError: "" } },
  );
}

export interface JobFailure {
  readonly status: JobStatus;
  readonly attempts: number;
  readonly lastError: string;
}

/**
 * 실패 처리. specs/03 §1-4: "실패 시 job은 `failed`+attempts++, 3회 초과면 `dead`.
 * **record 저장 자체는 롤백하지 않는다.**" — 그래서 여기서 건드리는 컬렉션은 `jobs` 하나뿐이다.
 * 이미 커밋된 청크도 지우지 않는다(다음 시도가 같은 유니크 키로 덮어쓴다).
 */
export async function failJob(
  db: Db,
  job: JobDocument,
  error: unknown,
  maxAttempts: number,
  now: Date,
): Promise<JobFailure> {
  const attempts = job.attempts + 1;
  const status: JobStatus = isPermanentFailure(error)
    ? "failed"
    : attempts >= maxAttempts
      ? "dead"
      : "pending";
  const lastError = describeError(error).slice(0, LAST_ERROR_MAX_CHARS);

  await jobs(db).updateOne(
    { _id: job._id },
    { $set: { status, attempts, lastError, updatedAt: now } },
  );

  return { status, attempts, lastError };
}
