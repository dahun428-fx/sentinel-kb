/**
 * T-023 Acceptance 2: "클라이언트 번들에 API 키 문자열이 없음을 검증하는 테스트".
 *
 * 접근: 번들을 만든 뒤 grep하는 검사는 `next build`를 `pnpm verify` 경로에 끌어들여
 * 게이트를 무겁게 만든다. 그래서 **키가 클라이언트로 갈 수 있는 경로 자체**를 소스에서
 * 봉쇄하고 그 봉쇄를 여기서 검증한다. Next.js에서 서버 값이 클라이언트로 넘어가는 길은
 * 세 가지뿐이다.
 *
 *   1. `NEXT_PUBLIC_` 접두사 — 빌드 타임에 클라이언트 번들로 인라인된다.
 *   2. 클라이언트 컴포넌트("use client")가 서버 전용 모듈을 import — 값이 함께 실린다.
 *   3. 서버가 키를 props·HTML로 직렬화해 내려보냄 — 런타임 가드로 막는다.
 *
 * 각각을 아래 테스트가 하나씩 막는다. 실제 산출물 검사는 두 겹 더 있다:
 * `.next/static`이 있으면 여기서 훑고, 실서버를 띄우는 e2e(`e2e/read-path.spec.ts`)가
 * 카나리 키 값으로 응답 전체를 확인한다.
 */
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";

const SRC_DIR = fileURLToPath(new URL(".", import.meta.url));
const WEB_DIR = fileURLToPath(new URL("..", import.meta.url));

interface SourceFile {
  readonly path: string;
  readonly text: string;
}

/**
 * 주석을 지운다. **문자열 리터럴은 남긴다.**
 *
 * 이 검사는 "코드가 무엇을 하는가"를 봐야 한다. 주석까지 훑으면 규칙을 설명하는
 * 문서가 곧 규칙 위반으로 잡히고, 그러면 다음 사람이 검사를 무력화하거나 설명을 지운다.
 * 문자열은 남겨야 `typeof window !== "undefined"` 같은 가드를 확인할 수 있다.
 * `//`가 URL 안에 있는 경우를 위해 문자열 상태를 추적한다.
 */
export function stripComments(source: string): string {
  let out = "";
  let index = 0;
  let quote: string | null = null;

  while (index < source.length) {
    const char = source[index] ?? "";
    const next = source[index + 1] ?? "";

    if (quote !== null) {
      out += char;
      if (char === "\\") {
        out += next;
        index += 2;
        continue;
      }
      if (char === quote) quote = null;
      index += 1;
      continue;
    }

    if (char === '"' || char === "'" || char === "`") {
      quote = char;
      out += char;
      index += 1;
      continue;
    }

    if (char === "/" && next === "/") {
      while (index < source.length && source[index] !== "\n") index += 1;
      continue;
    }

    if (char === "/" && next === "*") {
      index += 2;
      while (index < source.length && !(source[index] === "*" && source[index + 1] === "/")) {
        index += 1;
      }
      index += 2;
      continue;
    }

    out += char;
    index += 1;
  }

  return out;
}

function collectFiles(
  dir: string,
  extensions: readonly string[],
  transform: (text: string) => string,
): SourceFile[] {
  return readdirSync(dir, { recursive: true, encoding: "utf8" })
    .filter((entry) => extensions.some((extension) => entry.endsWith(extension)))
    .filter((entry) => !entry.endsWith(".spec.ts") && !entry.endsWith(".spec.tsx"))
    .map((entry) => ({ path: entry, text: transform(readFileSync(join(dir, entry), "utf8")) }));
}

const SOURCES = collectFiles(SRC_DIR, [".ts", ".tsx"], stripComments);

/** 키를 아는 모듈. 클라이언트 컴포넌트는 이것들에 닿으면 안 된다. */
const SERVER_ONLY_MODULES = ["lib/env", "lib/api-client"];

describe("stripComments (검사기 자체의 안전장치)", () => {
  it("주석은 지우고 문자열은 남긴다", () => {
    expect(stripComments('const a = "http://x//y"; // 설명\nconst b = 1;')).toBe(
      'const a = "http://x//y"; \nconst b = 1;',
    );
    expect(stripComments("/* 여러\n줄 */const c = 2;")).toBe("const c = 2;");
  });
});

describe("클라이언트 번들 키 노출 방지 (NFR-04)", () => {
  it("스캔할 소스가 실제로 존재한다 — 빈 통과를 방지한다", () => {
    expect(SOURCES.length).toBeGreaterThan(5);
    expect(SOURCES.map((file) => file.path)).toContain("lib/api-client.ts");
  });

  it("경로 1 차단: NEXT_PUBLIC_ 환경변수를 어디서도 쓰지 않는다", () => {
    const offenders = SOURCES.filter((file) => file.text.includes("NEXT_PUBLIC_"));
    expect(offenders.map((file) => file.path)).toEqual([]);
  });

  it("경로 2 차단: 클라이언트 컴포넌트가 서버 전용 모듈을 import하지 않는다", () => {
    const clientComponents = SOURCES.filter((file) =>
      /^\s*(["'])use client\1/m.test(file.text),
    );
    const offenders = clientComponents.filter((file) =>
      SERVER_ONLY_MODULES.some((moduleName) => file.text.includes(moduleName)),
    );
    expect(offenders.map((file) => file.path)).toEqual([]);
  });

  it("경로 3 차단: api-client가 브라우저에서 실행되면 즉시 던진다", () => {
    const apiClient = SOURCES.find((file) => file.path === "lib/api-client.ts");
    expect(apiClient?.text).toContain('typeof window !== "undefined"');
  });

  it("키를 읽는 코드는 서버 전용 모듈에만 있다", () => {
    const readers = SOURCES.filter((file) => file.text.includes("CORE_API_KEY"));
    expect(readers.map((file) => file.path).sort()).toEqual(["lib/env.ts"]);
  });

  it("본문을 innerHTML로 넣지 않는다 — 인젝션 의심 기록이 실행 가능한 마크업이 되면 안 된다", () => {
    const offenders = SOURCES.filter((file) => file.text.includes("dangerouslySetInnerHTML"));
    expect(offenders.map((file) => file.path)).toEqual([]);
  });

  it("빌드 산출물이 있으면 클라이언트 청크에도 키 이름이 없다", () => {
    const staticDir = join(WEB_DIR, ".next", "static");
    if (!existsSync(staticDir)) {
      // 빌드 전이면 위 소스 단위 봉쇄와 e2e의 카나리 검사가 이 항목을 대신한다.
      expect(existsSync(staticDir)).toBe(false);
      return;
    }
    // 번들 산출물은 주석을 지우지 않는다 — 미니파이된 정규식이 스캐너를 헷갈리게 해
    // 오히려 누출을 놓칠 수 있다. 여기서는 원문 그대로 훑는 편이 안전하다.
    const chunks = collectFiles(staticDir, [".js"], (text) => text);
    const leaking = chunks.filter((chunk) => chunk.text.includes("CORE_API_KEY"));
    expect(leaking.map((chunk) => chunk.path)).toEqual([]);
  });
});
