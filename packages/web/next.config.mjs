/**
 * Next.js 설정. 출처: specs/01(웹은 core-api를 내부 HTTP로 소비), T-023.
 *
 * `tsconfigPath`로 Next를 tsconfig.next.json으로 보낸다 — Next가 tsconfig를 자동
 * 수정하는 습성 때문에, 루트 `tsc -b`가 참조하는 tsconfig.json과 반드시 분리해야 한다.
 */

/** @type {import('next').NextConfig} */
const nextConfig = {
  typescript: { tsconfigPath: "tsconfig.next.json" },
  /**
   * 워크스페이스 패키지(@sentinel/contracts)는 빌드 산출물이 아니라 **소스**를 노출하고
   * (`main: ./src/index.ts`), NodeNext 규칙대로 상대 import에 `.js`를 붙인다
   * (`export * from "./common.js"`). 번들러는 그 `.js`를 실제 파일로 찾다 실패하므로
   * 확장자 별칭을 열어준다. 이걸 빼면 contracts import가 전부 module-not-found가 된다.
   *
   * 이 옵션은 webpack에서만 동작한다 — Turbopack은 무시한다(확인함: Next 16.3.2).
   * 그래서 dev·build 스크립트가 `--webpack`을 붙인다. contracts가 dist를 노출하게 되면
   * (contracts/package.json의 exports 변경) 이 두 가지를 함께 되돌릴 수 있다.
   * contracts 수정은 이 태스크 범위 밖이라 여기서 흡수했다.
   */
  experimental: { extensionAlias: { ".js": [".ts", ".tsx", ".js"] } },
  // 웹은 DB를 모른다. core-api HTTP만 소비한다(specs/01 의존 방향).
  reactStrictMode: true,
  /**
   * Next 16은 dev 실행 시 packages/web/CLAUDE.md·AGENTS.md를 자동 생성한다.
   * 이 레포에서 CLAUDE.md는 에이전트 운영 매뉴얼이고 사람이 승인하는 문서다 —
   * 빌드 도구가 그 이름의 파일을 조용히 써 넣으면 다음 세션의 에이전트가
   * 아무도 검토하지 않은 지시를 읽게 된다. 끈다.
   */
  agentRules: false,
};

export default nextConfig;
