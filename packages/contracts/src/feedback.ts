/**
 * feedbacks 컬렉션과 POST /v1/feedback 요청 스키마.
 * 출처: specs/02-data-model.md, specs/04-api.md
 */
import { z } from "zod";

import { ObjectIdString } from "./common.js";

/** 저장된 피드백. project는 서버가 인증 키에서 주입한다. */
export const FeedbackSchema = z
  .object({
    _id: ObjectIdString,
    recordId: ObjectIdString,
    query: z.string().min(1),
    helped: z.boolean(),
    note: z.string().max(2000).optional(),
    project: z.string().min(1),
    createdAt: z.date(),
  })
  .strict();
export type FeedbackSchema = z.infer<typeof FeedbackSchema>;

/** POST /v1/feedback 바디. specs/04 표의 `{recordId, query, helped, note?}` */
export const FeedbackRequest = z
  .object({
    recordId: ObjectIdString,
    query: z.string().min(1),
    helped: z.boolean(),
    note: z.string().max(2000).optional(),
  })
  .strict();
export type FeedbackRequest = z.infer<typeof FeedbackRequest>;
