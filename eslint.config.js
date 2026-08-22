// ESLint flat config — 의존 방향(web/mcp/api/worker → core → contracts) 역행을
// import/no-restricted-paths로 강제한다 (specs/01-architecture.md, T-001 Acceptance 3).
import js from "@eslint/js";
import prettierConfig from "eslint-config-prettier";
import importPlugin from "eslint-plugin-import";
import tseslint from "typescript-eslint";

export default tseslint.config(
  {
    // lint-fixtures는 의도적 위반 코드 — tools/dependency-boundaries.spec.ts가
    // ESLint Node API(ignore: false)로 직접 lint 해서 규칙 동작을 검증한다.
    ignores: [
      "**/dist/**",
      "**/node_modules/**",
      "**/.next/**",
      "**/coverage/**",
      "**/lint-fixtures/**",
    ],
  },
  js.configs.recommended,
  ...tseslint.configs.strict,
  ...tseslint.configs.stylistic,
  {
    files: ["**/*.ts", "**/*.tsx"],
    plugins: { import: importPlugin },
    settings: {
      "import/resolver": {
        typescript: {
          project: [
            "packages/*/tsconfig.json",
            "tools/tsconfig.json",
            "scripts/tsconfig.json",
          ],
          noWarnOnMultipleProjects: true,
        },
      },
    },
    rules: {
      // CLAUDE.md 코드 규칙: any 금지 (불가피하면 주석으로 사유 + eslint-disable)
      "@typescript-eslint/no-explicit-any": "error",
      "import/no-restricted-paths": [
        "error",
        {
          basePath: import.meta.dirname,
          zones: [
            {
              target: "./packages/contracts",
              from: [
                "./packages/core",
                "./packages/api",
                "./packages/mcp",
                "./packages/worker",
                "./packages/web",
              ],
              message:
                "contracts는 최하위 계층이다 — 다른 패키지를 import할 수 없다 (specs/01).",
            },
            {
              target: "./packages/core",
              from: [
                "./packages/api",
                "./packages/mcp",
                "./packages/worker",
                "./packages/web",
              ],
              message:
                "core는 HTTP·MCP·UI를 모른다 — api/mcp/worker/web을 import할 수 없다 (specs/01).",
            },
          ],
        },
      ],
    },
  },
  prettierConfig,
);
