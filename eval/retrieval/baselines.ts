/**
 * `eval/baselines.json` 읽기. **읽기 전용이다 — 이 모듈에는 쓰기 경로가 없다.**
 *
 * CLAUDE.md 금지 사항: "eval 기준선을 낮추는 커밋". eval-runner 스킬: "기준선 하향은 절대
 * 자동으로 하지 않는다. 사람이 결정한다. 상향도 사람 승인. 에이전트는 리포트만 낸다."
 * 그 규칙을 주석이 아니라 **모듈 표면**으로 강제한다 — 여기서 파일을 여는 함수는 하나뿐이고
 * `readFile`밖에 부르지 않는다. 기준선을 고치고 싶은 코드는 이 모듈을 쓸 수 없다.
 */
import { readFile } from "node:fs/promises";

import { z } from "zod";

import { RetrievalMetrics } from "./report.js";

/**
 * 파일 전체가 아니라 `retrieval` 절만 검증한다(`.strict()`를 안 건다).
 * generation·tools·injection 기준선과 `_comment`는 다른 태스크의 소유물이고,
 * 여기서 형상을 못박으면 그쪽이 필드를 늘릴 때 retrieval eval이 무관한 이유로 죽는다.
 */
export const BaselinesFile = z.object({
  retrieval: RetrievalMetrics,
});
export type BaselinesFile = z.infer<typeof BaselinesFile>;

/** 레포 루트 기준 경로. 리포트·에러 메시지가 사람에게 이 문자열을 그대로 보여 준다. */
export const BASELINES_PATH = "eval/baselines.json";

/** `eval/retrieval/` 기준 상대 위치. `import.meta.url`로 잡아 cwd에 의존하지 않는다. */
export const BASELINES_URL = new URL("../baselines.json", import.meta.url);

export async function readBaselines(url: URL = BASELINES_URL): Promise<BaselinesFile> {
  const raw = await readFile(url, "utf8");
  return BaselinesFile.parse(JSON.parse(raw));
}
