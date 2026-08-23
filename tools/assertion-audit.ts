/**
 * T-041 자기충족 단언 가드.
 *
 * **단언이 자기가 고정해야 할 상수를 기대값으로 쓰면, 그 상수를 바꾸는 것이 게이트를 통과하는
 * 가장 싼 길이 된다.** 이 레포에서 같은 형태가 세 번 게이트를 무력화했다
 * (T-003 `DB_INDEX_SPECS`, T-014 `MAX_TOOLS`, T-031 `MAX_REWRITES`).
 *
 * 이 모듈은 그 형태를 **기계가 다시 찾게** 만든다. 판정까지 하지는 않는다 —
 * 스캐너는 후보를 모으고, 사람이 아래 세 레지스트리 중 하나에 **명시적으로** 넣는다.
 * 어느 레지스트리에도 없는 상수가 생기면 `assertion-audit.spec.ts`가 깨진다(래칫).
 *
 * 왜 ESLint 규칙이 아닌가: 실측(T-041)으로 후보 104개 중 **가짜 양성이 98개**였다.
 * 오탐률 94%짜리 규칙은 억제 주석만 늘리고 아무것도 막지 못한다. 자세한 근거는
 * `specs/tasks/T-041-assertion-audit.md`의 "자동 가드" 절.
 */
import { readdirSync, readFileSync } from "node:fs";
import { dirname, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";

export const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");

/** 스캔 대상 루트. `dist`·`node_modules`는 빌드 산출물이라 제외한다. */
const SCAN_ROOTS = ["packages", "eval", "tools"] as const;
const SKIP_DIRS = new Set(["node_modules", "dist", ".git", "coverage", ".turbo"]);

/** 값 비교 매처만 본다. `toThrow`·`toContain` 등은 기대값이 상수여도 성질이 다르다. */
const MATCHERS = [
  "toBe",
  "toEqual",
  "toStrictEqual",
  "toHaveLength",
  "toBeCloseTo",
  "toBeLessThan",
  "toBeLessThanOrEqual",
  "toBeGreaterThan",
  "toBeGreaterThanOrEqual",
] as const;

export interface AssertionSite {
  /** 레포 루트 기준 경로. */
  readonly file: string;
  readonly line: number;
  /** 기대값 표현식 전체 (`LLM_DEFAULTS.ANTHROPIC_MAX_RETRIES` 등). */
  readonly expression: string;
}

export interface ConstantFinding {
  /** 기대값 표현식의 뿌리 식별자. 레지스트리 키다. */
  readonly constant: string;
  /** import 출처 모듈 지정자. */
  readonly modules: readonly string[];
  readonly sites: readonly AssertionSite[];
  /**
   * `expect(CONST...).<matcher>(<리터럴>)` 꼴 단언이 스위트 어딘가에 있는가.
   * 있으면 상수를 바꿀 때 **계약 테스트가 따로 죽는다**.
   */
  readonly hasLiteralAnchor: boolean;
}

function collectSpecFiles(root: string): string[] {
  const found: string[] = [];
  const walk = (dir: string): void => {
    let entries;
    try {
      entries = readdirSync(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries) {
      if (entry.isDirectory()) {
        if (!SKIP_DIRS.has(entry.name)) walk(join(dir, entry.name));
      } else if (entry.name.endsWith(".spec.ts")) {
        found.push(join(dir, entry.name));
      }
    }
  };
  walk(root);
  return found.sort();
}

/** `import { a, b as c } from "x"` → Map(로컬이름 → "x"). */
function parseNamedImports(source: string): Map<string, string> {
  const imports = new Map<string, string>();
  const pattern = /import\s+(?:type\s+)?\{([^}]*)\}\s*from\s*["']([^"']+)["']/gs;
  for (const match of source.matchAll(pattern)) {
    const [, clause, specifier] = match;
    if (clause === undefined || specifier === undefined) continue;
    for (const raw of clause.split(",")) {
      const trimmed = raw.trim().replace(/^type\s+/, "");
      if (trimmed === "") continue;
      const parts = trimmed.split(/\s+as\s+/);
      const local = (parts[1] ?? parts[0])?.trim();
      if (local !== undefined && local !== "") imports.set(local, specifier);
    }
  }
  return imports;
}

/** 테스트 자신의 픽스처는 자기충족이 아니다 — 입력과 기대값이 같은 것뿐이다(판정 기준 C1). */
function isFixtureModule(specifier: string): boolean {
  return specifier === "vitest" || specifier.startsWith("node:") || specifier.includes(".fixture");
}

/**
 * 기대값 자리에 **import한 식별자**가 오는 단언 사이트를 전부 모은다.
 *
 * 리터럴 앵커 판정은 같은 스캔 대상 전체에서 찾는다 — 앵커가 반드시 같은 파일에 있을
 * 이유는 없다(`EVAL_EXIT_CODES`는 `eval/retrieval`에서 앵커되고 `eval/generation`에서 쓰인다).
 */
export function scanImportedConstantAssertions(repoRoot: string = REPO_ROOT): ConstantFinding[] {
  const files = SCAN_ROOTS.flatMap((root) => collectSpecFiles(join(repoRoot, root)));
  const sources = files.map((absolute) => ({
    file: relative(repoRoot, absolute),
    source: readFileSync(absolute, "utf8"),
  }));

  const matcherAlternation = MATCHERS.join("|");
  // `.toBe(` 뒤에 식별자(+ 프로퍼티 접근)만 오고 인자가 끝나는 경우. 줄바꿈을 허용한다.
  const expectedIsIdentifier = new RegExp(
    String.raw`\.(?:${matcherAlternation})\(\s*([A-Za-z_$][\w$]*(?:\.[\w$]+)*)\s*[,)]`,
    "gs",
  );

  const findings = new Map<
    string,
    { modules: Set<string>; sites: AssertionSite[]; hasLiteralAnchor: boolean }
  >();

  for (const { file, source } of sources) {
    const imports = parseNamedImports(source);
    for (const match of source.matchAll(expectedIsIdentifier)) {
      const expression = match[1];
      if (expression === undefined) continue;
      const root = expression.split(".")[0];
      if (root === undefined) continue;
      const specifier = imports.get(root);
      if (specifier === undefined || isFixtureModule(specifier)) continue;

      const entry = findings.get(root) ?? {
        modules: new Set<string>(),
        sites: [],
        hasLiteralAnchor: false,
      };
      entry.modules.add(specifier);
      entry.sites.push({
        file,
        line: source.slice(0, match.index).split("\n").length,
        expression,
      });
      findings.set(root, entry);
    }
  }

  // `expect(CONST...).<matcher>(<리터럴>)` — 기대값이 식별자가 **아닌** 것만 앵커로 친다.
  for (const [constant, entry] of findings) {
    const anchor = new RegExp(
      String.raw`expect\(\s*${constant}(?:\.[\w$]+)*\s*\)\s*\.(?:${matcherAlternation})\(\s*(?![A-Za-z_$])`,
      "s",
    );
    entry.hasLiteralAnchor = sources.some(({ source }) => anchor.test(source));
  }

  return [...findings]
    .map(([constant, entry]) => ({
      constant,
      modules: [...entry.modules].sort(),
      sites: entry.sites,
      hasLiteralAnchor: entry.hasLiteralAnchor,
    }))
    .sort((a, b) => a.constant.localeCompare(b.constant));
}

/**
 * **리터럴 앵커가 반드시 있어야 하는 상수.** 값이 스펙이 정한 한도이고, 그 상수를 쓰는 단언이
 * 전부 자기충족이라 상수만 바꾸면 스위트가 통과하는 것들이다.
 * 값은 스펙 조항 인용 — 다음 사람이 리터럴이 왜 그 값인지 알아야 한다.
 */
export const LITERAL_ANCHOR_REQUIRED: Readonly<Record<string, string>> = {
  MCP_SEARCH_TOKEN_BUDGET:
    "specs/00 NFR-03 'MCP search 응답 <= 약 800 토큰'. 실측: 800→1200 뮤턴트가 276건 전건 통과했다(T-041).",
  NFR01_SEARCH_P95_MS:
    "specs/00 NFR-01 '검색 API p95 < 1.5s'. 실측: 1500→2000 도 1500→600000 도 546건 전건 통과했다(T-041).",
  MAX_RELATION_CHUNKS: "specs/03 §2.5 '최대 +3청크'. T-035가 이미 앵커했다.",
  TAINTED_CORPUS: "specs/05 Eval 4 '오염 레코드 10건'. T-021이 이미 앵커했다.",
  REQUIRED_PROMPT_CLAUSES: "specs/03 §4 시스템 프롬프트 필수 조항. T-018이 이미 앵커했다.",
  EVAL_EXIT_CODES: "CI가 종료 코드로 G4를 판정한다. T-013이 이미 앵커했다.",
};

/**
 * **행동으로 이미 잠긴 상수.** 단언의 좌변이 상수에서 파생되지 않은 **실제 데이터·동작**이라
 * 상수만 바꾸면 테스트가 죽는다. 자기충족이 아니므로 리터럴 앵커를 더해도 죽는 뮤턴트가 늘지 않는다.
 * 값은 **실측한 뮤턴트와 사망 건수**다 — 주장이 아니라 관측이다(T-041).
 */
export const BEHAVIOURALLY_ANCHORED: Readonly<Record<string, string>> = {
  GENERATOR_DEFAULTS: "SIMILARITY_THRESHOLD 0.62→0.40 뮤턴트 사망(3건). 게이트 판정이 실데이터다.",
  RETRIEVAL_DEFAULTS:
    "NUM_CANDIDATES 200→100 사망(1건), MAX_CHUNKS_PER_RECORD 2→3 사망(2건). 나머지 다섯은 specs/03 §6의 스윕 대상이라 애초에 고정 대상이 아니다.",
  DEFAULT_MAX_INPUT_CHARS: "65536→131072 뮤턴트 사망(1건). 상한 초과 입력이 실제로 던져야 한다.",
  LLM_DEFAULTS: "ANTHROPIC_TIMEOUT_MS 8000→12000 사망(1건), ANTHROPIC_MAX_RETRIES 1→2 사망(1건).",
  EXPECTED_SCENARIO_COUNT: "20→3 뮤턴트 사망(2건). 좌변이 커밋된 시나리오 파일의 실제 개수다.",
  EXPECTED_IRRELEVANT_COUNT: "5→1 뮤턴트 사망(2건). 좌변이 실제 케이스 파일이다.",
  EXPECTED_CASE_COUNT:
    "15→? 좌변이 실제 케이스 파일이라 사망한다. 애초에 specs/05가 개수를 정하지 않았다(cases.ts 주석).",
  TEMPLATES_PER_KIND: "3→1 뮤턴트 사망(2건). 좌변이 실제 템플릿 배열이다.",
  TARGET_RECORDS_4W: "30→25 뮤턴트 사망(1건). 좌변이 픽스처에서 집계한 실수치다.",
  DEFAULT_SERVER_SELECTION_TIMEOUT_MS:
    "좌변이 드라이버에 실제로 넘어간 옵션이다. 스펙이 5000을 문면에 박은 적도 없다.",
  PROMPT_TOKEN_BUDGET:
    "T-038 Acceptance가 기호만 참조하고 **숫자를 정하지 않았다**. 리터럴로 박으면 없는 계약을 만드는 것이라 하지 않는다 — T-041 Findings F-4의 스펙 공백 항목.",
  CONTROL_RECORD: "eval 코퍼스 픽스처다. 좌변이 실제 렌더 결과다.",
};

/**
 * **판별 태그.** 수치 한도가 아니라 **어느 분기를 탔는가**를 가리키는 문자열·열거·클래스 참조다.
 * 철자를 리터럴로 박아도 계약이 더 잠기지 않는다(판정 기준 C2).
 */
export const SYMBOLIC_CONSTANTS: Readonly<Record<string, string>> = {
  ANSWER_LOG_EVENT: "로그 이벤트명. 크기가 아니라 이름이라 리터럴로 박아도 잠기는 계약이 없다.",
  ANSWER_ROUTE: "라우트명 문자열. 단언의 주어는 '어느 라우트가 로깅됐는가'다.",
  SEARCH_LOG_EVENT: "로그 이벤트명. 크기가 아니라 이름이다.",
  SEARCH_ROUTE: "라우트명 문자열. 단언의 주어는 '어느 라우트가 로깅됐는가'다.",
  SERVER_NAME: "MCP 서버 이름 문자열. 크기가 아니라 이름이다.",
  ChunkBudgetError: "클래스 참조 동일성(배럴 재수출 확인). 리터럴이 존재할 수 없다.",
  DB_ERROR_CODES: "에러 코드 판별 태그. 단언의 주어는 '어느 실패 분기를 탔는가'다.",
  EMBEDDER_ERROR_CODES: "에러 코드 판별 태그. 단언의 주어는 '어느 실패 분기를 탔는가'다.",
  FACT_ERROR_CODES: "에러 코드 판별 태그. 단언의 주어는 '어느 실패 분기를 탔는가'다.",
  LLM_ERROR_CODES: "에러 코드 판별 태그. 단언의 주어는 '어느 실패 분기를 탔는가'다.",
  GATE_OUTCOMES: "게이트 결과 열거. 값의 크기가 아니라 분기의 이름이다.",
  SKIP_REASONS: "생략 사유 열거. 값의 크기가 아니라 분기의 이름이다.",
  NON_CLAIM_REASONS: "비주장 문장 사유 열거. 값의 크기가 아니라 분기의 이름이다.",
  NOT_FOUND_MESSAGE: "사용자 메시지 본문. 문면을 리터럴로 복사해도 잠기는 계약이 없다.",
  NO_RESULTS_TEXT: "사용자 메시지 본문. 문면을 리터럴로 복사해도 잠기는 계약이 없다.",
  STDIO_AUTH_FAILURE_MESSAGE: "사용자 메시지 본문. 문면 복사는 계약을 잠그지 않는다.",
  POSTMORTEM_INTERVIEW_PROMPT: "프롬프트 본문 동일성 확인. 본문 전체가 기대값이라 크기가 아니다.",
  EMBEDDING_DIM_PLACEHOLDER: "치환 토큰 문자열('${EMBEDDING_DIM}'). 크기가 아니다.",
  FIXTURE_IDS: "테스트 픽스처 레코드 식별자. 입력과 기대값이 같은 값일 뿐이다(C1).",
};

/** 분류되지 않은 상수. 비어 있지 않으면 래칫이 깨진 것이다. */
export function unclassifiedConstants(findings: readonly ConstantFinding[]): string[] {
  return findings
    .map((finding) => finding.constant)
    .filter(
      (name) =>
        !(name in LITERAL_ANCHOR_REQUIRED) &&
        !(name in BEHAVIOURALLY_ANCHORED) &&
        !(name in SYMBOLIC_CONSTANTS),
    )
    .sort();
}

/** 두 레지스트리 이상에 들어간 상수. 분류가 겹치면 판정이 모호해진다. */
export function doublyClassifiedConstants(): string[] {
  const names = [
    ...Object.keys(LITERAL_ANCHOR_REQUIRED),
    ...Object.keys(BEHAVIOURALLY_ANCHORED),
    ...Object.keys(SYMBOLIC_CONSTANTS),
  ];
  return [...new Set(names.filter((name, index) => names.indexOf(name) !== index))].sort();
}

/** 리터럴 앵커가 있어야 하는데 없는 상수. 비어 있지 않으면 계약이 열려 있다. */
export function missingLiteralAnchors(findings: readonly ConstantFinding[]): string[] {
  return findings
    .filter((finding) => finding.constant in LITERAL_ANCHOR_REQUIRED && !finding.hasLiteralAnchor)
    .map((finding) => finding.constant)
    .sort();
}
