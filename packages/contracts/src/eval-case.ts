/**
 * eval_cases 컬렉션 스키마. 출처: specs/02-data-model.md
 */
import { z } from "zod";

import { ObjectIdString, RecordType } from "./common.js";

/**
 * eval 골든셋 항목.
 *
 * `approvedBy`는 `"human"` 리터럴이다. specs/02가 "사람 승인 없이 자동 추가 금지"를
 * 못박았으므로, 스키마 레벨에서 `"agent"`·`"auto"` 같은 자동 생성 값을 거부한다.
 * 골든셋이 오염되면 eval 루프 전체가 무의미해진다.
 */
export const EvalCaseSchema = z
  .object({
    _id: ObjectIdString,
    query: z.string().min(1),
    expectedRecordIds: z.array(ObjectIdString).min(1),
    type: RecordType.optional(),
    note: z.string().max(2000).optional(),
    approvedBy: z.literal("human"),
  })
  .strict();
export type EvalCaseSchema = z.infer<typeof EvalCaseSchema>;
