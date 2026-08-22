import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";

import { ApiKeyConfigError, McpAuthError, parseApiKeys, resolveAuth } from "./auth.js";

const KEYS = parseApiKeys("devkey123:sentinel-kb,devkey456:bizcare-web");

describe("parseApiKeys", () => {
  it("`<key>:<project>` 목록을 맵으로 만든다", () => {
    expect(KEYS.get("devkey123")).toBe("sentinel-kb");
    expect(KEYS.get("devkey456")).toBe("bizcare-web");
  });

  it("후행 콤마로 생긴 빈 조각만 건너뛴다", () => {
    expect(parseApiKeys("a:p1,").size).toBe(1);
  });

  it.each([
    ["미설정", undefined],
    ["빈 문자열", "   "],
    ["콜론 없음", "abcdef"],
    ["콜론 둘", "a:b:c"],
    ["빈 키", ":proj"],
    ["빈 project", "key:"],
    ["중복 키", "a:p1,a:p2"],
  ])("애매한 입력은 추측하지 않고 던진다: %s", (_label, raw) => {
    expect(() => parseApiKeys(raw)).toThrow(ApiKeyConfigError);
  });
});

describe("resolveAuth", () => {
  it("Bearer 키를 project 클레임과 원본 키로 바꾼다", () => {
    expect(resolveAuth("Bearer devkey456", KEYS)).toEqual({
      project: "bizcare-web",
      key: "devkey456",
    });
  });

  it("스킴 이름은 대소문자를 가리지 않는다 (RFC 7235)", () => {
    expect(resolveAuth("bEaReR\tdevkey123", KEYS).project).toBe("sentinel-kb");
  });

  it.each([
    ["헤더 없음", undefined],
    ["스킴 없음", "devkey123"],
    ["다른 스킴", "Basic devkey123"],
    ["미등록 키", "Bearer nope"],
    ["빈 값", "Bearer "],
  ])("실패는 전부 McpAuthError다: %s", (_label, header) => {
    expect(() => resolveAuth(header, KEYS)).toThrow(McpAuthError);
  });

  it("실패 이유를 메시지로 구분하지 않는다 — 키 유효성 오라클이 되면 안 된다", () => {
    const messages = [undefined, "Bearer nope", "Basic x"].map((header) => {
      try {
        resolveAuth(header, KEYS);
        return "성공";
      } catch (error: unknown) {
        return (error as Error).message;
      }
    });
    expect(new Set(messages).size).toBe(1);
  });

  it("에러 메시지에 제시된 토큰이 들어가지 않는다", () => {
    const secret = "leaked-project-key-value";
    try {
      resolveAuth(`Bearer ${secret}`, KEYS);
      throw new Error("던졌어야 한다");
    } catch (error: unknown) {
      expect(error).toBeInstanceOf(McpAuthError);
      expect((error as Error).message).not.toContain(secret);
      expect(JSON.stringify(error, Object.getOwnPropertyNames(error))).not.toContain(secret);
    }
  });
});

/**
 * ## 복제 드리프트 트립와이어 (T-014 D-3)
 *
 * `parseApiKeys`/`extractBearerKey`의 규칙은 `packages/api/src/auth.ts`에 원본이 있고
 * 여기 사본이 있다. `mcp → api` import는 의존 방향 역행이라 코드 공유가 불가능하고
 * (specs/01: `web/mcp/api → core → contracts`, 형제 간 간선 없음), 공용 위치인
 * `@sentinel/core`로 올리는 것은 budget 밖 패키지 **수정**이라 이 태스크에서 못 한다(F-1).
 *
 * 복제의 대가는 "두 곳이 조용히 갈라지는 것"이다. 그걸 **소리 나게** 만든다:
 * 두 파일의 함수 본문을 주석·공백만 지운 뒤 **직접 비교**한다. 한쪽만 바뀌면 죽는다.
 * 그러면 사람이 (a) 사본을 맞추거나 (b) F-1을 실행하도록 강제된다.
 *
 * 고정 다이제스트가 아니라 양쪽 대조인 이유: 다이제스트는 사본을 고친 사람이 상수만
 * 갱신하고 넘어가도 통과한다 — 즉 **트립와이어를 끄는 것이 고치는 것보다 쉽다.**
 * 대조는 그 우회로가 없다. 두 본문이 실제로 같아야만 통과한다.
 *
 * 의도적으로 **import가 아니라 파일 읽기**다 — `mcp → api` 간선을 만들지 않기 위해서다.
 * (툴체인이 그 간선을 자동으로 막아 주지는 않는다. `tsc -b` 프로젝트 참조가 막는다는 통념은
 * T-014 검증에서 반증됐고, 지금 실제로 막는 것은 `eslint.config.js`의 형제 zone이다.
 * 그 zone이 있어도 이 파일이 `@sentinel/api`를 import하면 lint가 죽는다 — 그래서 fs로 읽는다.)
 */
const API_AUTH_PATH = fileURLToPath(new URL("../../api/src/auth.ts", import.meta.url));
const MCP_AUTH_PATH = fileURLToPath(new URL("./auth.ts", import.meta.url));

/** 두 파일에 같은 규칙으로 존재해야 하는 함수들. */
const SHARED_FUNCTIONS = ["parseApiKeys", "extractBearerKey"] as const;

/** `function <name>(`부터 중괄호가 닫힐 때까지를 잘라낸다. */
function extractFunction(source: string, name: string): string {
  const start = source.indexOf(`function ${name}(`);
  if (start === -1) throw new Error(`${name}을(를) 원본에서 찾지 못했다: ${API_AUTH_PATH}`);
  const bodyStart = source.indexOf("{", start);
  let depth = 0;
  for (let i = bodyStart; i < source.length; i += 1) {
    if (source[i] === "{") depth += 1;
    else if (source[i] === "}") {
      depth -= 1;
      if (depth === 0) return source.slice(start, i + 1);
    }
  }
  throw new Error(`${name}의 본문 끝을 찾지 못했다`);
}

/** 주석과 공백을 지운다 — 문서 수정만으로는 트립와이어가 울리지 않게. */
function normalize(code: string): string {
  return code
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .replace(/(^|[^:])\/\/[^\n]*/g, "$1")
    .replace(/\s+/g, "");
}

describe("api/src/auth.ts 복제 드리프트 감시", () => {
  it.each(SHARED_FUNCTIONS)("%s가 api 원본과 한 글자도 다르지 않다", (name) => {
    const original = normalize(extractFunction(readFileSync(API_AUTH_PATH, "utf8"), name));
    const copy = normalize(extractFunction(readFileSync(MCP_AUTH_PATH, "utf8"), name));

    expect(
      copy,
      `${name}이(가) packages/api/src/auth.ts의 원본과 갈라졌다. ` +
        "두 표면의 인증 판정이 달라지면 '로컬에선 되는데 서버에선 401'이 재현 불가능한 " +
        "형태로 생긴다. 사본을 맞추거나, 근본 해법인 Findings F-1(파싱을 @sentinel/core로 승격)을 실행하라.",
    ).toBe(original);
  });

  it("감시 대상 함수가 실제로 양쪽에 존재한다 — 추출이 조용히 빈 문자열을 비교하지 않게", () => {
    for (const name of SHARED_FUNCTIONS) {
      expect(
        normalize(extractFunction(readFileSync(MCP_AUTH_PATH, "utf8"), name)).length,
      ).toBeGreaterThan(50);
    }
  });
});
