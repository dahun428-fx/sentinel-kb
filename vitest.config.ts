import { defineConfig } from "vitest/config";

/**
 * unit(**\/*.spec.ts)과 integration(**\/*.int.spec.ts) 프로젝트 분리 (specs/05).
 * integration은 테스트 파일 0개여도 실패하면 안 된다 — CI가 MONGODB_TEST_URI
 * 시크릿 없이도 돌아야 하므로 passWithNoTests를 켠다.
 */
export default defineConfig({
  test: {
    projects: [
      {
        test: {
          name: "unit",
          include: ["packages/*/src/**/*.spec.ts", "tools/*.spec.ts"],
          exclude: ["**/*.int.spec.ts", "**/node_modules/**", "**/dist/**"],
        },
      },
      {
        test: {
          name: "integration",
          include: ["packages/*/src/**/*.int.spec.ts", "tools/*.int.spec.ts"],
          exclude: ["**/node_modules/**", "**/dist/**"],
          passWithNoTests: true,
        },
      },
    ],
  },
});
