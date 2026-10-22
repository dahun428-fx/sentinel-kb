import { ObjectId } from "mongodb";
import { describe, expect, it } from "vitest";

import { mergeWithDbEvents, toDbEvents } from "./dogfood-db.js";
import type { DogfoodEvent } from "./dogfood-report.js";

const R = new ObjectId("6650a1b2c3d4e5f601020304");
const AT = new Date("2026-10-22T09:00:00.000Z");

describe("toDbEvents (T-058)", () => {
  it("records는 record 이벤트로, helped:true 피드백만 hit 이벤트로 바꾼다", () => {
    const events = toDbEvents(
      [{ _id: R, type: "divergence", createdAt: AT }],
      [
        { recordId: R, helped: true, createdAt: AT },
        { recordId: R, helped: false, createdAt: AT },
      ],
    );
    expect(events).toEqual([
      {
        ts: "2026-10-22T09:00:00.000Z",
        event: "record",
        recordId: R.toHexString(),
        type: "divergence",
      },
      { ts: "2026-10-22T09:00:00.000Z", event: "hit", recordId: R.toHexString() },
    ]);
  });

  it("since와 같은 시각은 포함하고, 이전은 뺀다", () => {
    expect(toDbEvents([{ _id: R, type: "incident", createdAt: AT }], [], AT)).toHaveLength(1);
    expect(
      toDbEvents([{ _id: R, type: "incident", createdAt: AT }], [], new Date(AT.getTime() + 1)),
    ).toEqual([]);
  });
});

describe("mergeWithDbEvents (T-058)", () => {
  it("로그의 record·hit 줄은 버리고 search만 남긴다 — 같은 동작을 두 번 세지 않는다", () => {
    const log: DogfoodEvent[] = [
      { ts: "2026-10-22T08:00:00Z", event: "search", results: 2 },
      { ts: "2026-10-22T08:10:00Z", event: "hit", recordId: R.toHexString() },
      { ts: "2026-10-22T08:20:00Z", event: "record", recordId: R.toHexString(), type: "incident" },
    ];
    const db: DogfoodEvent[] = [
      { ts: "2026-10-22T08:10:00Z", event: "hit", recordId: R.toHexString() },
    ];

    expect(mergeWithDbEvents(log, db).map((event) => event.event)).toEqual(["search", "hit"]);
  });
});
