/**
 * jobs 컬렉션 스키마 — 인제스트 워커의 작업 큐.
 *
 * 출처: specs/02-data-model.md(jobs 블록 — T-003에서 추가), specs/03-rag-pipeline.md §1,
 * docs/design/DB-DESIGN.md:69(status 열거), docs/design/DB-DESIGN.md:47(JOB 엔터티).
 *
 * specs/02는 원래 jobs의 **인덱스만** 명시하고 도큐먼트 형상을 정의하지 않았다(T-002 F-3).
 * 형상 없이는 T-008의 원자적 클레임·재시도 로직을 계약으로 잠글 수 없어 여기서 정의한다.
 */
import { z } from "zod";

import { ObjectIdString } from "./common.js";

/**
 * 작업 상태. docs/design/DB-DESIGN.md:69 "pending/running/failed/dead/done"이 근거다.
 * `dead`는 재시도를 포기한 종착 상태 — specs/03 §1-4의 "3회 초과면 dead".
 */
export const JobStatus = z.enum(["pending", "running", "failed", "dead", "done"]);
export type JobStatus = z.infer<typeof JobStatus>;

/**
 * 작업 종류. specs/03 §1-1이 정의한 `{type:"embed", recordId}` 하나뿐이다.
 * 스펙 근거 없이 종류를 늘리지 않는다 — 워커 분기가 계약보다 먼저 자라면 안 된다.
 */
export const JobType = z.literal("embed");
export type JobType = z.infer<typeof JobType>;

/**
 * 큐에 저장된 작업. `attempts`는 specs/03 §1-4("실패 시 attempts++, 3회 초과면 dead")가
 * 요구하는 필드이고, `lastError`는 dead 판정 후 원인을 추적하기 위한 진단 정보다.
 */
export const JobSchema = z
  .object({
    _id: ObjectIdString,
    type: JobType,
    recordId: ObjectIdString,
    status: JobStatus,
    attempts: z.number().int().nonnegative(),
    lastError: z.string().max(2000).optional(),
    createdAt: z.date(),
    updatedAt: z.date(),
  })
  .strict();
export type JobSchema = z.infer<typeof JobSchema>;
