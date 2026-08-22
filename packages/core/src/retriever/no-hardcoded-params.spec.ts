/**
 * T-011 Acceptance 4: "파라미터 하드코딩 없음(grep 테스트)".
 *
 * `embedder/no-hardcoded-model.spec.ts`와 같은 규약으로 **실제 소스 파일을 fs로 읽는다.**
 * 구현에서 상수를 import해 비교하면 자기충족적이 되어 아무것도 검증하지 못한다.
 *
 * 근거: specs/03 §6 "튜닝 파라미터는 전부 env에서 주입. 코드 하드코딩 금지 — eval에서
 * 스윕하기 위함". 값이 파이프라인 코드에 박히면 T-013이 K·RRF_K를 흔들 수 없다.
 *
 * 검사 대상에서 `config.ts`는 뺀다 — 기본값이 사는 **유일하게 승인된 자리**이고,
 * 그 값이 `.env.example`과 같은지는 `config.spec.ts`가 따로 대조한다.
 */
import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";

import { RETRIEVAL_DEFAULTS } from "./config.js";

const RETRIEVER_DIR = fileURLToPath(new URL(".", import.meta.url));
/** 기본값이 살아도 되는 유일한 파일. */
const CONFIG_FILE = "config.ts";

/**
 * **수학 상수 예외 목록.** 이 가드는 리터럴을 문자 단위로 찾으므로 튜닝 값과 우연히 같은
 * **수학 상수**를 구별하지 못한다. 실제로 `RETRIEVAL_MAX_CHUNKS_PER_RECORD=2` 때문에
 * `2 * s - 1`(정규화 → 원시 cosine 환산)이 막혀, 구현이 `s + s - 1`로 뒤틀렸다.
 * 그런 코드는 오타처럼 보여서 다음 사람이 "고치다가" 이유를 알 수 없는 실패를 만난다.
 *
 * 그래서 예외를 **코드에 숨기지 않고 여기에 드러낸다.** 규칙:
 *  - 항목은 **정확한 코드 문자열**이어야 한다. 값이 아니라 표현식을 면제한다.
 *  - 아래 테스트가 **각 항목이 실제로 어딘가 존재함**을 단언한다 — 낡은 면제는 그린이 되지 않고 죽는다.
 *  - 목록이 길어지면 그건 가드가 아니라 설계를 다시 볼 신호다.
 */
const MATH_CONSTANT_EXEMPTIONS = [
  // Atlas가 (1+cos)/2로 정규화한 값을 원시 cosine으로 되돌리는 식. `2`는 튜닝 값이 아니다.
  "2 * normalized - 1",
] as const;

function readPipelineSources(): { file: string; code: string }[] {
  return readdirSync(RETRIEVER_DIR)
    .filter((file) => file.endsWith(".ts") && !file.endsWith(".spec.ts") && file !== CONFIG_FILE)
    .sort()
    .map((file) => ({
      file,
      code: stripExemptions(stripComments(readFileSync(join(RETRIEVER_DIR, file), "utf8"))),
    }));
}

function stripExemptions(source: string): string {
  return MATH_CONSTANT_EXEMPTIONS.reduce((code, expr) => code.split(expr).join(" "), source);
}

/**
 * 주석을 걷어낸다. 산문에는 "specs/03 §2"·"T-005 F-3"처럼 숫자가 널려 있고,
 * 그것까지 금지하면 근거를 적을 수 없게 된다. 검사 대상은 **코드**다.
 */
function stripComments(source: string): string {
  return source.replace(/\/\*[\s\S]*?\*\//g, " ").replace(/\/\/.*$/gm, " ");
}

describe("retriever 파라미터 하드코딩 금지 (Acceptance 4)", () => {
  it("검사 대상 소스를 실제로 읽었다", () => {
    // 파일을 못 찾아 빈 배열을 순회하면 아래 단언들이 전부 공허하게 통과한다.
    expect(readPipelineSources().map((s) => s.file)).toEqual([
      "index.ts",
      "retrieve.ts",
      "rrf.ts",
      "types.ts",
    ]);
    for (const { file, code } of readPipelineSources()) {
      expect(code.length, `${file}이 비어 있다`).toBeGreaterThan(0);
    }
  });

  it("수학 상수 예외가 전부 실제로 쓰이고 있다", () => {
    // 낡은 면제가 남으면 그 값에 대한 가드가 조용히 헐거워진다.
    // 원문(면제 적용 전)에서 찾아야 한다 — 면제된 코드는 위에서 이미 지워졌다.
    const raw = readdirSync(RETRIEVER_DIR)
      .filter((file) => file.endsWith(".ts") && !file.endsWith(".spec.ts") && file !== CONFIG_FILE)
      .map((file) => stripComments(readFileSync(join(RETRIEVER_DIR, file), "utf8")))
      .join("\n");

    for (const expr of MATH_CONSTANT_EXEMPTIONS) {
      expect(raw.includes(expr), `면제 "${expr}"가 이제 어디에도 없다 — 목록에서 지워라`).toBe(true);
    }
  });

  it("파이프라인 코드 어디에도 튜닝 값 리터럴이 없다", () => {
    const forbidden = [...new Set(Object.values(RETRIEVAL_DEFAULTS))];
    // 표가 비면 이 테스트가 아무것도 검사하지 않는다.
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
      expect(/RETRIEVAL_[A-Z_]+"/.test(code), `${file}이 env 이름을 직접 참조한다`).toBe(false);
    }
  });

  it("config.ts가 env 이름 전부를 읽고, .env.example이 그 이름을 정의한다", () => {
    const config = readFileSync(join(RETRIEVER_DIR, CONFIG_FILE), "utf8");
    const envExample = readFileSync(
      fileURLToPath(new URL("../../../../.env.example", import.meta.url)),
      "utf8",
    );

    for (const name of Object.keys(RETRIEVAL_DEFAULTS)) {
      expect(config, `config.ts가 ${name}을 읽지 않는다`).toContain(name);
      expect(envExample, `.env.example에 ${name}이 없다`).toContain(`${name}=`);
    }
  });
});
