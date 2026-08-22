/**
 * `pnpm eval:tools`의 인자 해석. **순수 함수다** — `process`를 읽지 않는다.
 * CLI가 `process.argv`를 넘기고, 테스트는 리터럴을 넘긴다(T-013 `eval/retrieval/args.ts` 규약).
 *
 * 오타난 인자는 조용히 무시하지 않고 던진다. `--repeats 5`(등호 없음)를 무시하면 사용자는
 * 5회 반복으로 잰 줄 알고 3회로 잰 리포트를 커밋한다.
 */
import { EXPECTED_SCENARIO_COUNT } from "./scenarios.js";

/** T-016 Scope: "각 3회 반복해 안정성 측정". */
export const DEFAULT_REPEATS = 3;

/**
 * 반복 상한. 모델 호출 비용이 시나리오 수 × 반복 수로 선형 증가하고, 20 × 20 = 400회를
 * 실수로 돌리는 것을 막는다. 더 필요하면 스펙을 고치고 올려라.
 */
export const MAX_REPEATS = 20;

export interface RunArgs {
  readonly repeats: number;
  readonly expectedScenarioCount: number;
  /**
   * 오라클 selector로도 돌린다. 리포트는 `trusted:false`로 표시되고 **기준선 판정을 하지 않는다**.
   * 진단(파이프라인이 도는지, 시나리오가 계약과 맞는지)에만 쓴다. 종료 코드는 78이다.
   */
  readonly allowOracleSelector: boolean;
}

export class EvalArgsError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "EvalArgsError";
  }
}

function readPositiveInt(raw: string, flag: string): number {
  const parsed = Number(raw);
  if (!Number.isInteger(parsed) || parsed < 1) {
    throw new EvalArgsError(`${flag}는 양의 정수여야 한다(받은 값: ${raw}).`);
  }
  return parsed;
}

export const USAGE =
  "사용법: pnpm eval:tools [--repeats=3] [--expected-scenarios=20] [--allow-oracle-selector]";

export function parseRunArgs(argv: readonly string[]): RunArgs {
  let repeats = DEFAULT_REPEATS;
  let expectedScenarioCount = EXPECTED_SCENARIO_COUNT;
  let allowOracleSelector = false;

  for (const arg of argv) {
    if (arg === "--allow-oracle-selector") {
      allowOracleSelector = true;
    } else if (arg.startsWith("--repeats=")) {
      repeats = readPositiveInt(arg.slice("--repeats=".length), "--repeats");
      if (repeats > MAX_REPEATS) {
        throw new EvalArgsError(
          `--repeats는 1–${String(MAX_REPEATS)}이다. 그보다 많이 재려면 비용을 알고 스펙을 고쳐라.`,
        );
      }
    } else if (arg.startsWith("--expected-scenarios=")) {
      expectedScenarioCount = readPositiveInt(
        arg.slice("--expected-scenarios=".length),
        "--expected-scenarios",
      );
    } else {
      throw new EvalArgsError(`알 수 없는 인자: ${arg}. ${USAGE}`);
    }
  }

  return { repeats, expectedScenarioCount, allowOracleSelector };
}
