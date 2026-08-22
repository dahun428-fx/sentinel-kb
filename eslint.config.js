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
            "eval/tsconfig.json",
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
            /*
             * 형제 간선 금지 — specs/01의 의존 방향은 `web/mcp/api/worker → core → contracts`이고
             * 최상위 네 패키지는 **서로를 모른다.** 각각은 core·contracts만 의존한다.
             *
             * 이 zone이 없던 동안 형제 import를 막는 장치는 **아무것도 없었다.**
             * `tsc -b` 프로젝트 참조가 막아 준다는 통념은 T-014 검증에서 반증됐다 —
             * 참조를 추가하지 않고 `packages/mcp`에서 `@sentinel/api`를 import해도
             * `tsc -b`도 `eslint`도 통과하고 런타임도 정상이었다(패키지가 pnpm 워크스페이스로
             * 이미 해석되기 때문이다). T-014 D-3의 "복제할 수밖에 없다"는 근거를 실제로
             * 떠받치는 것은 이제 이 규칙이다.
             *
             * `scripts/`는 target이 아니다 — 의도적이다. `scripts/seed.cli.ts`가
             * `@sentinel/api`를, `scripts/seed.ts`가 `@sentinel/api`·`@sentinel/worker`를
             * 부르는 것은 정당하다. 그건 패키지가 아니라 **컴포지션 루트**이고,
             * 여러 패키지를 조립하는 것이 존재 이유다.
             */
            {
              target: "./packages/api",
              from: ["./packages/mcp", "./packages/worker", "./packages/web"],
              message:
                "형제 패키지 간 import는 의존 방향 위반이다 — api는 core·contracts만 의존한다 (specs/01).",
            },
            {
              target: "./packages/mcp",
              from: ["./packages/api", "./packages/worker", "./packages/web"],
              message:
                "형제 패키지 간 import는 의존 방향 위반이다 — mcp는 core·contracts만 의존하고 " +
                "core-api는 HTTP로 부른다 (specs/01, T-014 D-1·D-3).",
            },
            {
              target: "./packages/worker",
              from: ["./packages/api", "./packages/mcp", "./packages/web"],
              message:
                "형제 패키지 간 import는 의존 방향 위반이다 — worker는 core·contracts만 의존한다 (specs/01).",
            },
            {
              target: "./packages/web",
              from: ["./packages/api", "./packages/mcp", "./packages/worker"],
              message:
                "형제 패키지 간 import는 의존 방향 위반이다 — web은 core·contracts만 의존하고 " +
                "core-api는 HTTP로 부른다 (specs/01).",
            },
          ],
        },
      ],
    },
  },
  {
    /*
     * `@sentinel/core/testing`은 **테스트 전용 표면**이다.
     * `atlas-local.ts`가 `node:child_process`의 `spawnSync`로 임의 docker CLI 인자를 실행하고
     * `MongoClient`를 연다 — 프로덕션 코드가 이걸 import하면 그대로 공격 표면이 된다.
     *
     * T-011이 이 헬퍼를 만들 때의 안전 근거는 "**어느 배럴에서도 export하지 않는다**"였고
     * G5가 그걸 근거로 통과시켰다. T-012가 `packages/core/package.json`에 `./testing` 서브패스를
     * 열면서 그 근거가 "메인 배럴 경유 불가"로 내려앉았다 — 실제로 지금은 새지 않지만
     * **새는 것을 막는 장치가 없었다.** 이 zone이 그 격차를 메운다.
     *
     * 허용: `*.spec.ts` / `*.int.spec.ts` / `src/testing/**` 자신.
     */
    files: ["packages/*/src/**/*.ts", "scripts/**/*.ts", "tools/**/*.ts"],
    ignores: ["**/*.spec.ts", "**/*.int.spec.ts", "**/src/testing/**"],
    rules: {
      "no-restricted-imports": [
        "error",
        {
          patterns: [
            {
              group: ["@sentinel/core/testing", "**/testing/atlas-local*"],
              message:
                "테스트 전용 헬퍼다 — spawnSync로 docker CLI를 부른다. " +
                "*.spec.ts / *.int.spec.ts에서만 import하라 (T-011 F-8, T-012 G5 B-2).",
            },
          ],
        },
      ],
    },
  },
  prettierConfig,
);
