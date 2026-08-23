/**
 * 다이어그램 생성 + 컴파일 검증 루프 — specs/08-publishing.md §5.2, T-032.
 *
 * > "원인 연쇄(flowchart), 사건 타임라인(timeline) ... 은 LLM이 mermaid 코드로 생성하되,
 * >  **mermaid 파서로 컴파일 검증**하고 실패 시 에러 메시지와 함께 재생성(최대 2회),
 * >  재실패 시 해당 다이어그램만 생략한다. 깨진 다이어그램이 실리는 것보다 없는 편이 낫다."
 *
 * T-031 F-6이 비워 둔 슬롯이 여기다: §4의 순서 `팩트 대조 → 다이어그램 컴파일 검증(§5) →
 * draft 저장`. **파이프라인을 재설계하지 않는다** — `draftArticle`의 팩트 대조 뒤,
 * 패치 구성 앞에 끼운다. 실패는 반려가 아니라 **해당 다이어그램만 생략**이므로
 * `DraftRejectionReason`이 늘지 않는다.
 *
 * ## 게이트 다섯 — 순서가 곧 위험도다
 *
 * 한 시도가 통과해야 하는 관문은 다섯이고, **안전이 파서보다 앞이다.** 적대적일 수 있는
 * 문자열을 파서에 먼저 먹이지 않는다.
 *
 * 1. **비어 있지 않음** — 모델이 아무것도 안 냈다.
 * 2. **안전 게이트** (아래 "인젝션 경로" 참조).
 * 3. **헤더 일치** — 우리가 요청한 종류인가. 코드가 지정한 첫 줄을 그대로 요구한다.
 * 4. **컴파일 검증** — `compileMermaid`(실제 mermaid 파서). §5.2의 문면 그 자체다.
 *    파서가 낸 `diagramType`이 요청한 종류와 다르면 그것도 실패다 — `timeline`을 달라고
 *    했는데 `flowchart`가 오면 문법은 맞아도 요청을 이행하지 않은 것이다.
 * 5. **팩트 대조** — 아래.
 *
 * ## 팩트 대조를 다이어그램에도 건다 (이 파일의 존재 이유 절반)
 *
 * `factcheck.ts`의 `crossCheckFacts`는 **산문 본문만** 본다. 그리고 다이어그램은 팩트 대조
 * **뒤에** 붙으므로, 아무것도 하지 않으면 다이어그램은 대조를 한 번도 통과하지 않은 채
 * 발행물에 실린다. 그 구멍을 여기서 닫는다.
 *
 * 방법은 "라벨만 골라 뽑기"가 아니라 **거꾸로**다: mermaid **문법 토큰을 걷어내고 남은 전부**를
 * 주장 텍스트로 본다(`diagramClaimText`). 라벨 추출기는 괄호 문법 하나를 놓치면 그 라벨이
 * 검사를 통째로 빠져나가지만, 문법을 걷어내는 쪽은 놓친 문법이 **검사 대상에 남을 뿐**이라
 * 실패 방향이 안전하다. 노드 ID처럼 라벨이 아닌 토큰까지 검사에 들어오지만, 그것도
 * 브래킷 없는 노드는 ID가 곧 렌더되는 라벨이므로 검사받는 것이 맞다.
 *
 * 그 텍스트를 `crossCheckFacts`에 그대로 넘긴다. 즉 **다이어그램은 산문과 정확히 같은
 * 네 축(수치·날짜·레코드 ID·인용)으로 검사받는다.** 팩트 팩에 없는 날짜를 마디로 세우거나
 * 없는 건수를 라벨에 적으면 그 다이어그램은 버려진다.
 *
 * **못 잡는 것은 산문에서와 같다**(`factcheck.ts` 마지막 절): 인과 주장. "A가 B를 일으켰다"는
 * 화살표가 참인지 이 코드는 모른다. 다만 다이어그램에서는 그 축이 산문보다 **더 위험하다** —
 * 화살표는 단정문이고 조건절을 달 수 없다. 그래서 프롬프트 조항 2·5가 그 축을 받고
 * (`prompts/diagram.md`), 마지막 방어선은 §0-5의 사람 편집이다. Findings에 남긴다.
 *
 * ## 인젝션 경로 — T-031의 다섯 겹 중 여기에 적용되는 것
 *
 * T-031의 다섯 겹은 **입력**(레코드 → 프롬프트)에 걸려 있고, 이 단계는 그 산출물
 * (`renderNarrativeSource`의 결과)을 **그대로 받는다.** 즉 겹 1·2·3·5는 이미 통과한
 * 재료만 들어온다. 새로 필요한 것은 **출력 쪽**이다: 다이어그램은 산문과 달리 렌더러에서
 * **실행되는 지시문**(`click`·`href`·`%%{init}%%`)을 문법으로 갖기 때문이다.
 *
 * - **스크립트 허용목록**(`isAllowedProseScript`, 겹 4) — 입력에 걸린 그 함수를 **출력에도**
 *   건다. 한글+ASCII+닫힌 구두점 밖의 문자가 라벨에 있으면 그 다이어그램은 버린다.
 *   입력이 이미 걸러졌는데도 거는 이유는, 모델이 스스로 만들어 낼 수 있기 때문이다.
 * - **시크릿 형상**(`containsSecretShape`, 겹 5) — 같은 이유로 출력에도.
 * - **`detectInjection` 재판정**(겹 3) — 모델이 레코드의 인젝션 문장을 라벨로 옮겨 적는 경로.
 * - **상호작용·설정 지시문 차단** — 여기서 새로 세운다. 허용목록이 아니라 차단목록이라
 *   원리적으로 약하지만, mermaid 문법의 실행 지시문은 **닫힌 집합**이라 열거가 성립한다.
 *
 * ## 최대 2회는 계약이지 튜닝 값이 아니다
 *
 * `MAX_DIAGRAM_REGENERATIONS`는 `config.ts`에 없다 — `MAX_REWRITES`·`MAX_REGENERATIONS`와
 * 같은 규약이다. env로 열면 0으로 꺼서 검증 루프를 무력화할 수 있다.
 */
import { containsSecretShape } from "../facts/screen.js";
import type { ArticleFacts } from "../facts/types.js";
import type { ChatMessage, ChatModel } from "../llm/types.js";
import { detectInjection } from "../sanitizer/injection.js";

import { crossCheckFacts, type FactViolation } from "./factcheck.js";
import { isAllowedProseScript } from "./narrative.js";
import { loadDiagramPrompt } from "./prompt.js";

/**
 * specs/08 §5.2가 정한 재생성 횟수. **"최대 2회"는 스펙 문면이지 튜닝 값이 아니다.**
 * 한 다이어그램의 최악 모델 호출은 `1 + MAX_DIAGRAM_REGENERATIONS`다.
 */
export const MAX_DIAGRAM_REGENERATIONS = 2;

/** §5.2가 이름을 댄 다이어그램. "원인 연쇄(flowchart), 사건 타임라인(timeline)". */
export const DIAGRAM_KINDS = ["cause-chain", "timeline"] as const;
export type DiagramKind = (typeof DIAGRAM_KINDS)[number];

/** 시도 1건이 어디서 걸렸나. **생략은 조용할 수 없다** — 이 값이 리포트에 그대로 남는다. */
export const DIAGRAM_FAILURE_REASONS = [
  /** 모델이 빈 응답을 냈다. */
  "empty",
  /** 스크립트 허용목록·시크릿 형상·인젝션·실행 지시문 (인젝션 경로 참조). */
  "unsafe",
  /** 첫 줄이 요청한 헤더가 아니거나, 파서가 낸 종류가 요청과 다르다. */
  "wrong-type",
  /** mermaid 파서가 거부했다. §5.2의 "컴파일 실패". */
  "compile-error",
  /** 라벨의 수치·날짜·식별자·인용이 팩트 팩 밖이다 (§3). */
  "fact-violation",
] as const;

export type DiagramFailureReason = (typeof DIAGRAM_FAILURE_REASONS)[number];

export interface DiagramAttemptFailure {
  /** 1부터. `1`이 최초 생성, 그 뒤가 재생성이다. */
  readonly attempt: number;
  readonly reason: DiagramFailureReason;
  /** 파서 원문 오류·위반 값 등 **무엇이 왜 틀렸는지**. 재생성 지시문에 그대로 실린다. */
  readonly detail: string;
}

/** 다이어그램 한 종류의 결말. 채택이든 생략이든 **항상** 만들어진다. */
export interface DiagramOutcome {
  readonly kind: DiagramKind;
  readonly attempts: number;
  readonly accepted: boolean;
  /** mermaid가 판정한 종류. 컴파일까지 못 갔으면 `null`. */
  readonly diagramType: string | null;
  /** 시도마다의 실패. 채택돼도 앞선 실패는 남는다. */
  readonly failures: readonly DiagramAttemptFailure[];
  /** 생략됐으면 **마지막 실패 사유**. 채택됐으면 `null`. */
  readonly omitted: DiagramFailureReason | null;
}

/**
 * `articles.lintReport` 안에 실리는 다이어그램 감사 기록.
 *
 * `interface`가 아니라 `type`인 이유는 `DraftReport`와 같다 — `z.record(z.unknown())`에
 * 실리려면 암시적 인덱스 시그니처가 필요하고 TS는 그것을 타입 별칭에만 준다.
 */
// eslint-disable-next-line @typescript-eslint/consistent-type-definitions -- 위 주석 참조: 계약(z.record)에 실리려면 타입 별칭이어야 한다.
export type DiagramReport = {
  readonly diagramReportVersion: 1;
  /**
   * 다이어그램 모델이 주입됐는가. **`false`는 "다이어그램이 필요 없었다"가 아니라
   * "생성기를 못 받아 단계를 돌리지 못했다"이다** — 둘을 같은 값으로 접으면
   * 배치가 생성기를 안 넘기고 있는 것을 아무도 모른다.
   */
  readonly configured: boolean;
  readonly maxRegenerations: number;
  /** 팩트 팩이 재료를 대 준 종류들. 여기 없는 종류는 애초에 요청되지 않았다. */
  readonly requested: readonly DiagramKind[];
  /** 총 모델 호출 수. 최악 `requested.length * (1 + maxRegenerations)`. */
  readonly attempts: number;
  readonly accepted: number;
  readonly omitted: number;
  readonly diagrams: readonly DiagramOutcome[];
};

/** 본문에 삽입될 다이어그램 1건. */
export interface DiagramBlock {
  readonly kind: DiagramKind;
  /** 코드가 붙이는 소제목. **모델 출력이 아니다** — 그래서 팩트 대조 대상이 아니다. */
  readonly heading: string;
  /** 검증을 통과한 mermaid 코드 원문. */
  readonly code: string;
}

export interface DiagramStageResult {
  readonly blocks: readonly DiagramBlock[];
  readonly report: DiagramReport;
}

/** 한 종류의 계약. **종류를 모델이 고르지 않는다** — 헤더까지 코드가 지정한다. */
export interface DiagramSpec {
  readonly kind: DiagramKind;
  /** 본문에 붙는 소제목. */
  readonly heading: string;
  /** 코드가 지정하는 첫 줄. 모델이 종류를 고르지 않는다. */
  readonly header: string;
  /** mermaid가 낼 수 있는 `diagramType` 값들. */
  readonly diagramTypes: readonly string[];
  readonly instruction: string;
}

const DIAGRAM_SPECS: readonly DiagramSpec[] = [
  {
    kind: "cause-chain",
    heading: "원인 연쇄",
    header: "flowchart TD",
    diagramTypes: ["flowchart-v2", "flowchart"],
    instruction:
      "레코드의 rootCause·correction에 적힌 인과를 마디로 잇는 원인 연쇄를 그려라. " +
      "마디는 최대 7개, 화살표는 원인에서 결과 방향이다.",
  },
  {
    kind: "timeline",
    heading: "사건 타임라인",
    header: "timeline",
    diagramTypes: ["timeline"],
    instruction:
      "<facts>의 timeline 항목만 써서 사건 타임라인을 그려라. " +
      "각 줄은 `YYYY-MM-DD : 사건` 형태이고, 팩트 팩에 없는 날짜를 만들지 마라.",
  },
];

/** 타임라인 다이어그램의 재료 하한. 점이 하나면 그것은 타임라인이 아니다. */
const MIN_TIMELINE_ENTRIES = 2;

/** 렌더러에서 **실행되거나 설정을 바꾸는** mermaid 문법. 닫힌 집합이라 열거가 성립한다. */
const FORBIDDEN_CONSTRUCTS: readonly { readonly name: string; readonly pattern: RegExp }[] = [
  { name: "directive", pattern: /%%\{/ },
  { name: "click", pattern: /(?:^|\s)click\s/i },
  { name: "href", pattern: /(?:^|\s)href[\s(]/i },
  { name: "call", pattern: /(?:^|\s)call\s/i },
  { name: "html-tag", pattern: /<\s*\/?[a-zA-Z]/ },
  { name: "url-scheme", pattern: /:\/\// },
  { name: "style", pattern: /(?:^|\s)(?:classDef|linkStyle|style)\s/ },
];

/** ```mermaid 펜스. 모델이 붙여 오면 벗긴다 — 펜스는 본문 마크업이지 다이어그램이 아니다. */
const FENCE_OPEN_RE = /^```[a-zA-Z]*\s*$/;
const FENCE_CLOSE_RE = /^```\s*$/;

/** mermaid 주석. 주장 텍스트에서 걷어낸다. */
const MERMAID_COMMENT_RE = /^[ \t]*%%.*$/gm;
/** 화살표·연결선 문법. `2026-03-02`의 홑 `-`는 건드리지 않는다. */
const MERMAID_LINK_RE = /-{2,3}>|<-{2,3}|-\.->|-\.-|={2,3}>|={2,3}|-{2,3}|~{3}|o--o|x--x|:::/g;
/** 구조 키워드. 라벨이 아니라 문법이다. */
const MERMAID_KEYWORD_RE =
  /(^|\s)(?:subgraph|end|direction|section|title|accTitle|accDescr)(?=\s|$)/g;
/** 구분자. 벗겨 내면 남는 것이 곧 사람이 읽게 될 글자다. */
const MERMAID_DELIMITER_RE = /["'`|{}[\]()<>:;,@#&]/g;

export interface GenerateDiagramsOptions {
  /** 대조 기준. `draftArticle`이 본문 대조에 쓴 그 팩트 팩과 **같은 객체**다. */
  readonly facts: ArticleFacts;
  /** `renderFactsBlock`의 결과. 초안이 본 것과 같은 문자열을 그대로 받는다. */
  readonly factsBlock: string;
  /**
   * `renderNarrativeSource`의 결과. **초안이 본 것과 같은 재료다** — T-031의 다섯 겹을
   * 이미 통과한 산출물이라 이 단계가 입력 방어를 다시 만들지 않는다(파일 서두 참조).
   */
  readonly records: string;
  readonly model: ChatModel;
  readonly maxTokens: number;
}

/**
 * 요청 → 검증 통과한 다이어그램들. **본문을 만지지 않는다** — 삽입은 `draft.ts`가 한다.
 *
 * 한 종류의 실패가 다른 종류를 막지 않는다: §5.2가 "**해당** 다이어그램만 생략"이라고 못박았다.
 */
export async function generateDiagrams(
  options: GenerateDiagramsOptions,
): Promise<DiagramStageResult> {
  const specs = selectDiagramSpecs(options.facts);
  const blocks: DiagramBlock[] = [];
  const outcomes: DiagramOutcome[] = [];

  for (const spec of specs) {
    const outcome = await runDiagram(spec, options);
    outcomes.push(outcome.outcome);
    if (outcome.code !== null) {
      blocks.push({ kind: spec.kind, heading: spec.heading, code: outcome.code });
    }
  }

  return {
    blocks,
    report: buildReport({
      configured: true,
      requested: specs.map((spec) => spec.kind),
      diagrams: outcomes,
    }),
  };
}

/**
 * 생성기를 못 받았을 때의 리포트. **빈 리포트가 아니라 `configured: false`인 리포트다** —
 * "다이어그램이 없다"와 "다이어그램 단계를 돌리지 못했다"는 다른 사실이다.
 */
export function unconfiguredDiagramReport(facts: ArticleFacts): DiagramReport {
  return buildReport({
    configured: false,
    requested: selectDiagramSpecs(facts).map((spec) => spec.kind),
    diagrams: [],
  });
}

/** 팩트 팩이 재료를 대 주는 종류만 요청한다. **결정론이다** — 같은 팩트 팩이면 같은 목록. */
export function selectDiagramSpecs(facts: ArticleFacts): readonly DiagramSpec[] {
  return DIAGRAM_SPECS.filter(
    (spec) => spec.kind !== "timeline" || facts.timeline.length >= MIN_TIMELINE_ENTRIES,
  );
}

function buildReport(parts: {
  configured: boolean;
  requested: readonly DiagramKind[];
  diagrams: readonly DiagramOutcome[];
}): DiagramReport {
  return {
    diagramReportVersion: 1,
    configured: parts.configured,
    maxRegenerations: MAX_DIAGRAM_REGENERATIONS,
    requested: parts.requested,
    attempts: parts.diagrams.reduce((sum, diagram) => sum + diagram.attempts, 0),
    accepted: parts.diagrams.filter((diagram) => diagram.accepted).length,
    omitted: parts.diagrams.filter((diagram) => !diagram.accepted).length,
    diagrams: parts.diagrams,
  };
}

/**
 * 한 종류의 생성 + 검증 루프. **최초 1회 + 재생성 최대 2회 = 최악 3회 호출.**
 * 재생성 지시문에는 직전 코드와 **그것이 무엇을 어겼는지**가 실린다 —
 * 같은 프롬프트로 한 번 더 부르는 것은 재생성이 아니라 재추첨이다(T-020·T-031의 그 문장).
 */
async function runDiagram(
  spec: DiagramSpec,
  options: GenerateDiagramsOptions,
): Promise<{ outcome: DiagramOutcome; code: string | null }> {
  const system = loadDiagramPrompt();
  const userMessage = renderDiagramRequest(spec, options);
  const failures: DiagramAttemptFailure[] = [];

  let attempt = 0;
  let previous = "";

  while (attempt <= MAX_DIAGRAM_REGENERATIONS) {
    attempt += 1;
    const messages: ChatMessage[] =
      attempt === 1
        ? [{ role: "user", content: userMessage }]
        : [
            { role: "user", content: userMessage },
            { role: "assistant", content: previous },
            {
              role: "user",
              content: regenerateInstruction(spec, failures[failures.length - 1]),
            },
          ];

    const response = await options.model.complete({
      system,
      messages,
      maxTokens: options.maxTokens,
    });
    const code = stripFence(response.text);
    previous = code.length > 0 ? code : response.text.trim();

    const verdict = await verifyDiagram(spec, code, options.facts);
    if (verdict.ok) {
      return {
        outcome: {
          kind: spec.kind,
          attempts: attempt,
          accepted: true,
          diagramType: verdict.diagramType,
          failures,
          omitted: null,
        },
        code,
      };
    }
    failures.push({ attempt, reason: verdict.reason, detail: verdict.detail });
  }

  const last = failures[failures.length - 1];
  return {
    outcome: {
      kind: spec.kind,
      attempts: attempt,
      accepted: false,
      diagramType: null,
      failures,
      // 실패 목록이 비어 있을 수 없다 — 루프는 최소 한 번 돌고 통과하지 못했다.
      omitted: last?.reason ?? "empty",
    },
    code: null,
  };
}

type DiagramVerdict =
  | { readonly ok: true; readonly diagramType: string }
  | { readonly ok: false; readonly reason: DiagramFailureReason; readonly detail: string };

/**
 * 한 시도의 판정. 게이트 다섯을 순서대로 통과해야 한다(파일 서두).
 * **안전 게이트가 파서보다 앞이다** — 적대적일 수 있는 문자열을 먼저 먹이지 않는다.
 */
export async function verifyDiagram(
  spec: DiagramSpec,
  code: string,
  facts: ArticleFacts,
): Promise<DiagramVerdict> {
  if (code.trim().length === 0) {
    return { ok: false, reason: "empty", detail: "모델이 mermaid 코드를 내지 않았다." };
  }

  const unsafe = findUnsafeReason(code);
  if (unsafe !== undefined) {
    return { ok: false, reason: "unsafe", detail: unsafe };
  }

  const firstLine = code.split("\n")[0]?.trim() ?? "";
  if (firstLine !== spec.header) {
    return {
      ok: false,
      reason: "wrong-type",
      detail: `첫 줄이 \`${spec.header}\`가 아니라 \`${firstLine}\`다.`,
    };
  }

  const compiled = await compile(code);
  if (!compiled.ok) {
    return { ok: false, reason: "compile-error", detail: compiled.message };
  }
  if (!spec.diagramTypes.includes(compiled.diagramType)) {
    return {
      ok: false,
      reason: "wrong-type",
      detail: `파서가 판정한 종류가 \`${compiled.diagramType}\`다 — \`${spec.kind}\`가 아니다.`,
    };
  }

  const factCheck = crossCheckFacts(diagramClaimText(code), facts);
  if (!factCheck.passed) {
    return {
      ok: false,
      reason: "fact-violation",
      detail: describeViolations(factCheck.violations),
    };
  }

  return { ok: true, diagramType: compiled.diagramType };
}

/**
 * 실제 mermaid 파서 호출. 별도 함수인 이유는 `mermaid.ts`의 **지연 import**를
 * 이 파일 안에 가두기 위해서다 — publisher 배럴을 import하는 것만으로 80MB 패키지가
 * 로드되면 검색·MCP 경로가 값을 치른다(NFR-01).
 */
async function compile(
  code: string,
): Promise<{ ok: true; diagramType: string } | { ok: false; message: string }> {
  const { compileMermaid } = await import("./mermaid.js");
  const result = await compileMermaid(code);
  return result.ok
    ? { ok: true, diagramType: result.diagramType }
    : { ok: false, message: result.message };
}

/** 안전 게이트. 통과면 `undefined`, 아니면 **무엇에 걸렸는지**. */
export function findUnsafeReason(code: string): string | undefined {
  for (const construct of FORBIDDEN_CONSTRUCTS) {
    if (construct.pattern.test(code)) {
      return `렌더러에서 실행되거나 설정을 바꾸는 문법이 있다: ${construct.name}`;
    }
  }
  if (!isAllowedProseScript(code)) {
    return "한글·ASCII·허용 구두점 밖의 문자가 있다 (스크립트 허용목록, T-031 겹 4).";
  }
  if (containsSecretShape(code)) {
    return "시크릿 형상이 있다 (T-030 F-4).";
  }
  const injections = detectInjection(code);
  if (injections.length > 0) {
    return `인젝션 형상이 있다: ${injections.join(", ")}`;
  }
  return undefined;
}

/**
 * mermaid 문법을 걷어내고 남은 **주장 텍스트**. 파일 서두 "팩트 대조를 다이어그램에도 건다" 참조.
 *
 * 걷어내는 것은 문법뿐이다: 헤더 줄, 주석, 연결선, 구조 키워드, 구분자.
 * 남는 것은 라벨과 노드 ID이며 **둘 다 사람이 읽게 되는 글자다.**
 */
export function diagramClaimText(code: string): string {
  const withoutHeader = code.split("\n").slice(1).join("\n");
  return withoutHeader
    .replace(MERMAID_COMMENT_RE, " ")
    .replace(MERMAID_LINK_RE, " ")
    .replace(MERMAID_KEYWORD_RE, " ")
    .replace(MERMAID_DELIMITER_RE, " ")
    .split("\n")
    .map((line) => line.replace(/[ \t]+/g, " ").trim())
    .filter((line) => line.length > 0)
    .join("\n");
}

/** ```mermaid 펜스를 벗긴다. 없으면 그대로. */
export function stripFence(raw: string): string {
  const lines = raw.trim().split("\n");
  const first = lines[0]?.trim() ?? "";
  if (!FENCE_OPEN_RE.test(first)) return raw.trim();
  const rest = lines.slice(1);
  const closing = rest.findIndex((line) => FENCE_CLOSE_RE.test(line.trim()));
  return (closing === -1 ? rest : rest.slice(0, closing)).join("\n").trim();
}

/**
 * 요청 1건. `draft.ts`의 `renderDraftRequest`와 같은 데이터 프레이밍 규약이다(NFR-05) —
 * 블록마다 태그를 붙여야 시스템 프롬프트 조항 4가 `<record>`를 이름으로 지목할 수 있다.
 */
export function renderDiagramRequest(spec: DiagramSpec, options: GenerateDiagramsOptions): string {
  return [
    `<facts>\n${options.factsBlock}\n</facts>`,
    `<records>\n${options.records}\n</records>`,
    `<diagram kind="${spec.kind}">\n${spec.instruction}\n첫 줄은 정확히 \`${spec.header}\`여야 한다.\n</diagram>`,
    "위 재료로 mermaid 코드만 출력해라.",
  ].join("\n\n");
}

/**
 * 재생성 지시문. **결정론이다** — 같은 실패면 같은 문장이 나가야 eval이 재현된다.
 * 직전 코드는 싣지 않는다(바로 위 턴에 있다).
 */
export function regenerateInstruction(
  spec: DiagramSpec,
  failure: DiagramAttemptFailure | undefined,
): string {
  return [
    `직전 다이어그램이 검증을 통과하지 못했다 (${failure?.reason ?? "unknown"}).`,
    `- ${failure?.detail ?? "사유를 기록하지 못했다."}`,
    `첫 줄은 정확히 \`${spec.header}\`여야 한다.`,
    "라벨의 수치·날짜·식별자는 <facts>에 있는 것만 쓴다. 없는 것은 라벨에서 지워라.",
    "고치지 못하면 마디를 줄여라 — 지어내서 채우지 마라.",
  ].join("\n");
}

/** 위반을 한 줄로. 같은 값이 여러 번 나와도 `crossCheckFacts`가 이미 접었다. */
function describeViolations(violations: readonly FactViolation[]): string {
  return violations.map((violation) => `[${violation.kind}] ${violation.value}`).join(", ");
}

/**
 * 검증을 통과한 다이어그램을 본문 끝에 붙인다. §5.2의 "body에 코드 블록으로 삽입".
 *
 * **문체 린트 뒤에 붙는다**(§4의 순서가 그렇다). 소제목은 코드가 붙이므로 모델 출력이
 * 아니고, 코드 블록 하나가 늘어나는 것은 밀도 규칙을 완화가 아니라 강화 방향으로만 움직인다.
 */
export function appendDiagramBlocks(body: string, blocks: readonly DiagramBlock[]): string {
  if (blocks.length === 0) return body;
  const rendered = blocks
    .map((block) => `## ${block.heading}\n\n\`\`\`mermaid\n${block.code}\n\`\`\``)
    .join("\n\n");
  return `${body.trimEnd()}\n\n${rendered}\n`;
}

/**
 * 다이어그램 단계의 평평한 로그 필드. **specs/08 §5.2의 "생략"이 기록으로 남는 지점이다** —
 * `generator`의 `buildGroundingLogFields`와 같은 규약이다(T-020).
 *
 * **`null` 입력은 전부 `null`을 낸다. `0`이 아니다.** 반려로 단계에 도달하지 못한 아티클과
 * "돌렸고 생략이 없었다"를 같은 `0`으로 접으면, 생략률 집계의 분모가 조용히 부풀고
 * 다이어그램 생략이 실제보다 드물어 보인다.
 */
export interface DiagramLogFields {
  readonly diagramConfigured: boolean | null;
  readonly diagramRequested: number | null;
  readonly diagramAccepted: number | null;
  /** §5.2의 그 값. `> 0`이면 깨졌거나 근거 없는 다이어그램을 버렸다는 뜻이다. */
  readonly diagramOmitted: number | null;
  /** 생략된 종류와 사유(`timeline:compile-error`). **무엇이 왜 빠졌는지가 여기 남는다.** */
  readonly diagramOmittedReasons: string | null;
  readonly diagramAttempts: number | null;
}

export function buildDiagramLogFields(report: DiagramReport | null): DiagramLogFields {
  if (report === null) {
    return {
      diagramConfigured: null,
      diagramRequested: null,
      diagramAccepted: null,
      diagramOmitted: null,
      diagramOmittedReasons: null,
      diagramAttempts: null,
    };
  }
  return {
    diagramConfigured: report.configured,
    diagramRequested: report.requested.length,
    diagramAccepted: report.accepted,
    diagramOmitted: report.omitted,
    diagramOmittedReasons: report.diagrams
      .filter((diagram) => diagram.omitted !== null)
      .map((diagram) => `${diagram.kind}:${String(diagram.omitted)}`)
      .join(" "),
    diagramAttempts: report.attempts,
  };
}
