/**
 * T-006 Acceptance 3: "모델명이 코드에 하드코딩되지 않았음(grep 기반 테스트)".
 *
 * 이 테스트는 **실제 소스 파일을 fs로 읽는다.** 구현에서 상수를 import해 비교하면
 * 자기충족적이 되어(구현이 뭘 하든 통과) 아무것도 검증하지 못한다. (T-004·T-005 교훈)
 *
 * 근거: NFR-06 "임베딩 모델 교체 가능(embeddingVersion)". 모델명이나 차원이 코드에 박히면
 * 교체가 코드 수정 + 재배포가 되고, specs/02의 무중단 재임베딩 절차가 성립하지 않는다.
 */
import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";

const EMBEDDER_DIR = fileURLToPath(new URL(".", import.meta.url));

/** 검사 대상: embedder 구현 소스. 테스트 파일은 금지 문자열을 기대값으로 갖고 있으므로 제외한다. */
function readImplementationSources(): { file: string; content: string }[] {
  return readdirSync(EMBEDDER_DIR)
    .filter((file) => file.endsWith(".ts") && !file.endsWith(".spec.ts"))
    .sort()
    .map((file) => ({ file, content: readFileSync(join(EMBEDDER_DIR, file), "utf8") }));
}

/** 실제 모델명 패턴. 어느 provider의 것이든 소스에 있으면 안 된다. */
const FORBIDDEN_MODEL_PATTERNS: readonly RegExp[] = [
  /voyage-\d/i,
  /text-embedding-/i,
  /embed-english/i,
  /embed-multilingual/i,
  /all-minilm/i,
];

/** 흔한 임베딩 차원. 소스에 리터럴로 있으면 EMBEDDING_DIM이 소스가 아니라는 뜻이다. */
const FORBIDDEN_DIM_LITERALS: readonly number[] = [256, 384, 512, 768, 1024, 1536, 3072];

describe("모델명·차원 하드코딩 금지 (Acceptance 3)", () => {
  it("검사 대상 소스를 실제로 읽었다", () => {
    const sources = readImplementationSources();

    // 파일을 못 찾아 빈 배열을 순회하면 아래 단언들이 전부 공허하게 통과한다.
    expect(sources.map((s) => s.file)).toEqual([
      "config.ts",
      "fake.ts",
      "index.ts",
      "types.ts",
      "voyage.ts",
    ]);
    for (const { file, content } of sources) {
      expect(content.length, `${file}이 비어 있다`).toBeGreaterThan(0);
    }
  });

  it("소스 어디에도 구체 모델명이 없다", () => {
    for (const { file, content } of readImplementationSources()) {
      for (const pattern of FORBIDDEN_MODEL_PATTERNS) {
        expect(pattern.test(content), `${file}에 모델명 ${pattern.source}가 박혀 있다`).toBe(false);
      }
    }
  });

  it("소스 어디에도 임베딩 차원 리터럴이 없다", () => {
    for (const { file, content } of readImplementationSources()) {
      for (const dim of FORBIDDEN_DIM_LITERALS) {
        const pattern = new RegExp(`\\b${String(dim)}\\b`);
        expect(pattern.test(content), `${file}에 차원 리터럴 ${String(dim)}이 박혀 있다`).toBe(
          false,
        );
      }
    }
  });

  it("모델명·차원·버전·키는 env 이름으로만 등장한다", () => {
    const combined = readImplementationSources()
      .map((s) => s.content)
      .join("\n");

    for (const name of [
      "EMBEDDING_PROVIDER",
      "EMBEDDING_MODEL",
      "EMBEDDING_DIM",
      "EMBEDDING_VERSION",
      "EMBEDDING_BATCH_SIZE",
      "VOYAGE_API_KEY",
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
      "EMBEDDING_PROVIDER",
      "EMBEDDING_MODEL",
      "EMBEDDING_DIM",
      "EMBEDDING_VERSION",
      "EMBEDDING_BATCH_SIZE",
      "VOYAGE_API_KEY",
    ]) {
      expect(envExample, `.env.example에 ${name}이 없다`).toContain(`${name}=`);
    }
  });
});
