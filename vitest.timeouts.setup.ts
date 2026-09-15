/**
 * 계층별 타임아웃 (T-045).
 *
 * `unit` 프로젝트는 **기본 5초를 그대로 둔다** — 순수 함수 테스트에서 타임아웃을 늘리면
 * 무한 루프·무한 대기가 "느린 테스트"로 위장한다. 그런데 같은 프로젝트 안에
 * **실 프로세스를 띄우는 파일**이 섞여 있다: `tools/*.spec.ts`(ESLint 인스턴스 다수)와
 * `**\/*.cli.spec.ts`(테스트 1건당 `node --import tsx` 부팅 한 번). 이들은 단독으로는
 * 0.x~2초지만, 고병렬 실행에서 CPU를 다투면 5초를 넘긴다 — 코드가 아니라 **스케줄러**가
 * 만든 실패다(감사 실측: 고병렬 41회 중 3회 실패).
 *
 * vitest는 프로젝트 단위로만 `testTimeout`을 받으므로, 이 계층만 떼어내려면 프로젝트를
 * 쪼개야 하고 그러면 `pnpm test`의 `--project unit` 계약이 깨진다. 대신 setup 파일이
 * **자기 테스트 파일 경로를 보고** 그 파일에만 여유를 준다. 판정 대상은 프로젝트가 아니라
 * 파일이므로, 늘어나는 범위가 목록에 그대로 드러난다.
 *
 * 늘리지 않는 것: `packages/*\/src/**\/*.spec.ts`(순수 유닛), `scripts/*.spec.ts`.
 */
import { fileURLToPath } from "node:url";

import { expect, vi } from "vitest";

/**
 * 판정은 **레포 루트 기준 상대 경로**로 한다.
 *
 * 절대 경로에 그대로 `/tools/`를 찾으면 `eval/tools/*.spec.ts`와
 * `packages/mcp/src/tools/*.spec.ts`까지 걸린다 — 프로세스를 띄우지 않는 순수 유닛
 * 13개가 덩달아 상향되고, 그게 바로 이 태스크가 하지 말라고 한 "무차별 상향"이다.
 * 루트는 cwd가 아니라 **이 파일의 위치**에서 얻는다(이 파일이 레포 루트에 있다).
 * cwd는 실행 방식에 따라 달라지지만 이 파일의 위치는 달라지지 않는다.
 */
const REPO_ROOT = fileURLToPath(new URL(".", import.meta.url)).replaceAll("\\", "/");

/** 실 프로세스를 띄우는 계층. 루트 바로 아래 `tools/`와, 어디에 있든 `*.cli.spec.ts`. */
const PROCESS_SPAWNING_LAYERS = [/^tools\/[^/]+\.spec\.ts$/u, /\.cli\.spec\.ts$/u] as const;

/**
 * 30초는 "여기까지는 정상"이 아니라 **"이보다 오래 걸리면 매달린 것"**의 경계다.
 * 이 계층의 단독 실측은 전부 2초 미만이므로 15배 이상 여유다.
 */
const PROCESS_LAYER_TIMEOUT_MS = 30_000;

const absolutePath = (expect.getState().testPath ?? "").replaceAll("\\", "/");
const relativePath = absolutePath.startsWith(REPO_ROOT)
  ? absolutePath.slice(REPO_ROOT.length)
  : absolutePath;

if (PROCESS_SPAWNING_LAYERS.some((pattern) => pattern.test(relativePath))) {
  vi.setConfig({ testTimeout: PROCESS_LAYER_TIMEOUT_MS, hookTimeout: PROCESS_LAYER_TIMEOUT_MS });
}
