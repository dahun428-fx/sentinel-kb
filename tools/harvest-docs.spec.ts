import { existsSync, readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";

import {
  DOGFOOD_LOG_PATH,
  DOGFOOD_REPORT_DIR,
  dogfoodReportFileName,
  TARGET_HITS_4W,
  TARGET_RECORDS_4W,
} from "./dogfood-report.js";

/**
 * T-024 도그푸딩 문서 가드 — `connect-docs.spec.ts`(T-017)와 같은 취지다.
 *
 * 문서는 조용히 썩는다. 이 문서는 특히 그렇다: `/harvest`와 `docs/dogfooding.md`는
 * **레포의 다른 파일 상태를 주장한다**("이 문장은 아직 task-loop 스킬에 없다",
 * "이 검사는 CI에서 경고로만 돈다"). 그 주장은 오늘 참이고 내일 거짓이 될 수 있는데,
 * 거짓이 되는 순간이 정확히 **문서를 고쳐야 하는 순간**이다. 사람이 알아채길 기다리지 않는다.
 *
 * 도구 이름의 정본은 `specs/07-mcp.md`다 — CLAUDE.md "스펙이 소스 오브 트루스".
 */
const repoRoot = fileURLToPath(new URL("..", import.meta.url));

function read(relativePath: string): string {
  return readFileSync(join(repoRoot, relativePath), "utf8");
}

const HARVEST_CMD = ".claude/commands/harvest.md";
const DOGFOOD_DOC = "docs/dogfooding.md";
const TASK_LOOP_SKILL = ".claude/skills/task-loop/SKILL.md";

const harvest = read(HARVEST_CMD);
const dogfoodDoc = read(DOGFOOD_DOC);
const mcpSpec = read("specs/07-mcp.md");
const productSpec = read("specs/00-product.md");
const claudeMd = read("CLAUDE.md");
const rootPackageJson = read("package.json");

const docs: readonly (readonly [string, string])[] = [
  [HARVEST_CMD, harvest],
  [DOGFOOD_DOC, dogfoodDoc],
];

/** `specs/07`의 `### N. \`tool_name\`` 헤딩이 도구 이름의 정본이다. */
const specToolNames = [...mcpSpec.matchAll(/^### \d+\. `([a-z_]+)`/gm)].map(
  (match) => match[1] ?? "",
);

describe("커맨드 정의", () => {
  it("frontmatter의 description이 있다 — 없으면 커맨드 목록에서 고를 수 없다", () => {
    const frontmatter = /^---\n([\s\S]*?)\n---\n/.exec(harvest);
    expect(frontmatter, `${HARVEST_CMD}에 frontmatter가 없다`).not.toBeNull();
    expect(frontmatter?.[1] ?? "").toMatch(/^description: \S.*$/m);
  });

  it("주 1회 루틴이 문서화돼 있다 (T-024 Scope 2)", () => {
    expect(harvest).toContain("주 1회");
    expect(dogfoodDoc).toContain("주 1회");
  });
});

describe("도구 이름 — 정본은 specs/07", () => {
  it("specs/07에서 도구 5개를 읽어낸다 (파싱 자체의 회귀 방지)", () => {
    expect(specToolNames).toHaveLength(5);
  });

  it.each(docs)("%s가 스펙에 없는 도구 이름을 만들어내지 않는다", (_label, text) => {
    const mentioned = new Set(
      [...text.matchAll(/`((?:search|get|record|suggest|give)_[a-z_]+)`/g)].map(
        (match) => match[1] ?? "",
      ),
    );
    for (const name of mentioned) {
      expect(specToolNames, `스펙에 없는 도구를 언급한다: ${name}`).toContain(name);
    }
  });

  it("수확은 `record_knowledge`를 부르지 않는다 — 인터뷰 프롬프트와의 경계", () => {
    // 경계가 무너지면 둘 다 안 쓰이게 된다. 문서가 그 금지를 명시하는지 본다.
    expect(harvest).toMatch(/record_knowledge`?를 부르지 않는다/);
    expect(dogfoodDoc).toContain("postmortem-interview");
  });

  it("`postmortem-interview`가 specs/07의 프롬프트 계약과 같은 이름이다", () => {
    expect(mcpSpec).toContain("`postmortem-interview`");
    expect(existsSync(join(repoRoot, "packages/mcp/src/prompts/postmortem-interview.md"))).toBe(
      true,
    );
  });
});

describe("초안 포맷 — 문서가 요구하는 헤딩이 실제 태스크 스펙의 헤딩과 같다", () => {
  /** T-024 Acceptance 2가 이름을 못박은 세 헤딩. */
  const REQUIRED = ["## Scope", "## Acceptance", "## Context budget"] as const;

  const taskSpecs = readdirSync(join(repoRoot, "specs/tasks"))
    .filter((name) => /^T-\d{3}-.+\.md$/.test(name))
    .map((name) => [name, read(join("specs/tasks", name))] as const);

  /**
   * 커맨드의 ```markdown 펜스 안쪽 = 초안 템플릿 본체.
   *
   * **파일 전체가 아니라 이 블록만 본다.** 산문에서 `harvested-from:`을 언급하는 것과
   * 템플릿이 그 줄을 갖는 것은 다른 일인데, 파일 전체를 대상으로 하면 템플릿에서 그 줄을
   * 지워도 산문 언급 때문에 가드가 통과한다 — 실제로 뮤테이션 M3이 그렇게 살아남았다.
   */
  const template = /```markdown\n([\s\S]*?)```/.exec(harvest)?.[1] ?? "";

  it("태스크 스펙 파일을 실제로 찾아낸다", () => {
    expect(taskSpecs.length).toBeGreaterThan(10);
  });

  it("커맨드에 초안 템플릿 블록이 있다 (아래 단언들의 전제)", () => {
    expect(template.length).toBeGreaterThan(100);
  });

  it.each(REQUIRED)("초안 템플릿 **안에** `%s`가 있다", (heading) => {
    expect(template, `템플릿 블록에 ${heading}가 없다`).toContain(heading);
  });

  it.each(REQUIRED)("기존 태스크 스펙이 전부 `%s`를 갖는다", (heading) => {
    for (const [name, text] of taskSpecs) {
      expect(text, `specs/tasks/${name}에 ${heading}가 없다`).toContain(`\n${heading}`);
    }
  });

  it("초안 템플릿이 출처 ID 줄을 갖는다 — 중복 방지의 유일한 근거원", () => {
    expect(template, "템플릿에 harvested-from: 줄이 없다").toContain("harvested-from:");
    // 근거 절도 템플릿 안에 있어야 한다. 없으면 "어느 레코드에서 왔는가"가 초안에서 사라진다.
    expect(template).toContain("## 근거");
    expect(dogfoodDoc).toContain("harvested-from:");
  });
});

describe("계측 — 문서의 경로·숫자가 코드 상수와 같다", () => {
  it.each(docs)("%s가 이벤트 로그 경로를 정확히 인용한다", (_label, text) => {
    expect(text).toContain(DOGFOOD_LOG_PATH);
  });

  it("이벤트 로그 파일이 실재한다 (없으면 집계기가 exit 78로 죽는다)", () => {
    expect(existsSync(join(repoRoot, DOGFOOD_LOG_PATH))).toBe(true);
  });

  it("리포트 디렉터리와 파일명 규약이 문서와 코드에서 같다", () => {
    expect(dogfoodDoc).toContain(DOGFOOD_REPORT_DIR);
    expect(dogfoodReportFileName("2026-W34")).toBe("dogfood-2026-W34.json");
    // T-024 Scope 3이 못박은 이름: `eval/reports/dogfood-{week}.json`
    expect(`${DOGFOOD_REPORT_DIR}/${dogfoodReportFileName("2026-W34")}`).toBe(
      "eval/reports/dogfood-2026-W34.json",
    );
  });

  it("4주 목표가 specs/00 성공 지표에서 온 값이다", () => {
    // 스펙 원문: "도그푸딩 실기록 (4주) | >= 30건, 적중 >= 5건"
    const row = /도그푸딩 실기록[^|]*\|([^|]*)\|/.exec(productSpec);
    expect(row, "specs/00-product.md에서 도그푸딩 성공 지표 행을 찾지 못했다").not.toBeNull();
    const target = row?.[1] ?? "";
    expect(target).toContain(String(TARGET_RECORDS_4W));
    expect(target).toContain(String(TARGET_HITS_4W));
    expect(dogfoodDoc).toContain(String(TARGET_RECORDS_4W));
    expect(dogfoodDoc).toContain(String(TARGET_HITS_4W));
  });

  it("적중의 정의가 문서에 남아 있다 — searches.withResults와 혼동되면 지표가 거짓이 된다", () => {
    expect(dogfoodDoc).toContain("give_feedback");
    expect(dogfoodDoc).toMatch(/withResults[\s\S]{0,200}다른 것/);
  });
});

describe("CLAUDE.md 전제", () => {
  it("도그푸딩 프로토콜 절이 살아 있다 — 이 커맨드의 존재 이유다", () => {
    expect(claudeMd).toContain("## 도그푸딩 프로토콜");
    for (const name of ["search_knowledge", "record_knowledge"]) {
      expect(claudeMd).toContain(name);
    }
  });
});

describe("문서가 참조하는 것이 실재한다", () => {
  const topLevel = new Set(readdirSync(repoRoot));

  /**
   * 백틱 안의 레포 상대 경로만 고른다. `{week}` 같은 자리표시자(중괄호·별표)와
   * `sentinel-kb.search_knowledge`처럼 첫 조각이 디렉터리가 아닌 것은 자동으로 빠진다.
   */
  function repoPathsIn(text: string): string[] {
    const found = new Set<string>();
    for (const match of text.matchAll(/`([^`\s]+\/[^`\s]*)`/g)) {
      const raw = (match[1] ?? "").replace(/[.,)]+$/, "");
      if (/[{}*]/.test(raw)) continue;
      const head = raw.split("/")[0] ?? "";
      if (!topLevel.has(head)) continue;
      found.add(raw);
    }
    return [...found];
  }

  it.each(docs)("%s가 인용한 모든 레포 경로가 존재한다", (label, text) => {
    const paths = repoPathsIn(text);
    expect(paths.length, `${label}에서 경로를 하나도 못 찾았다 — 정규식 회귀 의심`).toBeGreaterThan(
      3,
    );
    for (const path of paths) {
      expect(existsSync(join(repoRoot, path)), `${label}가 없는 경로를 가리킨다: ${path}`).toBe(
        true,
      );
    }
  });

  it.each(docs)("%s가 아직 없는 pnpm 스크립트를 안내하지 않는다", (label, text) => {
    const scripts = new Set(
      Object.keys(
        (JSON.parse(rootPackageJson) as { scripts?: Record<string, string> }).scripts ?? {},
      ),
    );
    const builtins = new Set(["exec", "run", "install", "add", "dlx"]);
    for (const match of text.matchAll(/\bpnpm ([a-z][a-z0-9:_-]*)/g)) {
      const token = match[1] ?? "";
      if (builtins.has(token)) continue;
      expect(
        scripts.has(token),
        `${label}가 package.json에 없는 \`pnpm ${token}\`를 안내한다`,
      ).toBe(true);
    }
  });

  it.each(docs)("%s에 리터럴 Bearer 토큰이 없다", (label, text) => {
    const literal = [...text.matchAll(/Bearer ([A-Za-z0-9._-]+)/g)].map((match) => match[1] ?? "");
    expect(literal, `${label}에 리터럴 토큰이 박혀 있다`).toEqual([]);
  });
});

/**
 * 워크드 예시(`docs/dogfooding.md` §6)가 인용한 사실들.
 *
 * 이 블록이 이 파일의 핵심이다. 예시는 "지어내지 않았다"는 주장을 담고 있는데,
 * 그 주장은 **시드와 다른 파일이 그대로일 때만** 참이다. 여기서 매번 대조한다.
 */
describe("워크드 예시의 사실 대조", () => {
  interface SeedRecord {
    readonly type: string;
    readonly title: string;
    readonly correction?: string;
    readonly context?: { readonly tool?: string };
  }

  function seedsIn(dir: string): { id: string; record: SeedRecord }[] {
    return readdirSync(join(repoRoot, dir))
      .filter((name) => name.endsWith(".json"))
      .map((name) => ({
        id: name.replace(/\.json$/, ""),
        record: JSON.parse(read(join(dir, name))) as SeedRecord,
      }));
  }

  const seeds = [
    ...seedsIn("packages/core/seed/divergence"),
    ...seedsIn("packages/core/seed/self"),
  ];
  const divergences = seeds.filter((entry) => entry.record.type === "divergence");
  const byId = new Map(seeds.map((entry) => [entry.id, entry.record]));

  it("divergence 시드가 5건 이상이다 — Acceptance 1의 입력 조건", () => {
    expect(divergences.length).toBeGreaterThanOrEqual(5);
  });

  it.each(["SELF-03", "SELF-05", "DIV-01"])(
    "%s가 실재하고 divergence이며 문서가 인용한 제목과 같다",
    (id) => {
      const record = byId.get(id);
      expect(record, `시드 ${id}가 없다`).toBeDefined();
      expect(record?.type).toBe("divergence");
      expect(dogfoodDoc, `문서가 ${id}의 제목을 다르게 적었다`).toContain(record?.title ?? " ");
    },
  );

  it("클러스터 3건의 `context.tool`이 서로 다르다 — '축이지 습관이 아니다'의 근거", () => {
    const tools = ["SELF-03", "SELF-05", "DIV-01"].map((id) => byId.get(id)?.context?.tool ?? "");
    expect(new Set(tools).size).toBe(3);
    for (const tool of tools) expect(dogfoodDoc).toContain(tool);
  });

  it.each([
    ["SELF-03", "주석·문서의 주장은 반드시 실행 가능한 검증"],
    ["SELF-05", "문서 간 참조는 사람이 지키는 규율이 아니라 기계가 검사하는 제약으로 만든다"],
    ["DIV-01", "스펙 표기와 Zod optional 여부를 대조하는 검사"],
  ])("%s에서 인용한 correction 문구가 원문에 실재한다", (id, fragment) => {
    expect(byId.get(id)?.correction ?? "", `${id}의 correction에 없는 문구다`).toContain(fragment);
    expect(dogfoodDoc).toContain(fragment);
  });

  it("DIV-01…06의 `context.tool`이 전부 implementer 루프다 (문서의 '도구가 셋 다 다르다' 대비군)", () => {
    for (const entry of seeds.filter((item) => item.id.startsWith("DIV-"))) {
      expect(entry.record.context?.tool ?? "").toContain("implementer 에이전트 (task-loop");
    }
  });

  it("spec-drift-check가 CI에서 아직 경고로만 돈다 — 고쳐지면 이 문단을 고쳐야 한다", () => {
    const ci = read(".github/workflows/ci.yml");
    expect(ci).toContain("spec-drift-check.sh");
    expect(
      /spec-drift-check\.sh \|\| echo "::warning::/.test(ci),
      "ci.yml이 더 이상 경고로 넘기지 않는다 — docs/dogfooding.md §6의 '부분 적용' 판정이 낡았다",
    ).toBe(true);
  });

  it("`3.5 접근 전환 규칙`이 아직 task-loop 스킬에 없다 — 들어가면 §6 마지막 문단을 지운다", () => {
    const skill = read(TASK_LOOP_SKILL);
    expect(
      skill.includes("접근 전환 규칙"),
      `${TASK_LOOP_SKILL}에 접근 전환 규칙이 들어왔다 — docs/dogfooding.md §6의 '오늘도 없다'가 거짓이 됐다`,
    ).toBe(false);
    expect(dogfoodDoc).toContain("접근 전환 규칙");
    expect(existsSync(join(repoRoot, "docs/analysis/T-004-POSTMORTEM.md"))).toBe(true);
  });

  it("예시가 실행 결과가 아님을 명시한다 — 지어낸 수확으로 읽히면 안 된다", () => {
    expect(dogfoodDoc).toContain("실제로 수확을 실행해 만든 결과가 아니다");
    expect(dogfoodDoc).toContain("판정할 수 없는 것");
  });
});
