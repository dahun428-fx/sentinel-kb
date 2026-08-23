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
import { z, type ZodObject, type ZodRawShape, type ZodTypeAny } from "zod";

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
  /**
   * 모델에게 실제로 제시하는 인자 스키마(JSON Schema).
   *
   * `args`와 **같은 소스에서 같은 순간에** 파생된다 — 하나는 사람·채점기가 읽는 요약이고
   * 이것은 native tool-use 요청에 실리는 형상이다. 둘을 다른 곳에서 만들면 리포트가 재는
   * 계약과 모델이 본 계약이 갈라진다.
   */
  readonly inputSchema: Record<string, unknown>;
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

function readShape(toolName: string, tool: RegisteredToolLike): Record<string, ZodTypeAny> {
  const shape: unknown = tool.inputSchema?.shape;
  if (typeof shape !== "object" || shape === null) {
    throw new ToolCatalogError(
      `${toolName}의 인자 스키마를 읽지 못했다(inputSchema.shape가 없다). ` +
        "인자를 모르면 specs/05가 요구하는 '올바른 도구 + **필수 인자**' 판정을 할 수 없다.",
    );
  }
  return shape as Record<string, ZodTypeAny>;
}

function readArgs(shape: Record<string, ZodTypeAny>): ToolArgSpec[] {
  return Object.entries(shape).map(([name, schema]) => ({
    name,
    required: !schema.isOptional(),
    description: schema.description ?? "",
  }));
}

/** 래퍼(`optional`·`default`·`nullable`·`effects`)를 벗겨 본체를 꺼낸다. */
function unwrap(schema: ZodTypeAny): ZodTypeAny {
  let current: ZodTypeAny = schema;
  // 중첩 상한. 순환은 zod에서 생기지 않지만 무한 루프를 구조적으로 막는다.
  for (let depth = 0; depth < 8; depth += 1) {
    if (current instanceof z.ZodOptional || current instanceof z.ZodNullable) {
      current = current.unwrap() as ZodTypeAny;
    } else if (current instanceof z.ZodDefault) {
      current = current.removeDefault() as ZodTypeAny;
    } else if (current instanceof z.ZodEffects) {
      current = current.innerType() as ZodTypeAny;
    } else {
      return current;
    }
  }
  return current;
}

/**
 * Zod 인자 스키마 → JSON Schema. **모르는 형상은 좁히지 않고 빈 객체로 둔다.**
 *
 * ## 왜 여기서 만드나 (스냅샷이 아닌 이유)
 * 도구가 등록될 때 SDK가 보관한 **살아 있는 Zod 스키마**에서 파생한다. 스키마가 바뀌면
 * 다음 실행이 자동으로 바뀐 형상을 낸다 — `catalog.json` 같은 사본을 두면 이 eval이 사본을
 * 재게 되고 G6가 문면만 남는다(이 파일 상단 주석).
 *
 * ## `enum`을 반드시 싣는다
 * `record_knowledge.type`의 `incident`/`divergence` 같은 값이 빠지면 모델은 무엇을 채워야
 * 할지 알 수 없고, 시나리오 TS-02(`type: divergence`)의 오답이 **모델의 실수가 아니라
 * 우리가 정보를 안 준 결과**가 된다. 채점 대상은 description이지 우리의 누락이 아니다.
 *
 * ## 모르는 타입을 추측하지 않는다
 * 여기서 다루지 못하는 zod 타입은 `{description}`만 남긴다(= 어떤 JSON 값이든 허용).
 * 틀린 타입을 적어 보내면 모델이 채운 인자가 서버 스키마와 어긋나는데, 그 실패는
 * description 품질이 아니라 이 변환기의 버그다.
 */
export function toJsonSchema(schema: ZodTypeAny): Record<string, unknown> {
  const inner = unwrap(schema);
  const description = schema.description ?? inner.description;
  const base: Record<string, unknown> =
    description === undefined ? {} : { description };

  if (inner instanceof z.ZodString) return { ...base, type: "string" };
  if (inner instanceof z.ZodNumber) {
    return { ...base, type: inner.isInt ? "integer" : "number" };
  }
  if (inner instanceof z.ZodBoolean) return { ...base, type: "boolean" };
  if (inner instanceof z.ZodEnum) {
    return { ...base, type: "string", enum: [...(inner.options as readonly string[])] };
  }
  if (inner instanceof z.ZodLiteral) {
    return { ...base, const: inner.value as unknown };
  }
  if (inner instanceof z.ZodArray) {
    return { ...base, type: "array", items: toJsonSchema(inner.element as ZodTypeAny) };
  }
  if (inner instanceof z.ZodObject) {
    return { ...base, ...objectSchema(inner.shape as Record<string, ZodTypeAny>) };
  }
  return base;
}

function objectSchema(shape: Record<string, ZodTypeAny>): Record<string, unknown> {
  const properties: Record<string, unknown> = {};
  const required: string[] = [];
  for (const [name, schema] of Object.entries(shape)) {
    properties[name] = toJsonSchema(schema);
    if (!schema.isOptional()) required.push(name);
  }
  return { type: "object", properties, required };
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
    const shape = readShape(name, tool);
    return {
      name,
      title: tool.title ?? name,
      description,
      args: readArgs(shape),
      inputSchema: objectSchema(shape),
    };
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
