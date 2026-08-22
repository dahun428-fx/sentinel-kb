import { describe, expect, it } from "vitest";

import {
  assertMeasurable,
  DEFAULT_CORE_API_PORT,
  defaultBaseUrl,
  EvalArgsError,
  isTrustedProvider,
  parseRunArgs,
  resolveEvalApiKey,
} from "./args.js";

const EMPTY: NodeJS.ProcessEnv = {};

describe("parseRunArgs", () => {
  it("인자가 없으면 limit=5, project=sentinel-kb다", () => {
    const args = parseRunArgs([], EMPTY);
    expect(args.limit).toBe(5);
    expect(args.project).toBe("sentinel-kb");
    expect(args.allowFakeEmbeddings).toBe(false);
    expect(args.expectedCaseCount).toBe(30);
  });

  it("스윕용 인자를 읽는다", () => {
    const args = parseRunArgs(["--limit=20", "--project=bizcare-web", "--base-url=http://h:9"], EMPTY);
    expect(args).toMatchObject({ limit: 20, project: "bizcare-web", baseUrl: "http://h:9" });
  });

  /** 계약 상한을 넘겨 보내면 전 케이스가 400으로 실패하고 리포트가 0.0이 된다. */
  it("limit이 계약 상한(20)을 넘으면 거절한다", () => {
    expect(() => parseRunArgs(["--limit=21"], EMPTY)).toThrow(EvalArgsError);
    expect(() => parseRunArgs(["--limit=0"], EMPTY)).toThrow(EvalArgsError);
  });

  /** `--limit 20`(등호 없음)을 조용히 무시하면 5로 잰 리포트를 20으로 잰 줄 알고 커밋한다. */
  it("알 수 없는 인자를 무시하지 않고 던진다", () => {
    expect(() => parseRunArgs(["--limit", "20"], EMPTY)).toThrow(EvalArgsError);
    expect(() => parseRunArgs(["--reset"], EMPTY)).toThrow(EvalArgsError);
  });

  it("base-url은 EVAL_CORE_API_URL → CORE_API_PORT → 3001 순으로 되돌린다", () => {
    expect(defaultBaseUrl({ EVAL_CORE_API_URL: "https://api.example" })).toBe("https://api.example");
    expect(defaultBaseUrl({ CORE_API_PORT: "4000" })).toBe("http://localhost:4000");
    expect(defaultBaseUrl(EMPTY)).toBe(`http://localhost:${String(DEFAULT_CORE_API_PORT)}`);
  });
});

describe("assertMeasurable — 자격증명 없이는 재지 않는다", () => {
  it("fake는 신뢰할 수 없는 provider다", () => {
    expect(isTrustedProvider("fake")).toBe(false);
    expect(isTrustedProvider("voyage")).toBe(true);
  });

  it("fake이고 승인 플래그가 없으면 던진다", () => {
    expect(() => assertMeasurable("fake", false)).toThrow(EvalArgsError);
    expect(() => assertMeasurable("fake", false)).toThrow(/BM25/);
  });

  it("--allow-fake-embeddings가 있으면 통과시킨다 (리포트는 trusted:false가 된다)", () => {
    expect(() => assertMeasurable("fake", true)).not.toThrow();
  });

  it("실제 provider는 플래그 없이 통과한다", () => {
    expect(() => assertMeasurable("voyage", false)).not.toThrow();
  });
});

describe("resolveEvalApiKey", () => {
  it("project 클레임이 일치하는 키를 고른다", () => {
    const keys = new Map([
      ["k1", "sentinel-kb"],
      ["k2", "bizcare-web"],
    ]);
    expect(resolveEvalApiKey(keys, "bizcare-web")).toBe("k2");
  });

  it("없으면 키를 만들어 내지 않고 던진다", () => {
    expect(() => resolveEvalApiKey(new Map(), "sentinel-kb")).toThrow(EvalArgsError);
  });
});
