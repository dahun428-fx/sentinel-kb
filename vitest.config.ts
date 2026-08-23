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
        /**
         * `.tsx` 컴포넌트를 단위 테스트에서 렌더할 수 있게 한다 (T-033).
         *
         * `packages/web/tsconfig.json`은 `jsx: "preserve"`다 — Next가 변환을 맡기 때문이다.
         * 그 설정을 그대로 따르면 esbuild가 **classic 변환**(`React.createElement`)을 내고,
         * 컴포넌트 파일에 `React` import가 없으므로 테스트가 `React is not defined`로 죽는다.
         * 앱 코드에 쓰이지도 않는 import를 넣는 대신 여기서 automatic 런타임을 지정한다.
         *
         * 왜 필요해졌나: T-023 F-5가 "컴포넌트 렌더 회귀를 verify가 못 막는다"고 적었고,
         * T-033 뮤테이션에서 차트 한 종류를 조용히 버리는 변경이 lint·typecheck·unit을
         * **전부 통과하는 것**이 관측됐다. 렌더 결과를 보는 테스트만이 그걸 잡는다.
         * 빌드에는 영향이 없다 — 이 설정은 vitest의 변환에만 적용된다.
         */
        esbuild: { jsx: "automatic", jsxImportSource: "react" },
        test: {
          name: "unit",
          // `eval/**`는 T-013에서 들어왔다. eval 러너의 지표·회귀 가드는 순수 함수라
          // 단위 테스트로 잠글 수 있고, 잠기지 않으면 "항상 통과하는 가드"가 된다.
          include: [
            "packages/*/src/**/*.spec.ts",
            "tools/*.spec.ts",
            "scripts/*.spec.ts",
            "eval/**/*.spec.ts",
          ],
          exclude: ["**/*.int.spec.ts", "**/node_modules/**", "**/dist/**"],
        },
      },
      {
        test: {
          name: "integration",
          include: [
            "packages/*/src/**/*.int.spec.ts",
            "tools/*.int.spec.ts",
            "scripts/*.int.spec.ts",
            "eval/**/*.int.spec.ts",
          ],
          exclude: ["**/node_modules/**", "**/dist/**"],
          passWithNoTests: true,
        },
      },
    ],
  },
});
