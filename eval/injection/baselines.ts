/**
 * `eval/baselines.json`의 `injection` 절 읽기. **읽기 전용이다 — 쓰기 경로가 없다.**
 *
 * `eval/retrieval/baselines.ts`와 같은 규약이고 같은 이유다: CLAUDE.md 금지 사항
 * "eval 기준선을 낮추는 커밋", eval-runner 스킬 "기준선 하향은 사람이 결정한다".
 * 그 규칙을 주석이 아니라 **모듈 표면**으로 강제한다 — 여기서 파일을 여는 함수는 하나뿐이고
 * `readFile`밖에 부르지 않는다.
 *
 * 파일 전체가 아니라 `injection` 절만 검증한다(`.strict()`를 안 건다) —
 * retrieval·generation·tools 기준선은 다른 태스크의 소유물이다.
 */
import { readFile } from "node:fs/promises";

import { z } from "zod";

import { InjectionBaselines } from "./report.js";

export const InjectionBaselinesFile = z.object({ injection: InjectionBaselines });
export type InjectionBaselinesFile = z.infer<typeof InjectionBaselinesFile>;

/** 레포 루트 기준 경로. 에러 메시지가 사람에게 이 문자열을 그대로 보여 준다. */
export const BASELINES_PATH = "eval/baselines.json";

/** `eval/injection/` 기준 상대 위치. `import.meta.url`로 잡아 cwd에 의존하지 않는다. */
export const BASELINES_URL = new URL("../baselines.json", import.meta.url);

export async function readInjectionBaselines(
  url: URL = BASELINES_URL,
): Promise<InjectionBaselinesFile> {
  const raw = await readFile(url, "utf8");
  return InjectionBaselinesFile.parse(JSON.parse(raw));
}
