/**
 * `eval/baselines.json`의 `tools` 절 읽기. **읽기 전용이다 — 이 모듈에는 쓰기 경로가 없다.**
 *
 * CLAUDE.md 금지 사항: "eval 기준선을 낮추는 커밋". eval-runner 스킬: "기준선 하향은 절대
 * 자동으로 하지 않는다. 사람이 결정한다. 상향도 사람 승인. 에이전트는 리포트만 낸다."
 * T-013의 `eval/retrieval/baselines.ts`와 같은 규약이다 — 파일을 여는 함수는 하나뿐이고
 * `readFile`밖에 부르지 않는다. 기준선을 고치고 싶은 코드는 이 모듈을 쓸 수 없다.
 *
 * ## `tools.selectionAccuracy`는 T-016이 새로 쓴 값이 아니다
 * 커밋된 `eval/baselines.json`에 이미 `{"selectionAccuracy": 0.85}`가 있고, T-016 Acceptance 1도
 * "정확도 >= 0.85 (M3 기준선, 최종 목표 0.9)"로 그 값을 가리킨다. **이 태스크는 그 숫자를
 * 건드리지 않는다.** 목표 0.9를 지금 써 넣지 않는 이유도 같다 — 아직 한 번도 측정하지 않았고,
 * 측정 없이 쓴 기준선은 거짓이다.
 */
import { readFile } from "node:fs/promises";

import { z } from "zod";

import { ToolsMetrics } from "./report.js";

/**
 * 파일 전체가 아니라 `tools` 절만 검증한다(`.strict()`를 안 건다).
 * retrieval·generation·injection 기준선과 `_comment`는 다른 태스크의 소유물이고,
 * 여기서 형상을 못박으면 그쪽이 필드를 늘릴 때 tool-selection eval이 무관한 이유로 죽는다.
 */
export const BaselinesFile = z.object({
  tools: ToolsMetrics,
});
export type BaselinesFile = z.infer<typeof BaselinesFile>;

/** 레포 루트 기준 경로. 리포트·에러 메시지가 사람에게 이 문자열을 그대로 보여 준다. */
export const BASELINES_PATH = "eval/baselines.json";

/** `eval/tools/` 기준 상대 위치. `import.meta.url`로 잡아 cwd에 의존하지 않는다. */
export const BASELINES_URL = new URL("../baselines.json", import.meta.url);

export async function readBaselines(url: URL = BASELINES_URL): Promise<BaselinesFile> {
  const raw = await readFile(url, "utf8");
  return BaselinesFile.parse(JSON.parse(raw));
}
