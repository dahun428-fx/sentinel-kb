import { execFileSync } from "node:child_process";
import { mkdtempSync, readdirSync, readFileSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";

import {
  buildLoopMetrics,
  collectEvalSeries,
  evalSvgFileName,
  GRAPH_KINDS,
  LOOP_LOG_PATH,
  LOOP_METRICS_JSON,
  LOOP_METRICS_MD,
  parseLoopLog,
  renderEvalSvg,
  renderLoopMetricsTable,
} from "./portfolio-metrics.js";

/**
 * T-028 포트폴리오 가드.
 *
 * 포트폴리오 문서는 **가장 조용히 썩는 문서**다. 코드가 바뀌어도 README는 안 깨지고,
 * 지표가 낡아도 아무도 눈치채지 못하며, 무엇보다 **재 본 적 없는 숫자를 성과로 적어도
 * 아무 장치도 막지 않는다.** 이 파일이 그 셋을 전부 기계 판정으로 바꾼다.
 *
 * 선례는 `tools/connect-docs.spec.ts`(T-017)와 `tools/deploy-contract.spec.ts`(T-027)다 —
 * 정본을 스펙·설정에서 읽고 문서를 거기에 대는 방식이다. 이 파일이 더하는 것은 셋이다:
 *
 * 1. **다이어그램 대조** — README의 mermaid 노드·간선을 `packages/`·`docker-compose.yml`·
 *    `eslint.config.js` zone·`.env.example`이라는 **실물**에 댄다. 다이어그램이 그림이 아니라
 *    검증 대상이 된다.
 * 2. **지표 재계산** — README의 루프 지표 표를 `eval/loop-log.jsonl`에서 다시 산출해 대조한다.
 *    로그가 늘면 README가 낡고, 낡으면 여기서 빨개진다.
 * 3. **미측정 지표 가드** — 이 레포에서 한 번도 측정된 적 없는 지표 이름이 README에
 *    **성과 문장으로** 나타나면 실패한다. 이것이 이 태스크에서 가장 위험한 실패 모드다.
 */
const repoRoot = fileURLToPath(new URL("..", import.meta.url));

function read(relativePath: string): string {
  return readFileSync(join(repoRoot, relativePath), "utf8");
}

const readme = read("README.md");

/** `<!-- name:begin -->` … `<!-- name:end -->` 사이. 마커가 없으면 죽는다. */
function block(name: string, source = readme): string {
  const re = new RegExp(`<!-- ${name}:begin -->\\n([\\s\\S]*?)<!-- ${name}:end -->`);
  const match = re.exec(source);
  if (match === null) throw new Error(`README.md에 <!-- ${name}:begin/end --> 마커가 없다.`);
  return (match[1] ?? "").trim();
}

/**
 * 라벨 안의 문자열을 지운다. 지우지 않으면 라벨 본문이 노드 id로 오인된다 —
 * `atlas[("… chunks[vector] …")]`의 `chunks`가 실제로 그렇게 잡혔다.
 */
function stripLabels(mermaid: string): string {
  return mermaid.replace(/"[^"]*"/g, '""');
}

/** mermaid 블록 안의 노드 선언 `id["label"]` / `id[("label")]` / `id{"label"}`에서 id만. */
function nodeIds(mermaid: string): Set<string> {
  const ids = new Set<string>();
  const source = stripLabels(mermaid);
  for (const match of source.matchAll(/(^|[\s|>-])([A-Za-z_][A-Za-z0-9_]*)\s*[[({]/g)) {
    ids.add(match[2] ?? "");
  }
  for (const match of source.matchAll(/^\s*subgraph\s+([A-Za-z_][A-Za-z0-9_]*)/gm)) {
    ids.add(match[1] ?? "");
  }
  return ids;
}

/** `a --> b` / `a -->|"label"| b` / `a -.-> b` 의 (from, to). */
function edges(mermaid: string): [string, string][] {
  const out: [string, string][] = [];
  const re = /([A-Za-z_][A-Za-z0-9_]*)\s*(?:--|-\.-)+>\s*(?:\|[^|]*\|\s*)?([A-Za-z_][A-Za-z0-9_]*)/g;
  for (const match of stripLabels(mermaid).matchAll(re)) out.push([match[1] ?? "", match[2] ?? ""]);
  return out;
}

const dashed = (id: string): string => id.replace(/_/g, "-");

/* -------------------------------------------------------------------------- */

describe("README 아키텍처 다이어그램 ↔ 실물 (T-028)", () => {
  const arch = block("arch-diagram");
  const composeYaml = read("docker-compose.yml");

  /** `services:` 아래 2칸 들여쓴 키. compose가 정본이다. */
  const composeServices = (() => {
    const body = composeYaml.slice(composeYaml.indexOf("\nservices:"));
    return new Set(
      [...body.matchAll(/^ {2}([a-z][a-z0-9_-]*):$/gm)].map((match) => match[1] ?? ""),
    );
  })();

  /** 서비스가 아닌 노드. 늘리려면 여기 적어야 하므로 무심코 늘지 않는다. */
  const nonService = new Set(["clients", "atlas", "ec2"]);

  it("docker-compose.yml에서 서비스를 읽어낸다 (파싱 자체의 회귀 방지)", () => {
    expect([...composeServices].sort()).toEqual([
      "core-api",
      "db-init",
      "mcp",
      "nginx",
      "web",
      "worker",
    ]);
  });

  it("다이어그램이 compose의 서비스를 하나도 빠뜨리지 않는다", () => {
    const drawn = new Set([...nodeIds(arch)].map(dashed));
    for (const service of composeServices) {
      expect(drawn.has(service), `다이어그램에 compose 서비스 \`${service}\`가 없다`).toBe(true);
    }
  });

  it("다이어그램이 존재하지 않는 서비스를 그리지 않는다", () => {
    for (const id of nodeIds(arch)) {
      if (nonService.has(id)) continue;
      expect(
        composeServices.has(dashed(id)),
        `다이어그램의 \`${id}\`가 docker-compose.yml에 없다`,
      ).toBe(true);
    }
  });
});

describe("README 의존 방향 다이어그램 ↔ eslint zone (T-028)", () => {
  const deps = block("deps-diagram");
  const eslintConfig = read("eslint.config.js");

  const packages = new Set(
    readdirSync(join(repoRoot, "packages")).filter((name) =>
      statSync(join(repoRoot, "packages", name)).isDirectory(),
    ),
  );

  /**
   * `import/no-restricted-paths`의 zone을 **금지 간선 집합**으로 읽는다.
   * 규칙에서 `target`은 **import하는 쪽**이고 `from`은 **import당하면 안 되는 쪽**이다.
   * 그래서 금지 간선은 `target -> from`이다.
   *
   * 문서가 스펙 산문("web/mcp/api → core → contracts")이 아니라 **기계가 강제하는 규칙**에
   * 대조되는 것이 요점이다 — 산문은 `worker`를 빠뜨리고 있고, zone은 빠뜨리지 않는다.
   */
  const forbidden = (() => {
    const pairs = new Set<string>();
    const re = /target:\s*"\.\/packages\/([a-z]+)",\s*from:\s*\[([\s\S]*?)\]/g;
    for (const match of eslintConfig.matchAll(re)) {
      const importer = match[1] ?? "";
      for (const imported of (match[2] ?? "").matchAll(/"\.\/packages\/([a-z]+)"/g)) {
        pairs.add(`${importer}->${imported[1] ?? ""}`);
      }
    }
    return pairs;
  })();

  it("eslint.config.js에서 금지 간선 21개를 방향까지 맞게 읽어낸다 (파서 회귀 방지)", () => {
    // contracts(5) + core(4) + api(3) + mcp(3) + worker(3) + web(3) = 21.
    expect(forbidden.size).toBe(21);
    // 방향이 뒤집히면 가드가 정반대를 검사하게 되므로 양쪽을 다 박는다.
    expect(forbidden.has("contracts->core"), "contracts는 core를 import할 수 없다").toBe(true);
    expect(forbidden.has("core->contracts"), "core → contracts는 허용 방향이다").toBe(false);
    expect(forbidden.has("mcp->api"), "형제 간선 금지").toBe(true);
  });

  /** 이 다이어그램은 노드를 선언하지 않고 간선으로만 쓴다 — 간선의 양 끝이 곧 노드다. */
  const depsNodes = new Set(edges(deps).flat());

  it("다이어그램의 노드가 packages/ 디렉터리와 정확히 일치한다", () => {
    expect([...depsNodes].sort()).toEqual([...packages].sort());
  });

  it("다이어그램이 eslint가 금지한 간선을 하나도 그리지 않는다", () => {
    for (const [from, to] of edges(deps)) {
      expect(
        forbidden.has(`${from}->${to}`),
        `다이어그램의 \`${from} --> ${to}\`는 eslint zone이 금지한 방향이다`,
      ).toBe(false);
    }
  });

  it("다이어그램에 간선이 실제로 있다 — 빈 그래프는 어떤 위반도 그리지 않아 공허하게 통과한다", () => {
    expect(edges(deps).length).toBeGreaterThanOrEqual(packages.size - 1);
  });
});

describe("README RAG 다이어그램 ↔ .env.example (T-028)", () => {
  const rag = block("rag-diagram");
  const envKeys = new Set(
    [...read(".env.example").matchAll(/^([A-Z][A-Z0-9_]*)=/gm)].map((match) => match[1] ?? ""),
  );

  it(".env.example에서 키를 읽어낸다 (파싱 회귀 방지)", () => {
    expect(envKeys.size).toBeGreaterThan(30);
    expect(envKeys.has("SIMILARITY_THRESHOLD")).toBe(true);
  });

  it("다이어그램이 인용한 파라미터가 전부 .env.example에 실재한다", () => {
    const cited = [...rag.matchAll(/\b([A-Z][A-Z0-9]*(?:_[A-Z0-9]+)+)\b/g)].map((m) => m[1] ?? "");
    expect(cited.length, "다이어그램이 파라미터를 하나도 인용하지 않는다").toBeGreaterThan(5);
    for (const key of new Set(cited)) {
      expect(envKeys.has(key), `RAG 다이어그램의 \`${key}\`가 .env.example에 없다`).toBe(true);
    }
  });
});

describe("README MCP 도구 목록 ↔ specs/07 (T-028)", () => {
  const tools = block("mcp-tools");
  const specToolNames = [...read("specs/07-mcp.md").matchAll(/^### \d+\. `([a-z_]+)`/gm)].map(
    (match) => match[1] ?? "",
  );

  it("specs/07에서 도구 5개를 읽어낸다", () => {
    expect(specToolNames).toHaveLength(5);
  });

  it("README가 스펙의 도구 이름과 정확히 같은 5개를 싣는다 (도구 5개 상한)", () => {
    const listed = [...tools.matchAll(/^\| `([a-z_]+)` \|/gm)].map((match) => match[1] ?? "");
    expect([...listed].sort()).toEqual([...specToolNames].sort());
  });
});

describe("README 루프 지표 ↔ eval/loop-log.jsonl (T-028 Acceptance 3)", () => {
  const metrics = buildLoopMetrics(parseLoopLog(read(LOOP_LOG_PATH)));

  it("README의 지표 표가 로그에서 재계산한 값과 한 글자도 다르지 않다", () => {
    expect(block("loop-metrics")).toBe(renderLoopMetricsTable(metrics));
  });

  it("로그가 실제로 비어 있지 않다 — 빈 로그는 어떤 표와도 조용히 일치한다", () => {
    expect(metrics.entries).toBeGreaterThan(0);
    expect(metrics.tasks).toBeGreaterThan(0);
  });

  /**
   * 완결률 목표(`specs/00` 70%)를 **문서가 마음대로 통과 선언하지 못하게** 한다.
   * 세 정의 중 어느 것도 목표를 넘지 못하는데 "달성"이라 쓰면 여기서 죽는다.
   */
  it("목표 달성을 주장한다면 실제로 어떤 정의로든 넘어야 한다", () => {
    const claimsSuccess = /자동 완결률[^\n]*(달성|충족|초과)/.test(readme);
    if (claimsSuccess) expect(metrics.meetsTargetUnderAnyDefinition).toBe(true);
  });
});

/* -------------------------------------------------------------------------- */

/**
 * **이 레포에서 한 번도 측정된 적이 없는 지표들.**
 *
 * 목록의 근거는 각 태스크의 STATUS·Findings다: T-013 BLOCKED(임베딩 자격증명 부재),
 * T-016 BLOCKED(tool-calling provider 부재), T-020 판정 불가(judge 키 부재),
 * T-021 F-3(방어선 3 판정 불가), T-039 F-1(NFR-01 생성 경로 미성립), T-027 F-6(실배포 판정 불가).
 *
 * **이 목록에서 항목을 지우려면 그 지표가 실제로 측정된 리포트가 있어야 한다.**
 * 목록을 줄이는 것이 가드를 통과하는 가장 싼 길이 되지 않도록, 목록 크기를 리터럴로 잠근다.
 */
const NEVER_MEASURED = [
  "Recall@5",
  "MRR",
  "faithfulness",
  "usefulness",
  "selectionAccuracy",
  "Tool-selection 정확도",
  "인용률",
  "방어율",
  "p95",
] as const;

/** 이 표지 중 하나가 같은 줄에 있으면 "성과 주장"이 아니다. */
const HONEST_MARKERS = [
  "판정 불가",
  "측정되지 않",
  "측정된 적",
  "미측정",
  "목표",
  "기준선",
  "BLOCKED",
  "잴 수 없",
  "수치가 없",
  "미성립",
] as const;

describe("README 미측정 지표 가드 — 지어낸 성과를 막는다 (T-028)", () => {
  const unmeasured = block("unmeasured");
  const unmeasuredLines = new Set(unmeasured.split("\n"));

  it("가드 목록이 임의로 줄지 않는다", () => {
    expect(NEVER_MEASURED.length).toBe(9);
  });

  it("README에 '측정되지 않은 것' 절이 실재하고 비어 있지 않다", () => {
    expect(unmeasured.length).toBeGreaterThan(200);
  });

  it("측정된 적 없는 지표는 정직 표지가 붙은 줄에서만 언급된다", () => {
    const offending: string[] = [];
    for (const [index, line] of readme.split("\n").entries()) {
      // §6-3(unmeasured 블록)은 이 지표들을 다루라고 만든 절이다.
      if (unmeasuredLines.has(line)) continue;
      // 가드 자신을 설명하는 줄은 지표를 나열해야 하므로 제외 대상이 아니다 — 표지를 요구한다.
      for (const metric of NEVER_MEASURED) {
        if (!line.includes(metric)) continue;
        if (HONEST_MARKERS.some((marker) => line.includes(marker))) continue;
        offending.push(`README.md:${String(index + 1)} [${metric}] ${line.trim()}`);
      }
    }
    expect(
      offending,
      "측정된 적 없는 지표를 성과처럼 적었다. §6-3으로 옮기거나 판정 불가를 명시하라",
    ).toEqual([]);
  });

  it("eval 기준선을 낮추지 않았다 — baselines.json이 specs/00 목표 이상이다", () => {
    const baselines = JSON.parse(read("eval/baselines.json")) as {
      retrieval: { "recall@5": number };
      generation: { citationRuleCheck: number };
      injection: { defenseRate: number };
    };
    expect(baselines.retrieval["recall@5"]).toBeGreaterThanOrEqual(0.8);
    expect(baselines.generation.citationRuleCheck).toBe(1.0);
    expect(baselines.injection.defenseRate).toBe(1.0);
  });
});

describe("README 위생 (T-028)", () => {
  it("없는 pnpm 스크립트를 안내하지 않는다", () => {
    const scripts = new Set(
      Object.keys((JSON.parse(read("package.json")) as { scripts?: object }).scripts ?? {}),
    );
    const builtins = new Set(["exec", "run", "install", "add", "dlx"]);
    for (const match of readme.matchAll(/\bpnpm ([a-z][a-z0-9:_-]*)/g)) {
      const token = match[1] ?? "";
      if (builtins.has(token)) continue;
      expect(scripts.has(token), `README가 package.json에 없는 \`pnpm ${token}\`를 안내한다`).toBe(
        true,
      );
    }
  });

  it("리터럴 Bearer 토큰이 없다", () => {
    const literals = [...readme.matchAll(/Bearer ([A-Za-z0-9._-]+)/g)].map((m) => m[1] ?? "");
    expect(literals).toEqual([]);
  });

  it("문서 지도가 가리키는 파일이 전부 실재한다", () => {
    const referenced = [...readme.matchAll(/`(docs\/[A-Za-z0-9/_.-]+\.md)`/g)].map(
      (match) => match[1] ?? "",
    );
    expect(referenced.length).toBeGreaterThan(5);
    for (const path of new Set(referenced)) {
      expect(() => read(path), `README가 없는 문서 \`${path}\`를 가리킨다`).not.toThrow();
    }
  });
});

/* -------------------------------------------------------------------------- */

describe("portfolio-report.cli — 잴 수 없으면 거절한다 (T-028 Acceptance 2)", () => {
  it("리포트가 0건이면 그래프를 0으로 채우지 않고 exit 78로 끝난다", () => {
    const outDir = mkdtempSync(join(tmpdir(), "sentinel-portfolio-"));
    let status = 0;
    try {
      // 레포 규약: CLI는 `node --import tsx`로 띄운다 (`tools/dogfood-report.cli.spec.ts`와 동일).
      execFileSync(
        process.execPath,
        [
          "--import",
          "tsx",
          join(repoRoot, "tools/portfolio-report.cli.ts"),
          `--out-dir=${outDir}`,
        ],
        { cwd: repoRoot, stdio: "pipe" },
      );
    } catch (error: unknown) {
      status = (error as { status?: number }).status ?? -1;
    }
    // 78 = EX_CONFIG. `pnpm eval:tools`·`eval:generation`·`eval:injection`과 같은 신호다.
    expect(status).toBe(78);

    const written = new Set(readdirSync(outDir));
    expect(written.has(LOOP_METRICS_JSON), "루프 지표는 원천이 있으므로 나와야 한다").toBe(true);
    expect(written.has(LOOP_METRICS_MD)).toBe(true);
    for (const kind of GRAPH_KINDS) {
      expect(written.has(evalSvgFileName(kind)), `${kind} 그래프가 없다`).toBe(true);
      const svg = readFileSync(join(outDir, evalSvgFileName(kind)), "utf8");
      // 빈 그래프가 아니라 결번 사유를 그려야 한다.
      expect(svg).toContain("측정된 리포트 0건");
      expect(svg).toContain("0점이 아니라 미측정이다");
    }
  });

  it("리포트가 있으면 실제로 꺾은선을 그린다 — 거절 경로만 있는 스크립트가 아니다", () => {
    const series = collectEvalSeries([
      {
        name: "2026-08-01-retrieval.json",
        raw: JSON.stringify({ metrics: { "recall@5": 0.71, mrr: 0.55 } }),
      },
      {
        name: "2026-08-08-retrieval.json",
        raw: JSON.stringify({ metrics: { "recall@5": 0.83, mrr: 0.66 } }),
      },
    ]);
    const one = series.get("retrieval");
    expect(one?.absent).toBe(false);
    const svg = renderEvalSvg(one as NonNullable<typeof one>, "쓰이지 않아야 한다");
    expect(svg).toContain("<polyline");
    expect(svg).toContain("2026-08-08");
    expect(svg).not.toContain("측정된 리포트 0건");
  });
});
