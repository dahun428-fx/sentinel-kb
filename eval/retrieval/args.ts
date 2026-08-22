/**
 * `pnpm eval:retrieval`의 인자·env 해석. **순수 함수다** — `process`를 읽지 않는다.
 * CLI가 `process.argv`·`process.env`를 넘기고, 테스트는 리터럴을 넘긴다.
 *
 * 오타난 인자는 조용히 무시하지 않고 던진다. `--limit 20`(등호 없음)을 무시하면 사용자는
 * limit=20으로 잰 줄 알고 5로 잰 리포트를 커밋한다.
 */
export const DEFAULT_EVAL_LIMIT = 5;
export const DEFAULT_EVAL_PROJECT = "sentinel-kb";
export const DEFAULT_CORE_API_PORT = 3001;

export interface RunArgs {
  readonly limit: number;
  readonly project: string;
  readonly baseUrl: string;
  readonly expectedCaseCount: number;
  /**
   * fake 임베딩으로도 돌린다. 리포트는 `trusted:false`로 표시되고 **기준선 판정을 하지 않는다**.
   * 진단(파이프라인이 도는지, 골든셋이 로드되는지)에만 쓴다.
   */
  readonly allowFakeEmbeddings: boolean;
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

export function defaultBaseUrl(env: NodeJS.ProcessEnv): string {
  const explicit = env["EVAL_CORE_API_URL"]?.trim();
  if (explicit) return explicit;
  const port = env["CORE_API_PORT"]?.trim();
  return `http://localhost:${port && port !== "" ? port : String(DEFAULT_CORE_API_PORT)}`;
}

export function parseRunArgs(argv: readonly string[], env: NodeJS.ProcessEnv): RunArgs {
  let limit = DEFAULT_EVAL_LIMIT;
  let project = DEFAULT_EVAL_PROJECT;
  let baseUrl = defaultBaseUrl(env);
  let expectedCaseCount = 30;
  let allowFakeEmbeddings = false;

  for (const arg of argv) {
    if (arg === "--allow-fake-embeddings") {
      allowFakeEmbeddings = true;
    } else if (arg.startsWith("--limit=")) {
      limit = readPositiveInt(arg.slice("--limit=".length), "--limit");
      if (limit > 20) {
        // 계약(`SearchRequest.limit`)의 상한이다. 넘겨 보내면 400이 나고 전 케이스가 실패한다.
        throw new EvalArgsError("--limit은 1–20이다(SearchRequest.limit의 계약 상한).");
      }
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
      throw new EvalArgsError(
        `알 수 없는 인자: ${arg}. ` +
          "사용법: pnpm eval:retrieval [--limit=5] [--project=<slug>] [--base-url=<url>] " +
          "[--expected-cases=30] [--allow-fake-embeddings]",
      );
    }
  }

  return { limit, project, baseUrl, expectedCaseCount, allowFakeEmbeddings };
}

/**
 * 이 provider로 잰 수치를 검색 품질로 읽어도 되는가.
 *
 * `fake`만 거짓이다. 해시 임베딩은 서로 다른 텍스트 간 cosine이 0 근처라(T-006 F-8, 실측
 * −0.00007) 벡터 경로가 순위에 기여하지 못한다 — T-012 검증이 실증했다(벡터 경로를 융합에서
 * 제거해도 통합 테스트 11개 전부 통과, `vectorRank`·`textRank` 동시 non-null hit 0건).
 */
export function isTrustedProvider(provider: string): boolean {
  return provider !== "fake";
}

/**
 * **자격증명 없이는 재지 않는다.** `scripts/seed.cli.ts`가 fake 적재를 거절하는 것과 같은 게이트다.
 * `--allow-fake-embeddings`로만 넘어갈 수 있고, 그때 나온 리포트는 `trusted:false`가 되어
 * 기준선 판정 대상에서 빠진다(baseline-guard).
 */
export function assertMeasurable(provider: string, allowFakeEmbeddings: boolean): void {
  if (isTrustedProvider(provider) || allowFakeEmbeddings) return;
  throw new EvalArgsError(
    "EMBEDDING_PROVIDER=fake로는 retrieval eval을 재지 않는다. fake 벡터는 서로 다른 텍스트 간 " +
      "cosine이 0 근처라(T-006 F-8) Recall@5가 검색 품질이 아니라 BM25 단독 성능을 잰다. " +
      "실제 임베딩 provider 자격증명을 주입하라(T-013 STATUS: BLOCKED의 사유가 이것이다). " +
      "파이프라인 동작만 확인하려면 --allow-fake-embeddings — 그 리포트는 기준선 판정을 하지 않는다.",
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
