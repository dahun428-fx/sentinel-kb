import { fileURLToPath } from "node:url";

import { ESLint } from "eslint";
import { describe, expect, it } from "vitest";

/**
 * T-001 Acceptance 3: 의존 방향 위반 시 eslint가 실제로 실패하는지 검증한다.
 * 픽스처는 zone(target) 매칭이 파일 경로 기준이므로 각 패키지 안에 둔다.
 * 픽스처 경로는 eslint.config.js ignores에 있어 일반 lint에서는 제외되고,
 * 여기서는 ignore: false로 우회해 실제 설정 그대로 lint 한다.
 */
const repoRoot = fileURLToPath(new URL("..", import.meta.url));

async function lintFixture(relativePath: string): Promise<string[]> {
  const eslint = new ESLint({ cwd: repoRoot, ignore: false });
  const results = await eslint.lintFiles([relativePath]);
  return results.flatMap((r) => r.messages.map((m) => m.ruleId ?? "unknown"));
}

describe("의존 방향 경계 (import/no-restricted-paths)", () => {
  it("core → api import는 lint 에러다", async () => {
    const ruleIds = await lintFixture("packages/core/lint-fixtures/violation-imports-api.ts");
    expect(ruleIds).toContain("import/no-restricted-paths");
  });

  it("contracts → core import는 lint 에러다", async () => {
    const ruleIds = await lintFixture(
      "packages/contracts/lint-fixtures/violation-imports-core.ts",
    );
    expect(ruleIds).toContain("import/no-restricted-paths");
  });

  /**
   * 형제 간선(`mcp → api`). specs/01의 의존 방향은 최상위 네 패키지(web/mcp/api/worker)가
   * **서로를 모르는** 형태다. `tsc -b` 프로젝트 참조는 이 간선을 막지 못한다 —
   * 참조 없이 import해도 빌드·lint·런타임이 전부 통과한다(T-014 검증). 이 규칙만이 막는다.
   */
  it("mcp → api import는 lint 에러다 — 형제 간선", async () => {
    const ruleIds = await lintFixture("packages/mcp/lint-fixtures/violation-imports-api.ts");
    expect(ruleIds).toContain("import/no-restricted-paths");
  });

  it("허용 방향(core → contracts)은 lint 에러가 아니다", async () => {
    const ruleIds = await lintFixture("packages/core/src/index.ts");
    expect(ruleIds).not.toContain("import/no-restricted-paths");
  });

  /**
   * `scripts/`는 패키지가 아니라 **컴포지션 루트**다. 여러 패키지를 조립하는 것이 존재
   * 이유이므로 형제 zone의 target에 넣지 않았다. 그 예외가 살아 있는지 확인한다 —
   * zone을 넓히다가 조용히 깨뜨리면 시드 파이프라인이 lint에서 죽는다.
   */
  it("scripts는 컴포지션 루트라 여러 패키지를 조립해도 에러가 아니다", async () => {
    const ruleIds = await lintFixture("scripts/seed.cli.ts");
    expect(ruleIds).not.toContain("import/no-restricted-paths");
  });
});
