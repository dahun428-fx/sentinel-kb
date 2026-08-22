/**
 * 코퍼스 자체의 성질을 잠근다. **가장 중요한 것은 시드 미오염 가드다.**
 *
 * T-021의 필수 조건: "오염 레코드를 기존 시드 50건에 섞지 마라 — 섞으면 T-013 골든셋과
 * `pnpm db:seed`가 오염된다." 그 조건은 주석으로는 지켜지지 않는다. 다음 사람이 "eval에서
 * 쓰려면 시드에 있어야 편하지"라고 생각하는 순간 조용히 깨지고, 깨진 뒤에는 retrieval eval의
 * 수치가 왜 흔들리는지 아무도 되짚지 못한다. 그래서 실제 시드 파일을 읽어 대조한다.
 */
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

import { sanitize } from "@sentinel/core";
import { describe, expect, it } from "vitest";

import { CONTROL_RECORD, INJECTION_AXES, TAINTED_CORPUS, corpusBodies } from "./corpus.js";

const SEED_ROOT = fileURLToPath(new URL("../../packages/core/seed/", import.meta.url));

/** 시드 디렉터리의 모든 JSON을 `{경로, 원문}`으로 읽는다. */
function seedFiles(): { path: string; raw: string }[] {
  const files: { path: string; raw: string }[] = [];
  for (const dir of readdirSync(SEED_ROOT, { withFileTypes: true })) {
    if (!dir.isDirectory()) continue;
    const dirPath = join(SEED_ROOT, dir.name);
    for (const entry of readdirSync(dirPath)) {
      if (!entry.endsWith(".json")) continue;
      files.push({ path: join(dir.name, entry), raw: readFileSync(join(dirPath, entry), "utf8") });
    }
  }
  return files;
}

describe("레드팀 코퍼스 — 시드 미오염 (T-021 필수 조건)", () => {
  it("시드 파일 어디에도 레드팀 페이로드가 들어 있지 않다", () => {
    const files = seedFiles();
    // 시드가 0건이면 이 테스트는 아무것도 재지 않는다 — 공허한 그린을 먼저 막는다.
    expect(files.length).toBeGreaterThan(0);

    const contaminated = files.flatMap(({ path, raw }) =>
      corpusBodies()
        .filter((body) => raw.includes(body))
        .map((body) => `${path}: ${body.slice(0, 24)}…`),
    );

    expect(contaminated).toEqual([]);
  });

  /**
   * 위 테스트는 **글자 그대로의 복사**만 잡는다. 실제로 이 뮤테이션을 돌려 보니 페이로드를
   * 한 글자만 바꿔 시드에 넣으면 그대로 살아남았다 — 문자열 일치는 오염 가드로 약하다.
   * 그래서 판정을 **새니타이저 자신**에게 맡긴다: 시드 어느 파일도 `injection-suspect`로
   * 발화하면 안 된다. 현행 시드 50건은 전부 0건으로 통과한다(실측).
   *
   * ⚠️ 여기가 앞으로 깨질 수 있는 정당한 경우가 하나 있다: "이 프롬프트가 에이전트를
   * 탈선시켰다"는 divergence 기록은 **본문 자체가 인젝션 문구**다(`injection.ts` 서두).
   * 그런 기록을 정말 시드에 넣어야 한다면 그건 이 테스트를 지울 이유가 아니라
   * **사람이 판단해 명시적으로 허용할 이유**다 — 조용히 통과시키면 골든셋이 오염된 사실이
   * 아무 데도 안 남는다.
   */
  it("시드 어느 파일도 `injection-suspect`로 발화하지 않는다", () => {
    const tripped = seedFiles()
      .map(({ path, raw }) => ({ path, result: sanitize(raw, { maskEmail: false }) }))
      .filter(({ result }) => result.flags.includes("injection-suspect"))
      .map(({ path, result }) => `${path}: ${result.injectionRules.join(",")}`);

    expect(tripped).toEqual([]);
  });

  it("시드에 `INJ-` 접두 레코드 파일이 없다", () => {
    const injectionSeeds = seedFiles().filter(({ path }) => path.includes("INJ-"));

    expect(injectionSeeds.map(({ path }) => path)).toEqual([]);
  });

  it("코퍼스 id가 시드 id 접두와 겹치지 않는다", () => {
    const seedPrefixes = ["INC-", "DIV-", "PUB-", "SELF-"];
    const collisions = TAINTED_CORPUS.filter((record) =>
      seedPrefixes.some((prefix) => record.id.startsWith(prefix)),
    );

    expect(collisions.map((record) => record.id)).toEqual([]);
  });
});

describe("레드팀 코퍼스 — 구성", () => {
  it("specs/05 Eval 4가 요구한 10건이다", () => {
    expect(TAINTED_CORPUS).toHaveLength(10);
  });

  it("id가 중복되지 않는다", () => {
    const ids = TAINTED_CORPUS.map((record) => record.id);

    expect(new Set(ids).size).toBe(ids.length);
  });

  it("선언된 축 10개를 하나도 빠짐없이 덮는다", () => {
    // 축이 겹치면 실제로는 8개 축만 재면서 10건을 쟀다고 보고하게 된다.
    const axes = TAINTED_CORPUS.map((record) => record.axis);

    expect([...axes].sort()).toEqual([...INJECTION_AXES].sort());
  });

  it("모든 레코드에 본문이 있는 섹션이 하나 이상 있다", () => {
    const empty = TAINTED_CORPUS.filter(
      (record) => record.sections.filter(([, body]) => body.trim().length > 0).length === 0,
    );

    expect(empty.map((record) => record.id)).toEqual([]);
  });

  it("대조군은 오염되지 않은 정상 기록이다", () => {
    // 대조군이 오염돼 있으면 "제외가 전부 버리기로 퇴화했는가"를 영영 관측할 수 없다.
    expect(CONTROL_RECORD.sections.length).toBeGreaterThan(0);
    expect(corpusBodies()).not.toContain(CONTROL_RECORD.sections[0]?.[1]);
  });
});
