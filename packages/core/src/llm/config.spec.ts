/**
 * `readAnthropicConfig` 단위 테스트. 출처: T-039 Acceptance A5, D-2·D-5.
 *
 * env를 인자로 받는 설계라 `process.env`를 건드리지 않는다 — 전역을 흔드는 테스트는
 * 병렬 실행에서 서로를 오염시킨다(`embedder/config.spec.ts`와 같은 규약).
 */
import { describe, expect, it } from "vitest";

import { LLM_DEFAULTS, readAnthropicConfig } from "./config.js";
import { LLM_ERROR_CODES, LlmError } from "./types.js";

const VALID: NodeJS.ProcessEnv = {
  ANTHROPIC_MODEL: "model-under-test",
  ANTHROPIC_API_KEY: "key-under-test-0123456789",
};

function codeOf(fn: () => unknown): string {
  try {
    fn();
  } catch (error) {
    return error instanceof LlmError ? error.code : `<${String(error)}>`;
  }
  return "<던지지 않았다>";
}

describe("readAnthropicConfig", () => {
  // A5
  describe("모델·키는 없으면 던진다 — 조용한 폴백 없음", () => {
    it("ANTHROPIC_MODEL이 없으면 MODEL_MISSING", () => {
      expect(codeOf(() => readAnthropicConfig({ ANTHROPIC_API_KEY: "k0123456789" }))).toBe(
        LLM_ERROR_CODES.MODEL_MISSING,
      );
    });

    it("ANTHROPIC_MODEL이 공백뿐이어도 MODEL_MISSING", () => {
      expect(codeOf(() => readAnthropicConfig({ ...VALID, ANTHROPIC_MODEL: "   " }))).toBe(
        LLM_ERROR_CODES.MODEL_MISSING,
      );
    });

    it("ANTHROPIC_API_KEY가 없으면 API_KEY_MISSING", () => {
      expect(codeOf(() => readAnthropicConfig({ ANTHROPIC_MODEL: "m" }))).toBe(
        LLM_ERROR_CODES.API_KEY_MISSING,
      );
    });

    it("ANTHROPIC_API_KEY가 빈 문자열이어도 API_KEY_MISSING", () => {
      expect(codeOf(() => readAnthropicConfig({ ...VALID, ANTHROPIC_API_KEY: "" }))).toBe(
        LLM_ERROR_CODES.API_KEY_MISSING,
      );
    });

    it("에러 메시지가 키 값을 담지 않는다", () => {
      const secret = "sk-super-secret-value-0123456789";
      let message = "";
      try {
        readAnthropicConfig({ ANTHROPIC_API_KEY: secret });
      } catch (error) {
        message = error instanceof Error ? error.message : String(error);
      }
      // 이 갈래는 MODEL_MISSING이지만, 키가 메시지에 섞일 이유가 없다는 점은 같다.
      expect(message).not.toContain(secret);
    });

    it("모델과 키가 둘 다 있으면 그대로 돌려준다(trim 적용)", () => {
      const config = readAnthropicConfig({
        ANTHROPIC_MODEL: "  model-x  ",
        ANTHROPIC_API_KEY: "  key-x-0123456789  ",
      });
      expect(config.model).toBe("model-x");
      expect(config.apiKey).toBe("key-x-0123456789");
    });
  });

  describe("타임아웃·재시도는 오설정 시 역산 기본값으로 되돌린다", () => {
    it("미설정이면 기본값", () => {
      const config = readAnthropicConfig(VALID);
      expect(config.timeoutMs).toBe(LLM_DEFAULTS.ANTHROPIC_TIMEOUT_MS);
      expect(config.maxRetries).toBe(LLM_DEFAULTS.ANTHROPIC_MAX_RETRIES);
    });

    it("기본 타임아웃이 MCP 클라이언트의 시도당 10초보다 작다 (T-019 F-7 역산)", () => {
      // 이 부등식이 깨지면 "완료해도 아무도 받지 못하는 생성"이 다시 생긴다.
      expect(LLM_DEFAULTS.ANTHROPIC_TIMEOUT_MS).toBeLessThan(10_000);
    });

    it("기본 재시도가 SDK 기본값(2)보다 작다 — 층이 곱해지는 것을 막는다", () => {
      expect(LLM_DEFAULTS.ANTHROPIC_MAX_RETRIES).toBeLessThan(2);
    });

    it("유효한 값은 그대로 쓴다", () => {
      const config = readAnthropicConfig({
        ...VALID,
        ANTHROPIC_TIMEOUT_MS: "1234",
        ANTHROPIC_MAX_RETRIES: "3",
      });
      expect(config.timeoutMs).toBe(1234);
      expect(config.maxRetries).toBe(3);
    });

    it("재시도 0은 유효값이다 — '재시도하지 마라'를 표현할 수 있어야 한다", () => {
      expect(readAnthropicConfig({ ...VALID, ANTHROPIC_MAX_RETRIES: "0" }).maxRetries).toBe(0);
    });

    it("타임아웃 0·음수·비수치는 기본값으로 되돌린다", () => {
      for (const raw of ["0", "-1", "abc", "1.5"]) {
        expect(
          readAnthropicConfig({ ...VALID, ANTHROPIC_TIMEOUT_MS: raw }).timeoutMs,
          `ANTHROPIC_TIMEOUT_MS=${raw}`,
        ).toBe(LLM_DEFAULTS.ANTHROPIC_TIMEOUT_MS);
      }
    });

    it("재시도 음수·비수치는 기본값으로 되돌린다", () => {
      for (const raw of ["-1", "abc", "1.5"]) {
        expect(
          readAnthropicConfig({ ...VALID, ANTHROPIC_MAX_RETRIES: raw }).maxRetries,
          `ANTHROPIC_MAX_RETRIES=${raw}`,
        ).toBe(LLM_DEFAULTS.ANTHROPIC_MAX_RETRIES);
      }
    });
  });
});
