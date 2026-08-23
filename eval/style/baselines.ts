/**
 * `eval/baselines.json`의 `style` 절 읽기. **읽기 전용이다 — 쓰기 경로가 없다.**
 *
 * `eval/injection/baselines.ts`와 같은 규약이고 같은 이유다: CLAUDE.md 금지 사항
 * "eval 기준선을 낮추는 커밋", eval-runner 스킬 "기준선 하향은 사람이 결정한다".
 * 그 규칙을 주석이 아니라 **모듈 표면**으로 강제한다 — 파일을 여는 함수가 하나뿐이고
 * `readFile`밖에 부르지 않는다.
 *
 * ## ⚠️ 지금 `eval/baselines.json`에 `style` 절이 **없다** — 이 태스크가 쓰지 않았다
 *
 * T-034 Scope는 "baselines에 상한 추가(판별 정확도 <= 0.7에서 시작)"라고 적었고,
 * 이 태스크의 오케스트레이터 지시는 "**`eval/baselines.json`에 목표를 새로 쓰지 마라.
 * 측정 없이 쓴 숫자는 거짓이다**"였다. 둘이 문면에서 충돌한다.
 * task-loop SKILL "중단 사유"의 마지막 항목이 정확히 이 경우이고, 규약은 **고르지 말고
 * 멈춰 보고하라**이다. 그래서 숫자를 쓰지 않았고, 대신 없을 때 **조용히 통과하지 않도록**
 * 여기서 죽게 만들었다. 사람이 결정해 한 줄 추가하면 이 러너는 그때부터 판정한다:
 *
 * ```json
 * "style": { "discriminationAccuracy": 0.7 }
 * ```
 *
 * 파일 전체가 아니라 `style` 절만 검증한다(`.strict()`를 안 건다) —
 * 다른 절은 다른 태스크의 소유물이다.
 */
import { readFile } from "node:fs/promises";

import { z } from "zod";

import { StyleBaselines } from "./report.js";

export const StyleBaselinesFile = z.object({ style: StyleBaselines });
export type StyleBaselinesFile = z.infer<typeof StyleBaselinesFile>;

/** 레포 루트 기준 경로. 에러 메시지가 사람에게 이 문자열을 그대로 보여 준다. */
export const BASELINES_PATH = "eval/baselines.json";

/** `eval/style/` 기준 상대 위치. `import.meta.url`로 잡아 cwd에 의존하지 않는다. */
export const BASELINES_URL = new URL("../baselines.json", import.meta.url);

/** 기준선을 읽을 수 없다. CLI가 78(EX_CONFIG)로 옮긴다. */
export class StyleBaselineMissingError extends Error {
  constructor(message: string, cause?: unknown) {
    super(message, cause === undefined ? undefined : { cause });
    this.name = "StyleBaselineMissingError";
  }
}

export function parseStyleBaselines(raw: unknown): StyleBaselinesFile {
  const parsed = StyleBaselinesFile.safeParse(raw);
  if (!parsed.success) {
    throw new StyleBaselineMissingError(
      `${BASELINES_PATH}에 \`style\` 기준선이 없거나 형식이 틀렸다: ${JSON.stringify(parsed.error.issues)}\n` +
        "specs/08 §6은 판별 정확도를 **상한**으로 다루고 T-034 Scope는 0.7에서 시작하라고 적었다. " +
        "그 값은 이 러너가 한 번도 측정한 적 없는 수이므로 태스크가 스스로 써 넣지 않았다 " +
        "(eval/style/baselines.ts 서두의 충돌 기록 참조). 사람이 결정해서 다음 한 줄을 넣어라:\n" +
        '  "style": { "discriminationAccuracy": 0.7 }',
    );
  }
  return parsed.data;
}

export async function readStyleBaselines(url: URL = BASELINES_URL): Promise<StyleBaselinesFile> {
  const raw: unknown = JSON.parse(await readFile(url, "utf8"));
  return parseStyleBaselines(raw);
}
