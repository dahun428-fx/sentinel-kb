/**
 * 잴 대상(도구 계약)을 **실물 서버에서** 읽어 온다. specs/07 §"description 작성 규칙":
 * > description 변경은 계약 변경이다 → tool-selection eval 재실행 필수 (G6).
 *
 * ## 왜 스냅샷이 아니라 실물인가 — 이 파일의 존재 이유 전부
 * description을 `eval/tools/catalog.json` 같은 사본으로 떠 두면 이 eval은 **사본**을 잰다.
 * 그러면 description을 고친 PR이 eval을 재실행해도 수치가 안 움직이고, G6 조항은
 * 문면만 남고 실제로는 아무것도 강제하지 못한다. 반대로 실물에서 읽으면
 * description 한 글자만 바뀌어도 `descriptionSha256`이 달라져 **이전 리포트와 비교 불가**임이
 * 리포트에 남는다. 그것이 G6가 요구하는 "재실행 필수"의 기계적 근거다.
 *
 * ## `packages/mcp`를 **읽기만** 한다
 * 이 모듈은 `createMcpServer`를 부를 뿐 무엇도 등록·수정하지 않는다. core-api는 절대 부르지
 * 않는다 — 넘기는 `coreApi`는 호출되면 **던지는** 스텁이다(`tools.int.spec.ts`가 쓰는 것과
 * 같은 관용구). 도구 목록을 읽는 데 네트워크가 필요하면 그건 카탈로그가 아니라 통합 테스트다.
 *
 * ## private 필드(`_registeredTools`)를 읽는 것에 대하여
 * MCP SDK는 등록된 도구의 description·인자 스키마를 공개 API로 노출하지 않는다.
 * `packages/mcp/src/tools/index.ts`의 `countRegisteredTools`가 같은 자리를 같은 이유로 읽고 있고,
 * 거기 적힌 규약("**못 세면 던진다** — 세지 못하는 상태로 통과시키면 상한이 조용히 사라진다")을
 * 그대로 따른다. 여기서도 못 읽으면 던진다 → CLI가 78(판정 불가)로 끝낸다.
 * 빈 카탈로그로 조용히 진행하면 "모든 시나리오가 도구 없음을 골랐다"는 만점 리포트가 나온다.
 */
import { createHash } from "node:crypto";

import type { CoreApiClient, McpContext } from "@sentinel/mcp";
import { createMcpServer, MAX_TOOLS } from "@sentinel/mcp";
import type { ZodObject, ZodRawShape, ZodTypeAny } from "zod";

/** 카탈로그를 읽을 수 없는 상태. CLI가 이 오류를 78로 옮긴다. */
export class ToolCatalogError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ToolCatalogError";
  }
}

export interface ToolArgSpec {
  readonly name: string;
  /** 도구 스키마상 필수인가. **시나리오의 `requiredArgs`와는 다른 개념이다** (아래 참조). */
  readonly required: boolean;
  readonly description: string;
}

export interface ToolSpec {
  readonly name: string;
  readonly title: string;
  readonly description: string;
  readonly args: readonly ToolArgSpec[];
}

export interface ToolCatalog {
  readonly tools: readonly ToolSpec[];
  /** 이름 + description + 인자(이름·필수여부·description)를 전부 먹는 지문. */
  readonly descriptionSha256: string;
}

/**
 * core-api를 부르면 **던지는** 스텁. 카탈로그를 읽는 경로에서 네트워크가 나가면 안 된다.
 * 부르는 쪽이 있으면 조용히 빈 값을 주는 대신 큰 소리로 죽는 편이 낫다.
 */
const NEVER_CALLED: CoreApiClient = {
  read: () =>
    Promise.reject(new Error("도구 카탈로그를 읽는 경로는 core-api를 부르지 않는다.")),
  write: () =>
    Promise.reject(new Error("도구 카탈로그를 읽는 경로는 core-api를 부르지 않는다.")),
};

const CATALOG_CONTEXT: McpContext = { project: "sentinel-kb", coreApi: NEVER_CALLED };

/**
 * SDK가 `registerTool`에 받은 `ZodRawShape`를 `z.object(shape)`로 감싸 보관한다.
 * 우리가 필요한 것은 그 안의 `shape`뿐이다. 형상이 바뀌면(SDK 업그레이드) 아래 가드가 던진다.
 */
interface RegisteredToolLike {
  readonly title?: string;
  readonly description?: string;
  readonly inputSchema?: ZodObject<ZodRawShape>;
}

function readRegistry(server: unknown): Record<string, RegisteredToolLike> {
  const registry = (server as { readonly _registeredTools?: unknown })._registeredTools;
  if (typeof registry !== "object" || registry === null) {
    throw new ToolCatalogError(
      "MCP SDK의 도구 레지스트리(_registeredTools)를 찾지 못했다. SDK 업그레이드로 형상이 바뀌었을 수 있다 — " +
        "무엇을 재는지 모르는 채로 tool-selection eval을 돌리지 않는다.",
    );
  }
  return registry as Record<string, RegisteredToolLike>;
}

function readArgs(toolName: string, tool: RegisteredToolLike): ToolArgSpec[] {
  const shape: unknown = tool.inputSchema?.shape;
  if (typeof shape !== "object" || shape === null) {
    throw new ToolCatalogError(
      `${toolName}의 인자 스키마를 읽지 못했다(inputSchema.shape가 없다). ` +
        "인자를 모르면 specs/05가 요구하는 '올바른 도구 + **필수 인자**' 판정을 할 수 없다.",
    );
  }
  return Object.entries(shape as Record<string, ZodTypeAny>).map(([name, schema]) => ({
    name,
    required: !schema.isOptional(),
    description: schema.description ?? "",
  }));
}

/**
 * 실제 등록된 도구 5종을 읽는다.
 *
 * **도구 수를 여기서도 확인한다.** `createMcpServer`가 이미 `MAX_TOOLS`로 부팅 가드를 걸지만,
 * 그 가드가 세는 것과 우리가 읽는 것이 같은 레지스트리라는 보장을 리포트가 스스로 들고 있어야
 * 한다 — 리포트의 `catalog.toolCount`가 그 근거다.
 */
export function loadToolCatalog(): ToolCatalog {
  const registry = readRegistry(createMcpServer(CATALOG_CONTEXT));
  const names = Object.keys(registry);
  if (names.length !== MAX_TOOLS) {
    throw new ToolCatalogError(
      `도구가 ${String(names.length)}개 등록됐다. specs/07은 정확히 ${String(MAX_TOOLS)}개로 못박았다 — ` +
        "계약이 흔들리는 중에 잰 선택률은 기준선이 될 수 없다.",
    );
  }

  const tools: ToolSpec[] = names.map((name) => {
    // eslint-disable-next-line @typescript-eslint/no-non-null-assertion -- name은 방금 이 레지스트리에서 뽑았다.
    const tool = registry[name]!;
    const description = tool.description ?? "";
    if (description.trim().length === 0) {
      throw new ToolCatalogError(
        `${name}에 description이 없다. tool-selection eval이 재는 대상이 바로 description이다 ` +
          "(specs/07 '언제-쓰는지가 트리거의 전부다') — 없으면 이 eval은 아무것도 재지 않는다.",
      );
    }
    return { name, title: tool.title ?? name, description, args: readArgs(name, tool) };
  });

  return { tools, descriptionSha256: fingerprint(tools) };
}

/**
 * 계약 지문. **인자 description까지 먹는다** — 인자 설명도 에이전트가 무엇을 채울지 정하는
 * 재료이고(specs/05의 판정 대상이 "도구 + 필수 인자"다), 거기만 고쳐서 점수를 올릴 수 있다면
 * 지문이 그 변경을 못 보는 셈이다.
 */
export function fingerprint(tools: readonly ToolSpec[]): string {
  const canonical = tools.map((tool) => ({
    name: tool.name,
    description: tool.description,
    args: tool.args.map((arg) => ({
      name: arg.name,
      required: arg.required,
      description: arg.description,
    })),
  }));
  return createHash("sha256").update(JSON.stringify(canonical), "utf8").digest("hex");
}

export function toolNames(catalog: ToolCatalog): string[] {
  return catalog.tools.map((tool) => tool.name);
}

export function findTool(catalog: ToolCatalog, name: string): ToolSpec | undefined {
  return catalog.tools.find((tool) => tool.name === name);
}

/**
 * selector에게 넘길 도구 목록 텍스트. **specs/05의 "도구 목록만 주고"가 뜻하는 것이 이 문자열이다.**
 *
 * 시나리오·정답·힌트는 여기 한 글자도 들어가지 않는다. 들어가면 이 eval은 description이 아니라
 * 우리가 쓴 힌트를 재게 된다. 그래서 이 함수는 카탈로그만 받고 시나리오를 아예 인자로 받지 않는다.
 */
export function renderCatalog(catalog: ToolCatalog): string {
  return catalog.tools
    .map((tool) => {
      const args = tool.args
        .map(
          (arg) =>
            `    - ${arg.name}${arg.required ? " (필수)" : " (선택)"}: ${arg.description}`,
        )
        .join("\n");
      return `- ${tool.name}\n  ${tool.description}\n  인자:\n${args}`;
    })
    .join("\n\n");
}
