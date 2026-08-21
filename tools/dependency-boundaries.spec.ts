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

  it("허용 방향(core → contracts)은 lint 에러가 아니다", async () => {
    const ruleIds = await lintFixture("packages/core/src/index.ts");
    expect(ruleIds).not.toContain("import/no-restricted-paths");
  });
});
