/**
 * 도그푸딩 이벤트의 DB 출처 (T-058, P1 리뷰 A2).
 *
 * `give_feedback(helped:true)`은 Mongo `feedbacks`에 쓰이고 `record_knowledge`는 `records`에 쓰인다. 그런데 리포트는
 * 사람이 손으로 덧붙이는 `eval/dogfood-log.jsonl`만 셌고, mcp·api 어디에도 그 파일을 쓰는 코드가 없었다. 다른 저장소에서
 * 일하는 에이전트는 이 저장소의 파일에 쓸 수도 없다. 그래서 4주 동안 매일 피드백을 보내도 적중이 0이었다.
 *
 * 기록·적중은 DB가 정본이다. 검색은 DB가 원리적으로 모르므로(`dogfood-report.ts` 머리 주석) 로그 파일에 남는다.
 * 이 파일은 DB 행을 같은 이벤트 형상으로 바꾸는 **순수 함수**와, 그 행을 읽는 얇은 어댑터로 나뉜다.
 */
import type { Db, ObjectId } from "mongodb";

import type { DogfoodEvent, DogfoodRecordType } from "./dogfood-report.js";

export interface RecordRow {
  readonly _id: ObjectId;
  readonly type: DogfoodRecordType;
  readonly createdAt: Date;
}

export interface FeedbackRow {
  readonly recordId: ObjectId;
  readonly helped: boolean;
  readonly createdAt: Date;
}

/**
 * DB 행 → 이벤트. `since`보다 이른 행은 뺀다 — 도그푸딩 전에 일괄 적재한 기록(UPLIFT P5b)은 "기간 중 실제로
 * 기록하는 습관"이 아니다(UPLIFT Q-12). 피드백의 `createdAt`은 최초 전송 시각이다(재전송은 같은 문서를 덮는다).
 */
export function toDbEvents(
  records: readonly RecordRow[],
  feedbacks: readonly FeedbackRow[],
  since?: Date,
): DogfoodEvent[] {
  const after = (at: Date): boolean => since === undefined || at.getTime() >= since.getTime();
  return [
    ...records
      .filter((row) => after(row.createdAt))
      .map((row) => ({
        ts: row.createdAt.toISOString(),
        event: "record" as const,
        recordId: row._id.toHexString(),
        type: row.type,
      })),
    ...feedbacks
      .filter((row) => row.helped && after(row.createdAt))
      .map((row) => ({
        ts: row.createdAt.toISOString(),
        event: "hit" as const,
        recordId: row.recordId.toHexString(),
      })),
  ];
}

/**
 * 로그 이벤트와 DB 이벤트를 합친다. DB를 쓸 때 로그의 record·hit 줄은 버린다 — 같은 동작을 두 번 세지 않는다.
 * 로그에는 DB가 모르는 search만 남긴다.
 */
export function mergeWithDbEvents(
  logEvents: readonly DogfoodEvent[],
  dbEvents: readonly DogfoodEvent[],
): DogfoodEvent[] {
  return [...logEvents.filter((event) => event.event === "search"), ...dbEvents];
}

export async function loadDbEvents(db: Db, since?: Date): Promise<DogfoodEvent[]> {
  const records = await db
    .collection<RecordRow>("records")
    .find({}, { projection: { _id: 1, type: 1, createdAt: 1 } })
    .toArray();
  const feedbacks = await db
    .collection<FeedbackRow>("feedbacks")
    .find({ helped: true }, { projection: { recordId: 1, helped: 1, createdAt: 1 } })
    .toArray();
  return toDbEvents(records, feedbacks, since);
}
