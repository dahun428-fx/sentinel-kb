/**
 * T-046 CI 배선 가드 — `ci.yml` · `nightly-eval.yml` 에 **판정처를 만든다.**
 *
 * `deploy-contract.spec.ts` 가 배포 경로에 대해 한 일을 나머지 두 워크플로에 대해 한다.
 * 그 파일 서두의 진단이 여기서도 그대로 성립한다: **워크플로는 코드보다 조용히 썩는다.**
 * 다만 배포보다 나쁜 점이 하나 있다 — 배포는 안 돌아가면 아무도 배포되지 않았다는 것을
 * 알지만, **eval 은 안 돌아가도 아무 일도 일어나지 않는다.** 실패한 nightly 는 아침에
 * 아무도 열지 않는 빨간 점 하나이고, 애초에 실행된 적 없는 스텝은 점조차 남기지 않는다.
 *
 * **이 파일이 잡는 실제 결함**(가정이 아니라 베이스에 있던 것):
 *   - `nightly-eval.yml` 의 `env:` 가 `eval:injection` **스텝 하나에만** 붙어 있었다.
 *     YAML `env:` 는 그 스텝에만 적용되므로 앞의 세 eval 은 자격증명 없이 돌아
 *     EX_CONFIG(78)로 죽었고, 잡이 거기서 끝나 injection 은 **한 번도 실행되지 않았다.**
 *   - `VOYAGE_API_KEY` 가 파일 어디에도 없었다 — retrieval 이 요구한다.
 *   - `eval:style` 이 목록에 아예 없었다.
 *
 * `.github/workflows/` 중 테스트가 있는 것은 `deploy.yml` 하나뿐이었다. 그래서 위 셋이
 * 아무에게도 보이지 않았다. **판정처가 하나라도 있게 만드는 것이 요점이다.**
 *
 * docker 도 자격증명도 네트워크도 필요 없다. 정적 대조뿐이다.
 */
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";

const repoRoot = fileURLToPath(new URL("..", import.meta.url));

function read(relativePath: string): string {
  return readFileSync(join(repoRoot, relativePath), "utf8");
}

// ===================================================== 최소 YAML 스코프 파서
//
// 새 의존성을 들이지 않는다(CLAUDE.md: 스펙 없는 신규 의존성 금지). 그리고 이 검사에
// 필요한 것은 범용 YAML 이 아니라 **딱 하나의 질문**이다: "이 스텝에서 그 env 가
// 보이는가." 그 질문은 들여쓰기 스코프만 알면 답할 수 있다.
//
// ⚠️ 정규식 하나로 `env:` 를 찾아 이름만 긁으면 **이 파일의 존재 이유가 사라진다** —
//    스텝에 붙은 env 와 잡에 붙은 env 를 구별하지 못하기 때문이다. 그 구별이 정확히
//    T-046 이 고친 결함이다. 그래서 소유 관계를 세운다.

interface YamlLine {
  readonly indent: number;
  readonly text: string;
}

/**
 * 구조 줄만 남긴다 — 빈 줄·주석 줄·블록 스칼라(`run: |`) 본문을 걷어낸다.
 *
 * 블록 스칼라 본문은 YAML 구조가 아니라 셸이다. 걷어내지 않으면 `git config user.name`
 * 같은 줄이 매핑 키로 잡혀 스텝 소유 관계가 어긋난다.
 */
function structuralLines(yml: string): YamlLine[] {
  const out: YamlLine[] = [];
  let blockScalarIndent: number | null = null;

  for (const raw of yml.split("\n")) {
    if (raw.trim() === "") continue;
    const indent = raw.length - raw.trimStart().length;

    if (blockScalarIndent !== null) {
      if (indent > blockScalarIndent) continue;
      blockScalarIndent = null;
    }

    const text = raw.trim();
    if (text.startsWith("#")) continue;

    out.push({ indent, text });
    if (/:\s*[|>][-+]?\s*$/.test(text)) blockScalarIndent = indent;
  }
  return out;
}

/** `headerIndex` 가 가리키는 줄에 종속된 줄 전부(더 깊은 들여쓰기가 끊길 때까지). */
function descendants(lines: readonly YamlLine[], headerIndex: number): YamlLine[] {
  const base = lines[headerIndex]?.indent ?? 0;
  const out: YamlLine[] = [];
  for (let i = headerIndex + 1; i < lines.length; i += 1) {
    const line = lines[i];
    if (line === undefined || line.indent <= base) break;
    out.push(line);
  }
  return out;
}

/** 종속 줄 중 **직계** 자식만 (가장 얕은 들여쓰기 레벨). */
function directChildren(lines: readonly YamlLine[], headerIndex: number): YamlLine[] {
  const kids = descendants(lines, headerIndex);
  const shallowest = kids.reduce((min, line) => Math.min(min, line.indent), Number.MAX_SAFE_INTEGER);
  return kids.filter((line) => line.indent === shallowest);
}

/** `env:` 블록 하나의 `NAME: value` 쌍. 없으면 빈 Map. */
function envBlock(lines: readonly YamlLine[], ownerIndex: number): Map<string, string> {
  const out = new Map<string, string>();
  const kids = directChildren(lines, ownerIndex);
  const envLine = kids.find((line) => line.text === "env:");
  if (envLine === undefined) return out;

  const envIndex = lines.indexOf(envLine);
  for (const entry of directChildren(lines, envIndex)) {
    const match = /^([A-Za-z_][A-Za-z0-9_]*)\s*:\s*(.*)$/.exec(entry.text);
    if (match?.[1] !== undefined) out.set(match[1], (match[2] ?? "").trim());
  }
  return out;
}

interface WorkflowStep {
  /** `- run: …` 의 명령. `uses:` 스텝이면 null. */
  readonly run: string | null;
  /** 이 스텝 **자신에게만** 붙은 env. */
  readonly env: Map<string, string>;
  /** 실제로 이 스텝에서 보이는 env — 워크플로 ∪ 잡 ∪ 스텝. */
  readonly visible: Map<string, string>;
}

interface WorkflowJob {
  readonly id: string;
  readonly env: Map<string, string>;
  readonly steps: readonly WorkflowStep[];
}

function parseWorkflow(yml: string): {
  readonly env: Map<string, string>;
  readonly jobs: readonly WorkflowJob[];
} {
  const lines = structuralLines(yml);

  const workflowEnvOwner = lines.findIndex((line) => line.indent === 0 && line.text === "env:");
  const workflowEnv = new Map<string, string>();
  if (workflowEnvOwner >= 0) {
    for (const entry of directChildren(lines, workflowEnvOwner)) {
      const match = /^([A-Za-z_][A-Za-z0-9_]*)\s*:\s*(.*)$/.exec(entry.text);
      if (match?.[1] !== undefined) workflowEnv.set(match[1], (match[2] ?? "").trim());
    }
  }

  const jobsIndex = lines.findIndex((line) => line.indent === 0 && line.text === "jobs:");
  const jobs: WorkflowJob[] = [];
  if (jobsIndex < 0) return { env: workflowEnv, jobs };

  for (const jobHeader of directChildren(lines, jobsIndex)) {
    const jobIndex = lines.indexOf(jobHeader);
    const id = /^([A-Za-z0-9_-]+):$/.exec(jobHeader.text)?.[1];
    if (id === undefined) continue;

    const jobEnv = envBlock(lines, jobIndex);

    const stepsLine = directChildren(lines, jobIndex).find((line) => line.text === "steps:");
    const steps: WorkflowStep[] = [];
    if (stepsLine !== undefined) {
      for (const stepHeader of directChildren(lines, lines.indexOf(stepsLine))) {
        if (!stepHeader.text.startsWith("- ")) continue;
        const stepIndex = lines.indexOf(stepHeader);

        // `- run: x` 의 첫 속성은 대시 줄 자체에 있고, 나머지는 종속 줄에 있다.
        // 둘을 합쳐 하나의 가상 스텝으로 다루려고, 대시를 벗긴 줄을 속성 레벨로 끼워 넣고
        // 그 앞에 합성 헤더를 둔다. 이렇게 하면 `envBlock`/`directChildren` 을 그대로 쓴다.
        const own = stepHeader.text.slice(2).trim();
        const withHeader: YamlLine[] = [
          { indent: stepHeader.indent, text: "-" },
          { indent: stepHeader.indent + 2, text: own },
          ...descendants(lines, stepIndex),
        ];

        const stepEnv = envBlock(withHeader, 0);
        // **직계 속성에서만** 찾는다. 더 깊은 곳의 `run:`(예: 복합 액션 블록 안)을 스텝의
        // 명령으로 착각하면 스텝 하나가 엉뚱한 명령을 가진 것으로 잡힌다.
        const runLine = directChildren(withHeader, 0).find((line) => line.text.startsWith("run:"));

        steps.push({
          run: runLine === undefined ? null : runLine.text.slice("run:".length).trim(),
          env: stepEnv,
          visible: new Map([...workflowEnv, ...jobEnv, ...stepEnv]),
        });
      }
    }

    jobs.push({ id, env: jobEnv, steps });
  }

  return { env: workflowEnv, jobs };
}

// =========================================================== 대상 파일

const nightlyYml = read(".github/workflows/nightly-eval.yml");
const ciYml = read(".github/workflows/ci.yml");
const envExample = read(".env.example");
const rootPackageJson: { readonly scripts?: Readonly<Record<string, string>> } = JSON.parse(
  read("package.json"),
) as { readonly scripts?: Readonly<Record<string, string>> };
const rootScripts = rootPackageJson.scripts ?? {};

const nightly = parseWorkflow(nightlyYml);
const ci = parseWorkflow(ciYml);

function jobOf(parsed: ReturnType<typeof parseWorkflow>, id: string): WorkflowJob {
  const job = parsed.jobs.find((candidate) => candidate.id === id);
  if (job === undefined) throw new Error(`잡 ${id} 를 찾지 못했다 — 파서가 깨졌거나 잡이 사라졌다`);
  return job;
}

/**
 * 각 eval 러너가 **없으면 재지 못하는** env.
 *
 * 러너는 하나같이 "잴 수 없으면 아무것도 재지 않고 EX_CONFIG(78)로 거절한다"는 규약을
 * 따른다. 즉 아래 목록에서 하나라도 빠지면 그 스텝은 **0점을 내는 것이 아니라 78 로 죽고**,
 * 잡은 거기서 끝난다. 그래서 "보이는가"가 곧 "잴 수 있는가"다.
 *
 * 근거(전부 컴포지션 루트에서 읽는다 — 러너가 env 를 읽는 유일한 지점):
 *   - `MONGODB_URI`      `getDb()`. 골든셋·코퍼스가 DB 에 있다.
 *   - `API_KEYS`         `eval/retrieval/args.ts` `resolveEvalApiKey` — 키를 만들어내지 않고 던진다.
 *   - `EMBEDDING_*`      `packages/core/src/embedder/config.ts` — DIM·VERSION·MODEL 에 **기본값이 없다**.
 *   - `VOYAGE_API_KEY`   `packages/core/src/embedder/voyage.ts:55` — provider 가 voyage 면 요구된다.
 *   - `ANTHROPIC_API_KEY`·`ANTHROPIC_MODEL`
 *                        `packages/core/src/llm/config.ts:51,60` — 모델 ID 에도 기본값이 없다.
 */
const REQUIRED_ENV: Readonly<Record<string, readonly string[]>> = {
  "eval:retrieval": [
    "MONGODB_URI",
    "API_KEYS",
    "EMBEDDING_PROVIDER",
    "EMBEDDING_MODEL",
    "EMBEDDING_DIM",
    "EMBEDDING_VERSION",
    "VOYAGE_API_KEY",
  ],
  "eval:generation": [
    "API_KEYS",
    "EMBEDDING_PROVIDER",
    "EMBEDDING_MODEL",
    "EMBEDDING_DIM",
    "EMBEDDING_VERSION",
    "ANTHROPIC_API_KEY",
    "ANTHROPIC_MODEL",
  ],
  "eval:tools": ["ANTHROPIC_API_KEY", "ANTHROPIC_MODEL"],
  "eval:injection": ["ANTHROPIC_API_KEY", "ANTHROPIC_MODEL"],
  "eval:style": ["ANTHROPIC_API_KEY", "ANTHROPIC_MODEL"],
};

/** `pnpm eval:x` 형태의 스텝에서 스크립트 이름만. */
function evalScriptOf(run: string | null): string | null {
  if (run === null) return null;
  return /^pnpm\s+(eval:[a-z:]+)\s*$/.exec(run)?.[1] ?? null;
}

// ============================================ 파서가 실제로 읽어냈는가

/**
 * 파서가 죽으면 아래 검사 전부가 **빈 집합에 대해 통과한다** — 가장 나쁜 실패 양식이다.
 * (이 레포가 이미 아는 함정이다: `deploy-contract.spec.ts` 도 같은 이유로 "파싱 회귀 방지"
 * 테스트를 앞에 둔다.)
 */
describe("파싱 회귀 방지 — 빈 집합에 대한 통과를 막는다", () => {
  it("nightly-eval 의 eval 잡과 스텝을 읽어냈다", () => {
    const job = jobOf(nightly, "eval");
    expect(job.steps.length).toBeGreaterThanOrEqual(9);
    expect(job.steps.filter((step) => evalScriptOf(step.run) !== null).length).toBe(5);
  });

  it("ci 의 잡 3개를 읽어냈다", () => {
    expect(ci.jobs.map((job) => job.id).sort()).toEqual(["deploy-config", "spec-drift", "verify"]);
  });

  it("스텝 자신의 env 와 잡의 env 를 **구별해서** 읽는다", () => {
    // 이 구별이 없으면 T-046 이 고친 결함을 이 파일이 재현하게 된다.
    const job = jobOf(nightly, "eval");
    expect(job.env.size).toBeGreaterThan(0);
    for (const step of job.steps) {
      expect(step.env.size, "eval 스텝에 자기만의 env 가 생겼다 — 잡 레벨에 둬라").toBe(0);
    }
  });
});

// ================================= 핵심: eval 스텝이 자격증명을 **보는가**

describe("nightly-eval: eval 스텝이 요구 env 를 보는 스코프에 있다 (T-046 Acceptance 1)", () => {
  const job = jobOf(nightly, "eval");
  const evalSteps = job.steps
    .map((step) => ({ script: evalScriptOf(step.run), step }))
    .filter((entry): entry is { script: string; step: WorkflowStep } => entry.script !== null);

  it("워크플로가 러너 5종을 전부 돌린다 (style 이 빠져 있었다)", () => {
    expect(evalSteps.map((entry) => entry.script).sort()).toEqual([
      "eval:generation",
      "eval:injection",
      "eval:retrieval",
      "eval:style",
      "eval:tools",
    ]);
  });

  /**
   * **이 테스트가 T-046 의 산출물이다.**
   *
   * `env:` 를 잡 레벨에서 어느 한 스텝으로 내리면 나머지 네 스텝의 `visible` 에서 값이
   * 사라지고 여기가 빨개진다. 뮤테이션으로 확인했다 — 되돌린 판에서 4개 스텝 × 요구 env
   * 조합이 전부 실패한다.
   */
  it.each(
    Object.entries(REQUIRED_ENV).flatMap(([script, names]) =>
      names.map((name) => [script, name] as const),
    ),
  )("`%s` 스텝에서 `%s` 가 보인다", (script, name) => {
    const entry = evalSteps.find((candidate) => candidate.script === script);
    expect(entry, `${script} 스텝이 워크플로에 없다`).toBeDefined();
    expect(
      entry?.step.visible.has(name),
      `${script} 에서 ${name} 이 보이지 않는다 — env 가 잡 레벨에 있는지 확인하라`,
    ).toBe(true);
  });

  it("요구 env 의 이름이 `.env.example` 에 실재한다 (이름 드리프트 가드)", () => {
    // 위 표는 손으로 쓴 것이라 상류가 이름을 바꾸면 조용히 낡는다.
    // `.env.example` 은 이 레포가 env 이름을 선언하는 곳이다.
    for (const name of new Set(Object.values(REQUIRED_ENV).flat())) {
      expect(new RegExp(`^${name}=`, "m").test(envExample), `${name} 이 .env.example 에 없다`).toBe(
        true,
      );
    }
  });

  it("워크플로가 부르는 eval 스크립트가 `package.json` 에 실재한다", () => {
    for (const entry of evalSteps) {
      expect(Object.keys(rootScripts), `${entry.script} 스크립트가 없다`).toContain(entry.script);
    }
  });

  it("`package.json` 의 eval 러너 중 nightly 가 빠뜨린 것이 없다", () => {
    // 새 eval 을 추가하고 워크플로에 배선하지 않는 것이 `eval:style` 에서 실제로 일어났다.
    // `:check` 계열은 러너가 아니라 기준선 조회라 제외한다.
    const runners = Object.keys(rootScripts).filter(
      (name) => name.startsWith("eval:") && !name.endsWith(":check"),
    );
    const wired = new Set(evalSteps.map((entry) => entry.script));
    for (const runner of runners) {
      expect(wired.has(runner), `${runner} 가 nightly 에 배선되지 않았다`).toBe(true);
    }
  });
});

// ======================================================= 시크릿 취급

describe("nightly-eval: 시크릿은 참조뿐이다 (CLAUDE.md 금지사항)", () => {
  const job = jobOf(nightly, "eval");

  it("잡 env 의 모든 값이 `${{ … }}` 표현식이다 — 리터럴이 하나도 없다", () => {
    expect(job.env.size).toBeGreaterThanOrEqual(9);
    for (const [name, value] of job.env) {
      expect(value, `${name} 의 값이 리터럴이다 — 워크플로 파일은 평문으로 남는다`).toMatch(
        /^\$\{\{\s*(secrets|vars)\.[A-Z_][A-Z0-9_]*\s*\}\}$/,
      );
    }
  });

  it("자격증명은 `secrets.`, 설정은 `vars.` 로 나뉜다", () => {
    const fromSecrets = ["MONGODB_URI", "ANTHROPIC_API_KEY", "VOYAGE_API_KEY", "API_KEYS"];
    for (const name of fromSecrets) {
      expect(job.env.get(name), `${name} 은 secrets 여야 한다`).toMatch(/^\$\{\{\s*secrets\./);
    }
    // 모델 ID 는 시크릿이 아니지만 **코드에 기본값이 없다**. 리터럴로 박으면 세대 교체가
    // 워크플로 수정이 된다 — deploy.sh 가 모델명을 박지 않는 것과 같은 규약이다.
    for (const name of ["ANTHROPIC_MODEL", "EMBEDDING_MODEL"]) {
      expect(job.env.get(name), `${name} 은 vars 여야 한다`).toMatch(/^\$\{\{\s*vars\./);
    }
  });

  it("모델명을 워크플로에 박지 않는다", () => {
    expect(nightlyYml).not.toMatch(/ANTHROPIC_MODEL:\s*claude-/);
    expect(nightlyYml).not.toMatch(/EMBEDDING_MODEL:\s*voyage-/);
  });
});

// ============================== 커밋 스텝이 무력하다는 **사실**을 고정한다

describe("nightly-eval: 리포트 커밋 스텝 (인간 비준 대기 — T-046 Out of scope)", () => {
  /**
   * `specs/05` 는 리포트 커밋을 요구하는데 `.gitignore:23` 의 `eval/reports/*` 가 그것을
   * 차단한다. 그래서 `git add eval/reports/` 는 언제나 빈 스테이지를 만들고 커밋도 푸시도
   * 일어나지 않는다 — 워크플로 주석이 선언한 "리포트 시계열"은 성립한 적이 없다.
   *
   * **어느 쪽을 접을지는 사람이 정한다.** 이 테스트는 고치지 않고 **모순이 아직 있다는
   * 사실만** 고정한다. 둘 중 하나가 바뀌면 여기가 빨개지고, 그때 이 테스트를 지우면 된다.
   */
  it("모순이 아직 있다: `.gitignore` 가 막고 `specs/05` 가 요구한다", () => {
    expect(read(".gitignore")).toContain("eval/reports/*");
    expect(read("specs/05-test-strategy.md")).toContain("eval/reports/YYYY-MM-DD-retrieval.json");
    expect(nightlyYml).toContain("git add eval/reports/");
  });

  it("그 사실이 워크플로 주석에 적혀 있다 — 다음 사람이 배선 버그로 오해하지 않게", () => {
    expect(nightlyYml).toContain("인간 비준 대기");
    expect(nightlyYml).toContain(".gitignore:23");
  });

  it("artifact 업로드가 유일한 실제 보존 경로다", () => {
    expect(nightlyYml).toContain("actions/upload-artifact@v4");
    expect(nightlyYml).toContain("path: eval/reports/");
  });
});

// ================================================= ci.yml — 첫 단언

describe("ci.yml: 게이트 사슬 (specs/05 CI 절)", () => {
  const verify = jobOf(ci, "verify");
  const runs = verify.steps.map((step) => step.run).filter((run): run is string => run !== null);

  it("`push → lint → typecheck → unit → integration → build` 가 이 순서로 있다", () => {
    const expected = [
      "pnpm lint",
      "pnpm typecheck",
      "pnpm test",
      "pnpm test:integration",
      "pnpm build",
    ];
    const positions = expected.map((command) => runs.indexOf(command));
    for (const [index, position] of positions.entries()) {
      expect(position, `${expected[index] ?? ""} 스텝이 없다`).toBeGreaterThanOrEqual(0);
    }
    expect([...positions].sort((a, b) => a - b)).toEqual(positions);
  });

  /**
   * T-010 F-5. docker 가 없으면 atlas-local 이 필요한 스펙들이 `describe.skipIf` 로 통째로
   * 건너뛰고 **exit 0** 을 낸다. stderr 배너는 찍히지만 **배너는 게이트가 아니다.**
   * 이 플래그가 그 skip 을 하드 실패로 승격한다. 지우면 "docker 가 없으니 그린"이 머지된다.
   */
  it("통합 테스트 스텝이 `REQUIRE_DOCKER=1` 을 **자기 스코프에서** 본다", () => {
    const step = verify.steps.find((candidate) => candidate.run === "pnpm test:integration");
    expect(step, "pnpm test:integration 스텝이 없다").toBeDefined();
    expect(step?.visible.get("REQUIRE_DOCKER")).toBe('"1"');
  });

  it("통합 테스트가 fake 임베더로 돈다 (specs/05 결정론 원칙)", () => {
    const step = verify.steps.find((candidate) => candidate.run === "pnpm test:integration");
    expect(step?.visible.get("EMBEDDING_PROVIDER")).toBe("fake");
  });

  it("게이트 잡의 어느 스텝도 실패를 삼키지 않는다", () => {
    // `continue-on-error` 한 줄이면 위의 REQUIRE_DOCKER 설계 전체가 무효가 된다.
    const verifyBlock = /^ {2}verify:$([\s\S]*?)(?=^ {2}[a-z][a-z0-9-]*:$)/m.exec(ciYml)?.[1] ?? "";
    expect(verifyBlock.length).toBeGreaterThan(0);
    expect(verifyBlock).not.toContain("continue-on-error");
    expect(verifyBlock).not.toMatch(/\|\|\s*true/);
  });

  it("PR 에서 돈다 — 머지 전에 판정되지 않으면 게이트가 아니다", () => {
    expect(ciYml).toMatch(/^on:$/m);
    expect(ciYml).toContain("pull_request:");
  });

  it("spec-drift 만 경고이고, 그 사실이 주석에 적혀 있다", () => {
    // 이 잡은 일부러 머지를 막지 않는다(스펙 수정은 사람 판단). 다른 잡이 이 관용을
    // 흉내내면 게이트가 사라지므로 **여기 하나뿐**임을 고정한다.
    expect([...ciYml.matchAll(/\|\|\s*echo\s+"::warning/g)]).toHaveLength(1);
    expect(jobOf(ci, "spec-drift").steps.some((step) => step.run?.includes("spec-drift-check.sh")))
      .toBe(true);
    expect(existsSync(join(repoRoot, "scripts/spec-drift-check.sh"))).toBe(true);
  });
});

// ================================================= ci.yml — deploy-config 더미 env

describe("ci.yml: deploy-config 더미 env 가 compose 필수 변수를 전부 덮는다 (T-048)", () => {
  /**
   * T-042 가 `docker-compose.yml` 에 `WEB_HTPASSWD_B64:?` 를 넣었는데 이 잡의 더미 env 에는
   * 추가되지 않았다. 그래서 `compose config` 가 해소에 실패해 main 의 deploy-config 가
   * 빨개졌다(UPLIFT F-1). compose-contract.int.spec.ts 는 자기 fixture 를 따로 들고 있어
   * 이 누락을 보지 못했다 — 두 목록이 같은 소스를 보지 않았기 때문이다.
   *
   * 그래서 목록을 손으로 맞추지 않고 compose 파일에서 **계산한다.** `:?` 변수가 새로
   * 생기면 이 테스트가 먼저 빨개진다.
   */
  const composeFiles = ["docker-compose.yml", "docker-compose.prod.yml"];
  const required = new Set(
    composeFiles.flatMap((file) =>
      [...read(file).matchAll(/\$\{([A-Z0-9_]+):\?/g)].map((match) => match[1] ?? ""),
    ),
  );
  const heredoc = /cat > \/tmp\/ci\.env <<'ENV'\n([\s\S]*?)\n\s*ENV\n/.exec(ciYml)?.[1] ?? "";
  const provided = new Set(
    heredoc
      .split("\n")
      .map((line) => line.trim())
      .filter((line) => line !== "" && !line.startsWith("#"))
      .map((line) => line.split("=")[0] ?? ""),
  );

  it("파싱 회귀 방지 — 양쪽 목록을 실제로 읽어냈다", () => {
    expect(required.size).toBeGreaterThanOrEqual(10);
    expect(provided.size).toBeGreaterThanOrEqual(10);
  });

  it("compose 의 모든 `${VAR:?}` 가 더미 env 에 있다", () => {
    const missing = [...required].filter((name) => !provided.has(name)).sort();
    expect(missing, "deploy-config 의 /tmp/ci.env 에 없는 compose 필수 변수").toEqual([]);
  });
});

// ================================================= pnpm test:e2e

describe("`pnpm test:e2e` (T-046 Acceptance 3)", () => {
  /**
   * CLAUDE.md 가 문서화하고 `packages/web/e2e/**` 가 실재하는데 루트에 스크립트가 없었다.
   * 문서가 약속한 명령이 존재하지 않는 상태였다.
   */
  it("루트에 스크립트가 있다", () => {
    expect(Object.keys(rootScripts)).toContain("test:e2e");
  });

  it("**조용히 0 을 내지 않는다** — 필터가 아무것도 못 잡으면 실패한다", () => {
    // `pnpm --filter <없는 패키지> run x` 는 경고만 내고 exit 0 이다. 그러면 웹 패키지
    // 이름이 바뀌는 순간 E2E 가 "통과"하기 시작한다 — REQUIRE_DOCKER 가 막는 것과 같은
    // 계열의 가짜 그린이다.
    const script = rootScripts["test:e2e"] ?? "";
    expect(script).toContain("--fail-if-no-match");
    expect(script).toContain("@sentinel/web");
  });

  it("위임 대상이 실재한다 — 패키지 스크립트와 스펙 파일", () => {
    const webPackageJson: { readonly scripts?: Readonly<Record<string, string>> } = JSON.parse(
      read("packages/web/package.json"),
    ) as { readonly scripts?: Readonly<Record<string, string>> };
    expect(webPackageJson.scripts?.["test:e2e"]).toBe("playwright test");
    expect(existsSync(join(repoRoot, "packages/web/playwright.config.ts"))).toBe(true);
    for (const spec of ["read-path.spec.ts", "article-path.spec.ts"]) {
      expect(existsSync(join(repoRoot, "packages/web/e2e", spec)), `${spec} 가 없다`).toBe(true);
    }
  });

  it("`pnpm verify` 에 넣지 않는다 — 브라우저 러너는 별도 결정이다 (T-046 Out of scope)", () => {
    expect(rootScripts["verify"] ?? "").not.toContain("test:e2e");
  });
});
