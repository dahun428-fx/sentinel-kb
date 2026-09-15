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
 *
 * ## T-043: 자기충족의 단위는 상수 하나가 아니라 `{상수, 그 상수의 문서 거울}` 쌍이다
 *
 * T-041의 스캐너는 `expect(x).<matcher>(CONST)` — 기대값 자리의 **맨 식별자**만 봤다.
 * 그런데 실제로 이 레포에서 상수를 지켜 온 단언 대다수는 그 형태가 아니라 **거울 대조**였다:
 * 상수를 `.env.example`이나 `specs/**` 문면에 보간해 `toContain`으로 맞춰 보는 형태다.
 *
 * 거울 대조는 잠금이 아니다. 특히 `.env.example`에는 **사람 승인 게이트가 없어서**,
 * 상수와 그 문서를 같은 커밋에서 옮기는 것이 게이트를 통과하는 가장 싼 길이 된다 —
 * T-041이 없애려던 형태가 한 층 위에서 그대로 재현된다.
 * (specs/**를 거울로 쓰는 것은 스펙 개정이 인간 승인 사항이라 상대적으로 낫다.)
 *
 * 그래서 스캐너가 거울 대조 사이트를 **따로 세고**(`ConstantFinding.mirrorSites`),
 * 거울밖에 없는 상수를 "행동으로 잠김"이라 주장하면 래칫이 막는다
 * (`mirrorOnlyBehaviourallyAnchored`).
 */
import { readdirSync, readFileSync } from "node:fs";
import { dirname, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";

export const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");

/** 스캔 대상 루트. `dist`·`node_modules`는 빌드 산출물이라 제외한다. */
const SCAN_ROOTS = ["packages", "eval", "tools"] as const;
const SKIP_DIRS = new Set(["node_modules", "dist", ".git", "coverage", ".turbo"]);

/** 값 비교 매처만 본다. `toThrow` 등은 기대값이 상수여도 성질이 다르다. */
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

/**
 * **거울 대조 매처**(T-043). 기대값이 **문서·문자열**이고 상수가 그 안에 보간되는 형태다:
 *
 * ```ts
 * expect(envExample).toContain(`\n${name}=${String(value)}\n`);   // config.spec.ts
 * expect(target).toContain(String(TARGET_RECORDS_4W));            // harvest-docs.spec.ts
 * ```
 *
 * 값 비교 매처와 **성질이 다르므로 따로 센다.** 이런 사이트는 상수를 잠그지 않는다 —
 * 상수와 그 거울 문서를 **같은 커밋에서 함께** 옮기면 그대로 통과하기 때문이다.
 * 자기충족의 단위가 상수 하나가 아니라 `{상수, 그 상수의 문서 거울}` **쌍**이라는 뜻이다.
 */
const MIRROR_MATCHERS = ["toContain", "toMatch", "toContainEqual"] as const;

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
  /** 값 비교 사이트. 기대값 자리에 이 상수가 **맨 식별자**로 온 자리들이다. */
  readonly sites: readonly AssertionSite[];
  /**
   * **거울 대조 사이트.** 상수가 문서 문자열 안에 보간돼 대조되는 자리(`MIRROR_MATCHERS` 주석).
   * 잠금의 증거가 아니다 — 거울을 같이 옮기면 죽지 않는다.
   */
  readonly mirrorSites: readonly AssertionSite[];
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
 * `open` 위치에서 시작하는 괄호 쌍의 **내용**과 닫는 위치를 돌려준다.
 * 정규식만으로는 `toContain(\`${a}(${b})\`)`처럼 중첩된 인자를 잘라낼 수 없다.
 */
function balancedSlice(
  source: string,
  openIndex: number,
  open: string,
  close: string,
): { readonly inner: string; readonly end: number } {
  let depth = 0;
  for (let i = openIndex; i < source.length; i += 1) {
    if (source[i] === open) depth += 1;
    else if (source[i] === close) {
      depth -= 1;
      if (depth === 0) return { inner: source.slice(openIndex + 1, i), end: i };
    }
  }
  return { inner: "", end: source.length };
}

const lineOf = (source: string, index: number): number => source.slice(0, index).split("\n").length;

/** 리포트에 싣기 좋게 한 줄로 줄인다. 긴 템플릿 리터럴이 그대로 들어오면 읽을 수 없다. */
function condense(expression: string): string {
  const flat = expression.replace(/\s+/g, " ").trim();
  return flat.length > 80 ? `${flat.slice(0, 77)}...` : flat;
}

/**
 * 기대값 자리에 **import한 식별자**가 오는 단언 사이트와, 상수가 문서 문자열에 보간되는
 * **거울 대조** 사이트를 전부 모은다.
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
  const mirrorCall = new RegExp(String.raw`\.(?:${MIRROR_MATCHERS.join("|")})\(`, "g");
  /** `for (const [name, value] of Object.entries(CONST)) {` — 루프 변수로 갈아탄 보간. */
  const mirrorLoop =
    /for\s*\([^)]*?\bof\s+Object\.(?:entries|keys|values)\(\s*([A-Za-z_$][\w$]*)\s*\)\s*\)\s*\{/g;

  const findings = new Map<
    string,
    {
      modules: Set<string>;
      sites: AssertionSite[];
      mirrorSites: AssertionSite[];
      hasLiteralAnchor: boolean;
    }
  >();
  const entryFor = (constant: string, specifier: string) => {
    const entry = findings.get(constant) ?? {
      modules: new Set<string>(),
      sites: [],
      mirrorSites: [],
      hasLiteralAnchor: false,
    };
    entry.modules.add(specifier);
    findings.set(constant, entry);
    return entry;
  };

  for (const { file, source } of sources) {
    const imports = parseNamedImports(source);
    /** 이 파일이 import한, 픽스처가 아닌 식별자들. */
    const live = [...imports].filter(([, specifier]) => !isFixtureModule(specifier));

    for (const match of source.matchAll(expectedIsIdentifier)) {
      const expression = match[1];
      if (expression === undefined) continue;
      const root = expression.split(".")[0];
      if (root === undefined) continue;
      const specifier = imports.get(root);
      if (specifier === undefined || isFixtureModule(specifier)) continue;

      entryFor(root, specifier).sites.push({
        file,
        line: lineOf(source, match.index),
        expression,
      });
    }

    // (a) 상수가 거울 대조 매처의 인자 안에 직접 보간되는 형태.
    for (const match of source.matchAll(mirrorCall)) {
      const { inner } = balancedSlice(source, match.index + match[0].length - 1, "(", ")");
      for (const [name, specifier] of live) {
        if (!new RegExp(String.raw`(?<![\w$.])${name}(?![\w$])`).test(inner)) continue;
        entryFor(name, specifier).mirrorSites.push({
          file,
          line: lineOf(source, match.index),
          expression: condense(inner),
        });
      }
    }

    /*
     * (b) `Object.entries(CONST)` 루프 안에서 **루프 변수로 갈아탄** 보간.
     * `config.spec.ts:111`이 정확히 이 형태라 (a)만으로는 보이지 않는다.
     * 루프 본문 전체를 그 상수의 거울로 친다 — 거울 증거를 넓게 잡는 쪽이 안전하다.
     * 이 분류는 "행동으로 잠김"을 **약화**시키는 방향이므로 과대추정이 위험하지 않다.
     */
    for (const match of source.matchAll(mirrorLoop)) {
      const constant = match[1];
      if (constant === undefined) continue;
      const specifier = imports.get(constant);
      if (specifier === undefined || isFixtureModule(specifier)) continue;
      const bodyStart = match.index + match[0].length - 1;
      const { inner } = balancedSlice(source, bodyStart, "{", "}");
      for (const call of inner.matchAll(new RegExp(mirrorCall.source, "g"))) {
        const { inner: arg } = balancedSlice(inner, call.index + call[0].length - 1, "(", ")");
        entryFor(constant, specifier).mirrorSites.push({
          file,
          line: lineOf(source, bodyStart + 1 + call.index),
          expression: condense(arg),
        });
      }
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
      mirrorSites: entry.mirrorSites,
      hasLiteralAnchor: entry.hasLiteralAnchor,
    }))
    .sort((a, b) => a.constant.localeCompare(b.constant));
}

/**
 * **리터럴 앵커가 반드시 있어야 하는 상수.** 그 상수를 쓰는 단언이 전부 자기충족이거나
 * 거울 대조뿐이라, 상수만 바꾸면(혹은 상수와 거울을 같이 옮기면) 스위트가 통과하는 것들이다.
 *
 * 값은 **왜 그 리터럴인가**의 인용이다 — 스펙 조항이 있으면 조항을, 스펙이 숫자를 정하지
 * 않았으면 그 값을 고른 **설계 근거의 출처**를 적는다(`ARTICLE_SOURCE_COUNT`가 그 선례다).
 * 근거가 스펙 조항이 아니라고 해서 앵커를 생략하면, 그 값은 아무도 모르게 흘러간다.
 *
 * 함께 적는 것: **실측한 뮤턴트와 killer `파일:라인`.** 주장이 아니라 관측이어야 한다(T-043).
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
  ARTICLE_SOURCE_COUNT:
    "specs/08 §1 B 패턴 하한 3 + 여유 1. **래칫이 실제로 잡은 첫 신규 건이다** — " +
    "`loadArticleSources`가 이 상수만큼 읽으므로 기대값으로 쓰면 자기충족이다. " +
    "실측: 4→9 뮤턴트 생존 → 리터럴 앵커 추가 후 사망(2건).",

  /* 아래 다섯은 T-041이 `BEHAVIOURALLY_ANCHORED`에 잘못 넣었던 것을 T-043이 옮긴 것이다. */

  RETRIEVAL_DEFAULTS:
    "specs/03 §2 문면(`RETRIEVAL_NUM_CANDIDATES=200`, record당 2청크) + §6 스윕 파라미터 " +
    "다섯의 **커밋된 기본값**. 실측(T-043): 200→150·8→6·20→15·20→15·60→30·4→5·2→4 일곱 " +
    "뮤턴트를 `.env.example`과 **함께** 옮기면 전건 생존했다 — 유일한 대조가 " +
    "`packages/core/src/retriever/config.spec.ts:163`의 `.env.example` 거울이고 그 문서에는 " +
    "사람 승인 게이트가 없다. 앵커 후 killer: `packages/core/src/retriever/config.spec.ts:118`. " +
    "스윕은 env로 하므로(같은 파일 129행 테스트) 앵커가 §6을 막지 않는다.",
  DEFAULT_MAX_INPUT_CHARS:
    "T-004 결정 4 입력 길이 상한(`.env.example` `SANITIZE_MAX_INPUT_CHARS=65536`). " +
    "실측(T-043): 65536→70000을 `.env.example`과 함께 옮기면 **전건 생존**했다. " +
    "T-041이 적은 '65536→131072 사망'은 극단값이고, 그때 죽은 것도 던지는 테스트가 아니라 " +
    "`sanitize.property.spec.ts`의 벽시계 단언이었다(T-045가 걷어낼 예정이라 근거가 못 된다). " +
    "앵커 후 killer: `packages/core/src/sanitizer/sanitize.spec.ts:775`(리터럴) + " +
    "`:781`(65537자가 실제로 던지는지 — 좌변이 상수에서 파생되지 않는 유일한 자리).",
  TARGET_RECORDS_4W:
    "specs/00 성공 지표 '도그푸딩 실기록 (4주) >= 30건'. 실측(T-043): 30→25의 유일한 killer는 " +
    "`tools/harvest-docs.spec.ts:161`의 **specs/00 문서 거울 대조**였다. T-041이 지목한 " +
    "`tools/dogfood-report.spec.ts:207`은 좌변이 `TARGET_RECORDS_4W`번 도는 자기충족 루프라 " +
    "죽지 않는다 — '좌변이 픽스처 실수치'라는 근거는 거짓이었다. " +
    "앵커 후 killer: `tools/dogfood-report.spec.ts:208`.",
  PIECE_MAX_CHARS:
    "스펙이 숫자를 정하지 않았다. 근거는 `eval/style/corpus.ts`의 상수 주석 — judge가 문체가 " +
    "아니라 **길이**를 재게 되는 것을 막는 값. 실측(T-043): 4000→3000이 전건 생존했다. " +
    "T-041이 적은 '4000→40 사망'은 극단값 착시다(40자에서는 오염 검사가 겹침을 못 찾아 죽은 " +
    "것이지 상한을 잰 것이 아니다 — T-041 자신이 M2에서 경고한 형태). " +
    "앵커 후 killer: `eval/style/corpus.spec.ts:77`.",
  DEFAULT_SERVER_SELECTION_TIMEOUT_MS:
    "스펙이 숫자를 정하지 않았다. T-003이 고른 폴백이고 `.env.example`이 같은 값을 적는다. " +
    "실측(T-043): 5000→8000을 `.env.example`과 함께 옮기면 전건 생존했다 — **값을 보는 단언이 " +
    "하나도 없었다.** `packages/core/src/db/client.spec.ts`의 테스트 **이름**만 5000ms를 " +
    "말하고 있었다. 앵커 후 killer: 같은 파일 `:88`(이름을 참으로 만드는 한 줄).",
};

/**
 * **행동으로 이미 잠긴 상수.** 단언의 좌변이 상수에서 파생되지 않은 **실제 데이터·동작**이라
 * 상수만 바꾸면 테스트가 죽는다. 자기충족이 아니므로 리터럴 앵커를 더해도 죽는 뮤턴트가 늘지 않는다.
 * 값은 **실측한 뮤턴트와 killer `파일:라인`**이다 — 주장이 아니라 관측이다.
 *
 * ## 여기 넣기 전에 (T-043이 비싸게 배운 것)
 *
 * T-041이 이 레지스트리에 적은 근거 중 **다섯 개가 사실이 아니었다.** 뮤턴트를 돌려 "죽었다"는
 * 것까지는 봤지만 **무엇이 죽였는지를 확인하지 않았고**, 그래서 세 가지를 놓쳤다:
 *
 * 1. **극단값 착시.** `PIECE_MAX_CHARS` 4000→**40**은 죽지만 4000→3000은 산다.
 *    죽인 것은 상한 단언이 아니라 40자에서 겹침을 못 찾은 오염 검사였다.
 *    T-041 자신이 M2에서 경고한 형태가 자기 레지스트리에 그대로 들어갔다.
 *    → **현실적 드리프트로만 재라.** 200→150, 8→6, 60→30, 65536→70000.
 * 2. **거울 대조를 행동으로 착각.** `RETRIEVAL_DEFAULTS`의 유일한 killer는 `.env.example`
 *    거울이었고, `TARGET_RECORDS_4W`의 유일한 killer는 specs/00 거울이었다.
 *    → **뮤턴트를 넣을 때 거울 문서도 같이 옮겨라.** 그게 현실의 커밋 모양이다.
 * 3. **벽시계 단언의 우연.** `DEFAULT_MAX_INPUT_CHARS`를 죽인 것은 "상한 초과가 던진다"가
 *    아니라 입력이 커져 느려진 `toBeLessThan(500)`이었다. 관계없는 뮤턴트에서도 산발적으로
 *    죽는다(T-043 실측). → **killer를 이름까지 읽어라.** 건수만 세면 이 셋을 전부 놓친다.
 */
export const BEHAVIOURALLY_ANCHORED: Readonly<Record<string, string>> = {
  GENERATOR_DEFAULTS:
    "SIMILARITY_THRESHOLD 0.62→**0.55**(현실적 드리프트) 사망(2건). killer: " +
    "`packages/core/src/generator/gate.spec.ts:21`, " +
    "`packages/core/src/generator/generate.spec.ts:71`. 좌변이 실제 게이트 판정이다.",
  LLM_DEFAULTS:
    "ANTHROPIC_TIMEOUT_MS 8000→12000 사망(1건) — killer가 " +
    "`packages/core/src/llm/config.spec.ts:84`의 `toBeLessThan(10_000)`이라 점이 아니라 " +
    "**경계**를 잠근다. 8000→9000은 계약 안이라 생존하고, 그게 맞다(동등 뮤턴트). " +
    "ANTHROPIC_MAX_RETRIES 1→2 사망(1건) — killer 같은 파일 `:88`.",
  EXPECTED_SCENARIO_COUNT:
    "20→**18** 사망(2건). killer: `eval/tools/scenarios.spec.ts:29`, 같은 파일 `:157`. " +
    "좌변이 커밋된 시나리오 파일의 실제 개수다.",
  EXPECTED_IRRELEVANT_COUNT:
    "5→**4** 사망(2건). killer: `eval/generation/cases.spec.ts:24`, 같은 파일 `:54`. " +
    "좌변이 실제 케이스 파일이다.",
  EXPECTED_CASE_COUNT:
    "15→**14** 사망(2건). killer: `eval/generation/cases.spec.ts:19`, 같은 파일 `:54`. " +
    "좌변이 실제 케이스 파일이다. 애초에 specs/05가 개수를 정하지 않았다(cases.ts 주석).",
  TEMPLATES_PER_KIND:
    "3→**2** 사망(2건). killer: `packages/core/src/publisher/templates.spec.ts:18`, " +
    "같은 파일 `:46`. 좌변이 실제 템플릿 배열이다.",
  PROMPT_TOKEN_BUDGET:
    "T-038 Acceptance가 기호만 참조하고 **숫자를 정하지 않았다**. 리터럴로 박으면 없는 계약을 만드는 것이라 하지 않는다 — T-041 Findings F-4의 스펙 공백 항목.",
  CONTROL_RECORD: "eval 코퍼스 픽스처다. 좌변이 실제 렌더 결과다.",
  HUMAN_SOURCES:
    "사람 글 소스 목록(경로 + 왜 사람 글인가). 좌변이 파일시스템에서 읽은 실제 글이라 " +
    "목록을 바꾸면 로드가 죽는다. 개수 하한 3은 별도 게이트가 리터럴로 잠근다.",
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
  ANTHROPIC_SELECTOR:
    "tool-selection selector의 provider 이름. 리포트 `selector.provider`는 자유 문자열이고 " +
    "어떤 스펙도 이 문면을 고정하지 않는다 — 단언의 주어는 '실 모델 경로를 세웠는가'이지 " +
    "그 이름의 철자가 아니다(SERVER_NAME과 같은 분류).",
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

/**
 * 거울 대조 말고는 단언이 하나도 없는 상수.
 *
 * 이런 상수는 **정의상 "행동으로 잠김"일 수 없다.** 좌변이 문서고 우변이 상수라,
 * 상수와 문서를 같은 커밋에서 옮기면 스위트가 그대로 초록이다.
 */
export function mirrorOnlyConstants(findings: readonly ConstantFinding[]): string[] {
  return findings
    .filter((finding) => finding.sites.length === 0 && finding.mirrorSites.length > 0)
    .map((finding) => finding.constant)
    .sort();
}

/**
 * **거울 대조뿐인데 `BEHAVIOURALLY_ANCHORED`에 들어간 상수.** 비어 있지 않으면 근거가 거짓이다.
 *
 * T-041이 정확히 이 실수를 했다: `TARGET_RECORDS_4W`의 근거를 "좌변이 픽스처에서 집계한
 * 실수치"라고 적었는데, 실제 killer는 `tools/harvest-docs.spec.ts:161`의 **문서 거울 대조**
 * 하나뿐이었다. 사람이 다시 틀리지 않게 기계가 판정한다.
 */
export function mirrorOnlyBehaviourallyAnchored(findings: readonly ConstantFinding[]): string[] {
  return mirrorOnlyConstants(findings).filter((name) => name in BEHAVIOURALLY_ANCHORED);
}

/**
 * 분류되지 않은 상수. 비어 있지 않으면 래칫이 깨진 것이다.
 *
 * **값 비교 사이트가 있는 상수만 본다.** 거울 대조 전용 상수(경로·이벤트명·문구 12종)까지
 * 분류를 강제하면 레지스트리가 두 배가 되는데, 그것들은 애초에 "값이 얼마인가"를 다투지
 * 않는다. 거울 전용 상수에 대한 판정은 `mirrorOnlyBehaviourallyAnchored`가 따로 한다 —
 * "행동으로 잠겼다"고 **주장할 때만** 막으면 충분하다.
 */
export function unclassifiedConstants(findings: readonly ConstantFinding[]): string[] {
  return findings
    .filter((finding) => finding.sites.length > 0)
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
