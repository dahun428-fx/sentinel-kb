import { ApiKeyConfigError, parseApiKeys } from "@sentinel/core";
import { describe, expect, it } from "vitest";

// T-037: `parseApiKeys`는 `@sentinel/core`의 한 벌을 쓴다. **아래 단언은 한 글자도
// 바뀌지 않았다** — import 경로만 옮겼다. 이 테스트가 그대로 통과한다는 사실이
// "mcp 쪽 인증 동작이 하나도 안 바뀌었다"의 증인이고, 동시에 mcp가 정말 core의
// 한 벌을 쓰는지 관측하는 지점이다(core를 망가뜨리면 여기가 죽어야 한다).
import { McpAuthError, resolveAuth } from "./auth.js";

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
    const messages = [undefined, "Bearer nope", "Basic x", "Bearer "].map((header) => {
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
 * ## 복제 드리프트 트립와이어 — **T-037에서 회수했다.**
 *
 * 여기에는 `parseApiKeys`/`extractBearerKey`의 본문을 `packages/api/src/auth.ts`에서
 * `readFileSync`로 읽어 **문자 단위로 대조**하는 테스트가 있었다. 그 테스트의 존재
 * 이유는 오직 하나 — 같은 규칙이 api와 mcp에 **두 벌** 있었고 조용히 갈라질 수 있었다는 것.
 *
 * T-037이 파싱을 `@sentinel/core`로 올려 **사본이 하나도 남지 않았다.** 감시할 대상이
 * 없어졌으므로 남겨두면 항상 참인 죽은 테스트가 된다. 이건 "테스트를 고쳐 통과시키는 것"이
 * 아니라 **존재 이유가 사라진 감시기의 회수**이고, T-037 Acceptance 2가 명시적으로 요구했다.
 *
 * 감시기가 대체된 것도 아니다 — 대체가 필요 없다. 두 표면이 **같은 함수 객체**를 부르므로
 * 갈라질 자리 자체가 없다. 그걸 관측하는 것은 이 파일과 `packages/api/src/auth.spec.ts`가
 * 각자 `@sentinel/core`의 `parseApiKeys`를 직접 부른다는 사실이다:
 * core의 규칙을 하나 깨면 **양쪽이 함께 죽는다.** 한쪽만 죽으면 한쪽이 여전히 자기 사본을
 * 쓰고 있다는 뜻이고, 그게 회수 후에도 남는 유일한 관측 가능한 실패 양식이다.
 *
 * T-014가 이 감시기에 대해 기록한 한계(디코이 주석으로 무력화됨, "갈라졌다"만 알리고
 * 어느 쪽이 옳은지는 판정 못 함)도 함께 사라진다.
 */
