/**
 * `pnpm eval:generation`의 인자·env 해석. **순수 함수다** — `process`를 읽지 않는다.
 * CLI가 `process.argv`·`process.env`를 넘기고, 테스트는 리터럴을 넘긴다
 * (T-013 `eval/retrieval/args.ts`, T-016 `eval/tools/args.ts` 규약).
 *
 * 오타난 인자는 조용히 무시하지 않고 던진다. `--expected-cases 15`(등호 없음)를 무시하면
 * 사용자는 15로 잰 줄 알고 기본값으로 잰 리포트를 커밋한다.
 */
import { EXPECTED_CASE_COUNT } from "./cases.js";

export const DEFAULT_EVAL_PROJECT = "sentinel-kb";
export const DEFAULT_CORE_API_PORT = 3001;

export interface RunArgs {
  readonly project: string;
  readonly baseUrl: string;
  readonly expectedCaseCount: number;
  /**
   * 실제 judge 없이 픽스처로 돌린다. 리포트는 `trusted:false`로 표시되고
   * **기준선 판정을 하지 않는다**. 진단(파이프라인이 도는지)에만 쓴다. 종료 코드는 78이다.
   */
  readonly allowFixtureJudge: boolean;
}

export class EvalArgsError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "EvalArgsError";
  }
}

export const USAGE =
  "사용법: pnpm eval:generation [--project=<slug>] [--base-url=<url>] " +
  "[--expected-cases=15] [--allow-fixture-judge]";

function readPositiveInt(raw: string, flag: string): number {
  const parsed = Number(raw);
  if (!Number.isInteger(parsed) || parsed < 1) {
    throw new EvalArgsError(`${flag}는 양의 정수여야 한다(받은 값: ${raw}).`);
  }
  return parsed;
}

/** `eval/retrieval/args.ts`와 **같은 규칙**이다 — 두 eval이 다른 core-api를 보면 대조가 안 된다. */
export function defaultBaseUrl(env: NodeJS.ProcessEnv): string {
  const explicit = env["EVAL_CORE_API_URL"]?.trim();
  if (explicit) return explicit;
  const port = env["CORE_API_PORT"]?.trim();
  return `http://localhost:${port && port !== "" ? port : String(DEFAULT_CORE_API_PORT)}`;
}

export function parseRunArgs(argv: readonly string[], env: NodeJS.ProcessEnv): RunArgs {
  let project = DEFAULT_EVAL_PROJECT;
  let baseUrl = defaultBaseUrl(env);
  let expectedCaseCount = EXPECTED_CASE_COUNT;
  let allowFixtureJudge = false;

  for (const arg of argv) {
    if (arg === "--allow-fixture-judge") {
      allowFixtureJudge = true;
    } else if (arg.startsWith("--project=")) {
      project = arg.slice("--project=".length);
      if (project === "") throw new EvalArgsError("--project가 비어 있다.");
    } else if (arg.startsWith("--base-url=")) {
      baseUrl = arg.slice("--base-url=".length);
      if (baseUrl === "") throw new EvalArgsError("--base-url이 비어 있다.");
    } else if (arg.startsWith("--expected-cases=")) {
      expectedCaseCount = readPositiveInt(
        arg.slice("--expected-cases=".length),
        "--expected-cases",
      );
    } else {
      throw new EvalArgsError(`알 수 없는 인자: ${arg}. ${USAGE}`);
    }
  }

  return { project, baseUrl, expectedCaseCount, allowFixtureJudge };
}

/**
 * **fake 임베딩 위에서는 generation eval을 재지 않는다.**
 *
 * `eval/retrieval/args.ts`의 `assertMeasurable`과 같은 게이트이고 근거도 같다: 해시 벡터는
 * 서로 다른 텍스트 간 cosine ≈ 0이라(T-006 F-8) 검색이 근거를 못 찾고, 그러면
 * **모든 grounded 케이스가 임계값 게이트에 걸려 `found:false`가 된다**(시드 INC-18이 그 사건이다).
 * 그 상태의 `citationRuleCheck`는 "인용을 잘 붙였다"가 아니라 "잴 것이 없었다"이다.
 *
 * 여기에는 `--allow-fake-embeddings` 같은 우회로를 두지 않는다. retrieval eval과 달리
 * fake로 낸 generation 리포트는 **아무 진단 가치도 없다** — 케이스 전부가 같은 한 갈래로
 * 떨어지므로 파이프라인이 도는지조차 구별되지 않는다.
 */
export function assertMeasurableEmbeddings(provider: string): void {
  if (provider !== "fake") return;
  throw new EvalArgsError(
    "EMBEDDING_PROVIDER=fake로는 generation eval을 재지 않는다. fake 벡터는 서로 다른 텍스트 간 " +
      "cosine이 0 근처라(T-006 F-8) 모든 grounded 케이스가 임계값 게이트에 걸려 found:false가 되고, " +
      "그때 인용 룰체크는 잴 것이 없다는 뜻이지 100%라는 뜻이 아니다(시드 INC-18). " +
      "실제 임베딩 provider 자격증명을 주입하라.",
  );
}

/** `API_KEYS`에서 이 project로 해석되는 키를 고른다. 없으면 던진다(키를 만들어내지 않는다). */
export function resolveEvalApiKey(apiKeys: ReadonlyMap<string, string>, project: string): string {
  for (const [key, claimed] of apiKeys) {
    if (claimed === project) return key;
  }
  throw new EvalArgsError(
    `API_KEYS에 project "${project}"로 해석되는 키가 없다. ` +
      `\`<key>:${project}\` 항목을 추가하거나 --project=<slug>로 대상을 바꿔라(.env.example 참조).`,
  );
}
