/**
 * generator 소스 가드. 출처: specs/03 §6(파라미터 env화), §4 + specs/03:62(척도 금지),
 * T-011 F-A(이중 환산 금지).
 *
 * `retriever/no-hardcoded-params.spec.ts`와 같은 규약으로 **실제 소스 파일을 fs로 읽는다.**
 * 구현에서 상수를 import해 비교하면 자기충족적이 되어 아무것도 검증하지 못한다.
 *
 * 여기 있는 가드들은 행동 테스트가 이미 잡는 것들과 **겹친다.** 겹치는 것이 목적이다 —
 * 행동 테스트는 "지금 이 입력에서 틀렸다"를 잡고, 이 가드는 "그 실수를 쓸 자리가 아예 없다"를
 * 잡는다. 후자는 아직 테스트가 없는 새 코드 경로에도 적용된다.
 */
import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";

import { GENERATOR_DEFAULTS } from "./config.js";

const GENERATOR_DIR = fileURLToPath(new URL(".", import.meta.url));

/** 기본값이 살아도 되는 유일한 파일. */
const CONFIG_FILE = "config.ts";

/** 테스트 픽스처. 프로덕션 경로가 아니므로 튜닝 값 가드 대상이 아니다. */
const FIXTURES_FILE = "fixtures.ts";

function pipelineFiles(): string[] {
  return readdirSync(GENERATOR_DIR)
    .filter(
      (file) =>
        file.endsWith(".ts") &&
        !file.endsWith(".spec.ts") &&
        file !== CONFIG_FILE &&
        file !== FIXTURES_FILE,
    )
    .sort();
}

function readPipelineSources(): { file: string; code: string }[] {
  return pipelineFiles().map((file) => ({
    file,
    code: stripComments(readFileSync(join(GENERATOR_DIR, file), "utf8")),
  }));
}

/**
 * 주석을 걷어낸다. 산문에는 "specs/03 §4"·"T-011 F-A"·"0.62"처럼 숫자가 널려 있고,
 * 그것까지 금지하면 근거를 적을 수 없게 된다. 검사 대상은 **코드**다.
 */
function stripComments(source: string): string {
  return source.replace(/\/\*[\s\S]*?\*\//g, " ").replace(/\/\/.*$/gm, " ");
}

describe("generator 소스 가드", () => {
  it("검사 대상 소스를 실제로 읽었다", () => {
    // 파일을 못 찾아 빈 배열을 순회하면 아래 단언들이 전부 공허하게 통과한다.
    expect(pipelineFiles()).toEqual([
      "context.ts",
      "gate.ts",
      "generate.ts",
      "index.ts",
      "prompt.ts",
    ]);
    for (const { file, code } of readPipelineSources()) {
      expect(code.length, `${file}이 비어 있다`).toBeGreaterThan(0);
    }
  });

  it("파이프라인 코드 어디에도 튜닝 값 리터럴이 없다", () => {
    const forbidden = [...new Set(Object.values(GENERATOR_DEFAULTS))];
    expect(forbidden.length).toBeGreaterThan(0);

    for (const { file, code } of readPipelineSources()) {
      for (const value of forbidden) {
        const pattern = new RegExp(`(?<![\\w.])${String(value)}(?![\\w.])`);
        expect(pattern.test(code), `${file}에 튜닝 값 ${String(value)}가 박혀 있다`).toBe(false);
      }
    }
  });

  it("파이프라인 코드는 env를 직접 읽지 않는다 — config.ts만 읽는다", () => {
    for (const { file, code } of readPipelineSources()) {
      expect(code.includes("process.env"), `${file}이 env를 직접 읽는다`).toBe(false);
      expect(code.includes("SIMILARITY_THRESHOLD"), `${file}이 env 이름을 직접 참조한다`).toBe(
        false,
      );
    }
  });

  it("config.ts가 env 이름 전부를 읽고, .env.example이 그 이름을 정의한다", () => {
    const config = readFileSync(join(GENERATOR_DIR, CONFIG_FILE), "utf8");
    const envExample = readFileSync(
      fileURLToPath(new URL("../../../../.env.example", import.meta.url)),
      "utf8",
    );

    for (const name of Object.keys(GENERATOR_DEFAULTS)) {
      expect(config, `config.ts가 ${name}을 읽지 않는다`).toContain(name);
      expect(envExample, `.env.example에 ${name}이 없다`).toContain(`${name}=`);
    }
  });

  it(".env.example의 SIMILARITY_THRESHOLD가 코드 기본값과 같다", () => {
    const envExample = readFileSync(
      fileURLToPath(new URL("../../../../.env.example", import.meta.url)),
      "utf8",
    );
    const match = /^SIMILARITY_THRESHOLD=(.+)$/m.exec(envExample);
    expect(match?.[1]).toBe(String(GENERATOR_DEFAULTS.SIMILARITY_THRESHOLD));
  });

  /*
   * specs/03:62가 금지한 척도 비교. `fusedScore`는 `Σ 1/(k+rank)` 척도라 cosine 임계값과
   * 비교할 수 없다. 게이트 코드가 그 필드를 **읽을 수조차 없어야** 실수할 자리가 없다.
   */
  it("게이트·생성 코드가 fusedScore를 읽지 않는다 (감사 B-1)", () => {
    for (const { file, code } of readPipelineSources()) {
      expect(code.includes("fusedScore"), `${file}이 RRF 점수를 참조한다`).toBe(false);
    }
  });

  /*
   * T-011 F-A: retriever가 이미 `2s − 1`로 원시 cosine을 만들어 준다.
   * generator가 다시 환산하면 0.62가 실질 0.81 게이트가 된다.
   */
  it("generator가 정규화↔cosine 환산을 다시 하지 않는다 (T-011 F-A)", () => {
    for (const { file, code } of readPipelineSources()) {
      expect(/2\s*\*[^;\n]*maxVectorScore/.test(code), `${file}이 이중 환산한다`).toBe(false);
      expect(/maxVectorScore[^;\n]*\*\s*2/.test(code), `${file}이 이중 환산한다`).toBe(false);
    }
  });

  /*
   * specs/03 §2가 지목한 플래그. 상수 이름이 바뀌어도 리터럴은 남아야 한다 —
   * 이 문자열이 generator에서 사라지면 제외 로직이 사라진 것이다(NFR-05).
   */
  it("injection-suspect 제외가 코드에 실재한다 (NFR-05)", () => {
    const all = readPipelineSources()
      .map((s) => s.code)
      .join("\n");
    expect(all).toContain("injection-suspect");
  });
});
