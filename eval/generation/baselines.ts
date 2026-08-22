/**
 * `eval/baselines.json`의 `generation` 절 읽기. **읽기 전용이다 — 이 모듈에는 쓰기 경로가 없다.**
 *
 * CLAUDE.md 금지 사항: "eval 기준선을 낮추는 커밋". eval-runner 스킬: "기준선 하향은 절대
 * 자동으로 하지 않는다. 사람이 결정한다. 상향도 사람 승인. 에이전트는 리포트만 낸다."
 * T-013·T-016과 같은 규약이다 — 파일을 여는 함수는 하나뿐이고 `readFile`밖에 부르지 않는다.
 *
 * ## `generation` 기준선은 T-020이 새로 쓴 값이 아니다
 * 커밋된 `eval/baselines.json`에 이미
 * `{"citationRuleCheck": 1.0, "faithfulness": 4.0, "usefulness": 3.5}`가 있고,
 * specs/05가 "인용 룰체크 100% 요구"로 그 값을 가리킨다. **이 태스크는 그 숫자를 건드리지
 * 않는다.** judge 점수는 아직 한 번도 측정한 적이 없고(API 키 없음), 측정 없이 고쳐 쓴
 * 기준선은 거짓이다. 러너는 완성하되 잴 수 없으면 78로 거절한다.
 */
import { readFile } from "node:fs/promises";

import { z } from "zod";

import { GenerationMetrics } from "./report.js";

/**
 * 파일 전체가 아니라 `generation` 절만 검증한다(`.strict()`를 안 건다).
 * retrieval·tools·injection 기준선과 `_comment`는 다른 태스크의 소유물이다.
 */
export const BaselinesFile = z.object({
  generation: GenerationMetrics,
});
export type BaselinesFile = z.infer<typeof BaselinesFile>;

/** 레포 루트 기준 경로. 리포트·에러 메시지가 사람에게 이 문자열을 그대로 보여 준다. */
export const BASELINES_PATH = "eval/baselines.json";

/** `eval/generation/` 기준 상대 위치. `import.meta.url`로 잡아 cwd에 의존하지 않는다. */
export const BASELINES_URL = new URL("../baselines.json", import.meta.url);

export async function readBaselines(url: URL = BASELINES_URL): Promise<BaselinesFile> {
  const raw = await readFile(url, "utf8");
  return BaselinesFile.parse(JSON.parse(raw));
}
