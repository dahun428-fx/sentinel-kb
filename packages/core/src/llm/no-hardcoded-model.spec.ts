/**
 * llm 소스 가드. 출처: T-039 Acceptance A2·A3·A10, D-2·D-3.
 *
 * `embedder/no-hardcoded-model.spec.ts`와 같은 규약으로 **실제 소스 파일을 fs로 읽는다.**
 * 구현에서 상수를 import해 비교하면 자기충족적이 되어(구현이 뭘 하든 통과) 아무것도
 * 검증하지 못한다(T-004·T-005 교훈).
 *
 * ## 왜 embedder 쪽 spec을 재사용하지 않았나
 *
 * `embedder/no-hardcoded-model.spec.ts`는 검사 대상 파일 목록을 **리터럴로 단언**한다.
 * 거기에 llm 파일을 태우려면 embedder 디렉터리에 파일을 만들어야 하고, 그러면 그 단언이
 * 무관한 이유로 깨진다(T-010 F-1이 겪은 그 상황). 같은 이유로 이 파일도 llm 디렉터리에 있고
 * llm 파일만 본다.
 *
 * ## 주석은 걷어낸다 (`generator/no-hardcoded-params.spec.ts` 선례)
 *
 * 이 디렉터리의 산문은 "현행 Claude 모델(Opus 5·Sonnet 5)은 temperature를 400으로 거절한다"
 * 같은 **결정의 근거**를 적어야 하고, 그걸 금지하면 근거를 쓸 수 없게 된다. 검사 대상은
 * **코드**다 — 주석에 박힌 모델명은 요청으로 나가지 않는다.
 */
import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";

const LLM_DIR = fileURLToPath(new URL(".", import.meta.url));

function sourceFiles(): string[] {
  return readdirSync(LLM_DIR)
    .filter((file) => file.endsWith(".ts") && !file.endsWith(".spec.ts"))
    .sort();
}

function specFiles(): string[] {
  return readdirSync(LLM_DIR)
    .filter((file) => file.endsWith(".spec.ts"))
    .sort();
}

/** 주석을 걷어낸다. 검사 대상은 코드다. */
function stripComments(source: string): string {
  return source.replace(/\/\*[\s\S]*?\*\//g, " ").replace(/\/\/.*$/gm, " ");
}

function readSources(): { file: string; code: string }[] {
  return sourceFiles().map((file) => ({
    file,
    code: stripComments(readFileSync(join(LLM_DIR, file), "utf8")),
  }));
}

/**
 * 구체 모델 ID 패턴. 어느 provider의 것이든 코드에 있으면 안 된다.
 * `claude-opus-5`·`claude-sonnet-4-6`·`gpt-5`·`gemini-2` 같은 것들을 잡는다.
 */
const FORBIDDEN_MODEL_PATTERNS: readonly RegExp[] = [
  /claude-[a-z]+-\d/i,
  /\b(opus|sonnet|haiku|fable|mythos)-\d/i,
  /\bgpt-\d/i,
  /\bgemini-\d/i,
  /\bllama-?\d/i,
];

/**
 * 샘플링 파라미터. 현행 Claude 모델은 이것들을 400으로 거절한다(T-018 D-3).
 * 코드에 이름이 등장할 자리가 아예 없어야 실수할 자리가 없다.
 */
const FORBIDDEN_SAMPLING_PARAMS: readonly string[] = [
  "temperature",
  "top_p",
  "topP",
  "top_k",
  "topK",
];

describe("llm 소스 가드", () => {
  it("검사 대상 소스를 실제로 읽었다", () => {
    // 파일을 못 찾아 빈 배열을 순회하면 아래 단언들이 전부 공허하게 통과한다.
    expect(sourceFiles()).toEqual([
      "anthropic.ts",
      "config.ts",
      "fake.ts",
      "index.ts",
      "tools.ts",
      "types.ts",
    ]);
    for (const { file, code } of readSources()) {
      expect(code.length, `${file}이 비어 있다`).toBeGreaterThan(0);
    }
  });

  // A2
  it("코드 어디에도 구체 모델 ID가 없다", () => {
    for (const { file, code } of readSources()) {
      for (const pattern of FORBIDDEN_MODEL_PATTERNS) {
        expect(pattern.test(code), `${file}에 모델 ID ${pattern.source}가 박혀 있다`).toBe(false);
      }
    }
  });

  // A3
  it("코드 어디에도 샘플링 파라미터가 없다 (현행 모델은 400으로 거절한다)", () => {
    for (const { file, code } of readSources()) {
      for (const param of FORBIDDEN_SAMPLING_PARAMS) {
        expect(code.includes(param), `${file}이 ${param}을 참조한다`).toBe(false);
      }
    }
  });

  it("모델 ID·키·타임아웃·재시도는 env 이름으로만 등장한다", () => {
    const combined = readSources()
      .map((s) => s.code)
      .join("\n");

    for (const name of [
      "ANTHROPIC_MODEL",
      "ANTHROPIC_API_KEY",
      "ANTHROPIC_TIMEOUT_MS",
      "ANTHROPIC_MAX_RETRIES",
    ]) {
      expect(combined, `${name}을 env에서 읽는 코드가 없다`).toContain(name);
    }
  });

  it(".env.example이 그 env 이름들을 실제로 정의한다", () => {
    const envExample = readFileSync(
      fileURLToPath(new URL("../../../../.env.example", import.meta.url)),
      "utf8",
    );

    for (const name of [
      "ANTHROPIC_MODEL",
      "ANTHROPIC_API_KEY",
      "ANTHROPIC_TIMEOUT_MS",
      "ANTHROPIC_MAX_RETRIES",
    ]) {
      expect(envExample, `.env.example에 ${name}이 없다`).toContain(`${name}=`);
    }
  });

  it("타임아웃·재시도 기본값이 config.ts 밖에 박혀 있지 않다", () => {
    for (const { file, code } of readSources()) {
      if (file === "config.ts") continue;
      expect(/\b8000\b/.test(code), `${file}에 타임아웃 기본값이 박혀 있다`).toBe(false);
    }
  });

  /*
   * A10. specs/05: "실제 모델 호출은 **eval 계층에서만**. CI 비용·불안정성 통제."
   * `pnpm verify` 경로의 테스트가 네트워크를 타면 CI가 자격증명과 provider 가용성에 결합된다.
   * 이 디렉터리의 spec은 전부 `fetch` 주입이나 fake만 써야 한다.
   */
  it("llm 테스트는 네트워크를 타지 않는다", () => {
    const specs = specFiles();
    expect(specs.length, "검사할 spec 파일이 없다").toBeGreaterThan(0);

    for (const file of specs) {
      const code = stripComments(readFileSync(join(LLM_DIR, file), "utf8"));
      expect(/globalThis\.fetch/.test(code), `${file}이 전역 fetch를 쓴다`).toBe(false);
      // 실 자격증명을 env에서 집어 실제로 호출하는 경로가 생기면 여기서 걸린다.
      expect(
        /process\.env\s*\[\s*["']ANTHROPIC_API_KEY/.test(code),
        `${file}이 실 API 키를 읽는다`,
      ).toBe(false);
    }
  });
});
