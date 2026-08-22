import { readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";

/**
 * T-017 연결 문서 가드.
 *
 * 문서는 조용히 썩는다. `.mcp.json`이 깨진 JSON이 되거나, 도구 이름이 스펙과 갈라지거나,
 * 아직 없는 `pnpm` 스크립트를 문서가 안내하는 일은 **아무도 눈치채지 못한 채** 일어난다.
 * 사람이 읽어야만 발견되는 오류를 `pnpm verify`가 발견하게 만드는 것이 이 파일의 전부다.
 *
 * 도구 이름의 정본은 `specs/07-mcp.md`다 — CLAUDE.md "스펙이 소스 오브 트루스".
 * `packages/mcp`를 읽지 않는 이유는 이 가드가 MCP 패키지의 구현 상태와 무관하게
 * (스켈레톤이든 완성이든) 항상 돌아야 하기 때문이다.
 */
const repoRoot = fileURLToPath(new URL("..", import.meta.url));

function read(relativePath: string): string {
  return readFileSync(join(repoRoot, relativePath), "utf8");
}

const mcpJsonRaw = read(".mcp.json");
const connectDoc = read("docs/connect.md");
const mcpSpec = read("specs/07-mcp.md");
const rootPackageJson = read("package.json");

/** `${VAR}` 참조 하나로만 이루어진 값인가. 리터럴 시크릿을 걸러내는 판정. */
function isEnvReference(value: string): boolean {
  return /^\$\{[A-Z0-9_]+\}$/.test(value);
}

interface HttpServerEntry {
  readonly type: "http";
  readonly url: string;
  readonly headers?: Record<string, string>;
}

interface StdioServerEntry {
  readonly type: "stdio";
  readonly command: string;
  readonly args?: string[];
  readonly env?: Record<string, string>;
}

type ServerEntry = HttpServerEntry | StdioServerEntry;

interface McpJson {
  readonly mcpServers: Record<string, ServerEntry>;
}

function parseMcpJson(raw: string, label: string): McpJson {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch (error: unknown) {
    throw new Error(`${label}이 유효한 JSON이 아니다: ${String(error)}`);
  }
  if (typeof parsed !== "object" || parsed === null || !("mcpServers" in parsed)) {
    throw new Error(`${label}에 mcpServers 키가 없다.`);
  }
  return parsed as McpJson;
}

/** `.mcp.json` 한 항목이 지켜야 할 계약. HTTP·stdio 양쪽에 같은 함수를 쓴다. */
function assertServerEntry(name: string, entry: ServerEntry): void {
  if (entry.type === "http") {
    // specs/07: 전송은 Streamable HTTP `/mcp`.
    expect(entry.url, `${name}: url이 /mcp로 끝나야 한다`).toMatch(/\/mcp$/);
    const auth = entry.headers?.["Authorization"];
    expect(auth, `${name}: Authorization 헤더가 있어야 한다`).toBeDefined();
    // 시크릿 하드코딩 금지 — 토큰 자리는 반드시 env 참조여야 한다.
    expect(auth, `${name}: Bearer 토큰은 env 참조여야 한다`).toMatch(/^Bearer \$\{[A-Z0-9_]+\}$/);
    return;
  }
  expect(entry.command, `${name}: stdio 항목에 command가 있어야 한다`).toBeTruthy();
  for (const [key, value] of Object.entries(entry.env ?? {})) {
    expect(isEnvReference(value), `${name}.env.${key}에 리터럴 값이 박혀 있다: ${value}`).toBe(
      true,
    );
  }
}

describe(".mcp.json (T-017)", () => {
  const mcpJson = parseMcpJson(mcpJsonRaw, ".mcp.json");
  const entries = Object.entries(mcpJson.mcpServers);

  it("유효한 JSON이고 서버 항목이 있다", () => {
    expect(entries.length).toBeGreaterThan(0);
  });

  it("모든 항목이 전송 계약을 지키고 시크릿을 하드코딩하지 않는다", () => {
    for (const [name, entry] of entries) assertServerEntry(name, entry);
  });

  it("HTTP와 stdio 두 전송을 모두 담는다 (specs/07 예시에 없던 stdio를 채운다)", () => {
    const types = entries.map(([, entry]) => entry.type);
    expect(types).toContain("http");
    expect(types).toContain("stdio");
  });

  it("stdio 항목이 pnpm run을 쓰지 않는다 — 실행 헤더가 stdout을 오염시켜 JSON-RPC가 깨진다", () => {
    for (const [name, entry] of entries) {
      if (entry.type !== "stdio") continue;
      const argv = [entry.command, ...(entry.args ?? [])];
      const runIndex = argv.indexOf("run");
      const silent = argv.includes("--silent") || argv.includes("--reporter=silent");
      expect(
        entry.command !== "pnpm" || runIndex === -1 || silent,
        `${name}: \`pnpm run\`은 배너를 stdout으로 낸다. pnpm exec 또는 --silent를 쓴다`,
      ).toBe(true);
    }
  });
});

describe("docs/connect.md (T-017)", () => {
  /** 문서 안의 ```json 블록 중 mcpServers를 담은 것들. */
  const jsonBlocks = [...connectDoc.matchAll(/```json\n([\s\S]*?)```/g)]
    .map((match) => match[1] ?? "")
    .filter((block) => block.includes("mcpServers"));

  /** specs/07의 `### N. \`tool_name\`` 헤딩이 도구 이름의 정본이다. */
  const specToolNames = [...mcpSpec.matchAll(/^### \d+\. `([a-z_]+)`/gm)].map(
    (match) => match[1] ?? "",
  );

  it("specs/07에서 도구 5개를 읽어낸다 (파싱 자체의 회귀 방지)", () => {
    expect(specToolNames).toHaveLength(5);
  });

  it("문서가 스펙의 도구 이름을 모두, 오탈자 없이 언급한다", () => {
    for (const name of specToolNames) {
      expect(connectDoc, `docs/connect.md에 ${name}이 없다`).toContain(`\`${name}\``);
    }
  });

  it("스펙에 없는 도구 이름을 만들어내지 않는다 (도구 5개 상한, specs/07)", () => {
    const documented = new Set(
      [...connectDoc.matchAll(/`((?:search|get|record|suggest|give)_[a-z_]+)`/g)].map(
        (match) => match[1] ?? "",
      ),
    );
    expect([...documented].sort()).toEqual([...specToolNames].sort());
  });

  it("문서의 모든 .mcp.json 예시가 유효한 JSON이고 같은 계약을 지킨다", () => {
    expect(jsonBlocks.length).toBeGreaterThan(0);
    for (const [index, block] of jsonBlocks.entries()) {
      const parsed = parseMcpJson(block, `docs/connect.md의 json 블록 #${index + 1}`);
      for (const [name, entry] of Object.entries(parsed.mcpServers)) assertServerEntry(name, entry);
    }
  });

  it("문서가 아직 없는 pnpm 스크립트를 안내하지 않는다", () => {
    const scripts = new Set(
      Object.keys(
        (JSON.parse(rootPackageJson) as { scripts?: Record<string, string> }).scripts ?? {},
      ),
    );
    // `pnpm exec`·`pnpm run`·`pnpm --silent` 같은 내장 명령/플래그는 스크립트가 아니다.
    const builtins = new Set(["exec", "run", "install", "add", "dlx", "-r", "--filter"]);
    for (const match of connectDoc.matchAll(/\bpnpm ([a-z][a-z0-9:_-]*)/g)) {
      const token = match[1] ?? "";
      if (builtins.has(token)) continue;
      expect(
        scripts.has(token),
        `docs/connect.md가 package.json에 없는 \`pnpm ${token}\`를 안내한다`,
      ).toBe(true);
    }
  });

  it("어떤 예시에도 리터럴 Bearer 토큰이 없다", () => {
    const literalBearer = [...connectDoc.matchAll(/Bearer ([A-Za-z0-9._-]+)/g)].map(
      (match) => match[1] ?? "",
    );
    // `Bearer $SENTINEL_KB_KEY`(셸 형태)는 위 정규식에 걸리지 않으므로 `$`로 시작하는 값만 남는다.
    expect(literalBearer, "문서에 리터럴 토큰이 박혀 있다").toEqual([]);
  });
});
