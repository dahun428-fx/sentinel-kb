/**
 * mermaid 컴파일 검증 — specs/08-publishing.md §5.2.
 *
 * > "**mermaid 파서로 컴파일 검증**하고 실패 시 에러 메시지와 함께 재생성(최대 2회),
 * >  재실패 시 해당 다이어그램만 생략한다."
 *
 * ## 왜 정규식이 아니라 진짜 파서인가
 *
 * "```mermaid로 시작하는가"나 "화살표가 있는가"를 세는 것은 **검증이 아니라 형태 확인**이다.
 * §5.2가 막으려는 것은 "깨진 다이어그램이 발행물에 실리는 것"이고, 깨짐의 정의는
 * 렌더러(mermaid)가 거부하느냐다. 그 판정을 흉내 내는 규칙을 우리가 쓰면, 규칙이 통과시키고
 * 렌더러가 거부하는 구간이 곧바로 생긴다 — 그 구간이 정확히 발행 사고가 나는 자리다.
 * 그래서 여기서는 **렌더러가 실제로 쓰는 파서를 그대로 부른다.**
 *
 * ## DOM shim — mermaid를 Node에서 부르기 위해 치른 값
 *
 * `mermaid.parse()`는 파싱만 하지만, 모듈이 `dompurify`를 통해 `window`를 잡는다.
 * DOM이 없으면 dompurify가 기능 없는 스텁을 돌려주고 파싱 성공 직후
 * `DOMPurify.addHook is not a function`으로 죽는다 — **문법 오류와 구별되지 않는 실패**다.
 * 그래서 mermaid를 import하기 **전에** 최소 DOM을 전역에 심는다.
 *
 * `jsdom`이 아니라 `linkedom`을 고른 이유는 크기다(설치 기준 2.5MB vs 8.3MB, 전이 의존 5개).
 * 우리는 렌더링을 하지 않으므로 레이아웃·CSSOM·이벤트 루프가 필요 없고, dompurify가 요구하는
 * 것은 `document.implementation`을 가진 문서 객체 하나다. 두 구현 모두에서
 * flowchart·timeline·stateDiagram·sequence의 통과/실패 판정이 동일한 것을 확인하고 골랐다.
 *
 * **이미 DOM이 있으면 건드리지 않는다.** 브라우저나 jsdom 환경에서 이 모듈을 부를 때
 * 남의 `document`를 갈아 끼우면 그쪽이 조용히 깨진다.
 *
 * ## 비용은 숨기지 않는다
 *
 * `mermaid`는 무거운 패키지다(node_modules 기준 80MB대, d3·cytoscape·katex를 끌고 온다).
 * 그래서 **배럴에서 정적 import하지 않는다** — `compileMermaid`가 처음 불릴 때만
 * 동적 import한다. 검색·MCP 경로(NFR-01)는 이 모듈을 부르지 않으므로 그 비용을 지지 않고,
 * 값을 치르는 것은 아티클 배치뿐이다(§7의 리소스 격리).
 */

/** 파서가 받아들였다. `diagramType`은 mermaid가 판정한 종류(`flowchart-v2`·`timeline` 등). */
export interface MermaidCompileOk {
  readonly ok: true;
  readonly diagramType: string;
}

/** 파서가 거부했다. `message`는 **파서가 낸 원문**이며 재생성 지시문에 그대로 실린다. */
export interface MermaidCompileError {
  readonly ok: false;
  readonly message: string;
}

export type MermaidCompileResult = MermaidCompileOk | MermaidCompileError;

interface MermaidParseResult {
  readonly diagramType: string;
}

type MermaidParse = (code: string) => Promise<MermaidParseResult | false>;

let parsePromise: Promise<MermaidParse> | undefined;

/**
 * mermaid 문법 검증 1건. **본문을 고치지 않는다** — 판정만 하고 생략은 호출자가 한다.
 *
 * 파서가 던지는 것은 문법 오류(`Parse error on line N: ...`)와
 * 종류 미검출(`UnknownDiagramError`) 둘 다이며, 둘 다 §5.2의 "컴파일 실패"다.
 */
export async function compileMermaid(code: string): Promise<MermaidCompileResult> {
  const text = code.trim();
  if (text.length === 0) {
    return { ok: false, message: "빈 다이어그램이다 — 파서에 넘길 코드가 없다." };
  }

  const parse = await loadMermaidParse();
  try {
    const result = await parse(text);
    if (result === false) {
      return { ok: false, message: "mermaid 파서가 다이어그램을 인식하지 못했다." };
    }
    return { ok: true, diagramType: result.diagramType };
  } catch (error) {
    return { ok: false, message: describeParseError(error) };
  }
}

/**
 * 파서 원문 오류를 한 줄로 편다. 재생성 지시문에 실릴 문자열이므로 **줄바꿈을 접는다** —
 * jison의 캐럿 표시(`----^`)는 세 줄에 걸쳐 나오고, 그대로 실으면 지시문의 목록 구조가 깨진다.
 */
function describeParseError(error: unknown): string {
  const message = error instanceof Error ? error.message : String(error);
  return message.replace(/\s*\n\s*/g, " | ").trim();
}

async function loadMermaidParse(): Promise<MermaidParse> {
  parsePromise ??= initMermaid();
  return parsePromise;
}

async function initMermaid(): Promise<MermaidParse> {
  await ensureDom();
  const { default: mermaid } = await import("mermaid");
  // 렌더 훅을 켜지 않는다. 우리는 문법만 묻는다.
  mermaid.initialize({ startOnLoad: false, securityLevel: "strict" });
  return (code: string) => mermaid.parse(code, { suppressErrors: false });
}

/**
 * dompurify가 잡을 `window`를 mermaid import **이전에** 심는다.
 * 이미 있으면 손대지 않는다 — 남의 DOM을 갈아 끼우면 그쪽이 조용히 깨진다.
 */
async function ensureDom(): Promise<void> {
  const scope = globalThis as unknown as Record<string, unknown>;
  if (scope["document"] !== undefined && scope["window"] !== undefined) return;

  const { parseHTML } = await import("linkedom");
  const shim = parseHTML("<!doctype html><html><body></body></html>");
  scope["window"] ??= shim.window;
  scope["document"] ??= shim.document;
}
