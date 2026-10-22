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
          /**
           * 유닛 계층의 기본 타임아웃은 **5초 그대로**다 (T-045). 늘리면 무한 대기가
           * 느린 테스트로 위장한다. 다만 이 프로젝트에는 실 프로세스를 띄우는 파일이
           * 섞여 있어, setup 파일이 **그 파일들만** 골라 여유를 준다.
           *
           * 두 값은 vitest 기본값과 **같다.** 바꾸지 않았다는 사실을 파일에 적어 두는 것이
           * 목적이다 — 그래야 아래 integration의 30초가 "왜 여기만 다른가"로 읽힌다.
           */
          testTimeout: 5_000,
          hookTimeout: 10_000,
          setupFiles: ["./vitest.timeouts.setup.ts"],
          // 단위가 먼저, 통합은 그다음이다 (T-062). 순서를 정하지 않으면 `npx vitest run`이 두 계층을 동시에 돌려
          // atlas-local(mongot) 컨테이너 여러 개와 CPU 무거운 단위 테스트가 겹쳐 둘 다 간헐 실패했다(고병렬 40회 중 5회).
          // `pnpm verify`가 이미 `test && test:integration`으로 순차 실행하는 것과 같게 맞춘다.
          sequence: { groupOrder: 0 },
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
          /**
           * integration은 **전부** 바깥 프로세스에 의존한다 — mongodb-memory-server 기동,
           * docker compose 파싱, `bash infra/deploy/deploy.sh` 실행. 기본 5초는 이 계층에
           * 맞지 않는다: `deploy-rollback.int.spec.ts`는 단독 0.4초인데 고병렬에서 5초를
           * 넘겨 실패했다(감사 실측 41회 중 2회). 12배 여유를 CPU 경합이 먹은 것이므로
           * 코드가 아니라 경계값이 틀린 쪽이다.
           *
           * 30초는 "정상 상한"이 아니라 **매달림 판정선**이다. 실제 무한 대기는 여전히
           * 30초에 잡히고, 동기 자식 프로세스는 vitest가 끊지 못하므로 각 테스트가
           * `execFileSync`/`spawnSync`에 자기 타임아웃을 따로 건다.
           */
          testTimeout: 30_000,
          hookTimeout: 30_000,
          sequence: { groupOrder: 1 },
        },
      },
    ],
  },
});
