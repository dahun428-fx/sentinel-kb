/**
 * 작문 파이프라인 테스트 — T-031 Acceptance 2·3.
 *
 * **실제 모델은 부르지 않는다**(specs/05: unit/integration은 fixture 목). 따라서 이 테스트가
 * 재는 것은 "좋은 글이 나오는가"가 **아니라** "게이트가 실제로 작동하는가"다. 전자는
 * API 키 없이 판정 불가이며 §6·T-034의 몫이다 — 그 구분을 흐리지 않으려고 여기 적어 둔다.
 */
import { ArticleSchema } from "@sentinel/contracts";
import { describe, expect, it } from "vitest";

import { FACT_FIXTURE_RECORDS, JAPANESE_INJECTION_FRAGMENTS, LEAKED_STRINGS } from "../facts/facts.fixture.js";
import { createFakeChatModel, type FakeChatModel } from "../llm/fake.js";
import { LlmError } from "../llm/types.js";

import { MAX_REWRITES, draftArticle, rewriteInstruction, type DraftOutcome } from "./draft.js";
import { lintDraft } from "./lint.js";
import {
  ACCEPTED_DRAFT,
  DRAFT_WITH_INVENTED_NUMBER,
  fixtureFacts,
} from "./publisher.fixture.js";

const facts = fixtureFacts();

/** 스타일 표본은 레포 상태에 의존하지 않게 빈 디렉터리로 고정한다. */
const NO_STYLE_DIR = "/nonexistent-style-dir-for-tests";

/** 문체 위반 초안. 금지 표현 하나만 심는다. */
const LINT_FAILING_DRAFT = ACCEPTED_DRAFT.replace(
  "재발 간격은 고르지 않았다.",
  "결론적으로 재발 간격은 고르지 않았다.",
);

function scriptedModel(replies: readonly string[]): FakeChatModel {
  let index = 0;
  return createFakeChatModel({
    reply: () => {
      const reply = replies[Math.min(index, replies.length - 1)] ?? "";
      index += 1;
      return reply;
    },
  });
}

async function run(
  replies: readonly string[],
  overrides: Partial<Parameters<typeof draftArticle>[0]> = {},
): Promise<{ outcome: DraftOutcome; model: FakeChatModel }> {
  const model = scriptedModel(replies);
  const outcome = await draftArticle({
    kind: "pattern",
    facts,
    records: FACT_FIXTURE_RECORDS,
    model,
    styleDir: NO_STYLE_DIR,
    ...overrides,
  });
  return { outcome, model };
}

describe("draftArticle — 통과 경로", () => {
  it("린트와 팩트 대조를 통과하면 draft 패치를 낸다", async () => {
    const { outcome, model } = await run([ACCEPTED_DRAFT]);
    expect(outcome.accepted).toBe(true);
    if (!outcome.accepted) return;
    expect(model.calls).toHaveLength(1);
    expect(outcome.report.attempts).toBe(1);
    expect(outcome.report.rewrites).toBe(0);
    expect(outcome.report.factCheck?.passed).toBe(true);
  });

  it("Acceptance 3 — draft 패치에 lintReport가 함께 들어간다", async () => {
    const { outcome } = await run([ACCEPTED_DRAFT]);
    if (!outcome.accepted) throw new Error("통과 경로가 아니다");
    expect(outcome.patch.lintReport).toBe(outcome.report);
    expect(outcome.patch.lintReport.lint?.passed).toBe(true);
    expect(outcome.patch.lintReport.narrative.records).toBeGreaterThan(0);
  });

  it("패치는 status가 draft이고 publishedAt이 아예 없다 (§0-5 전자동 발행 금지)", async () => {
    const { outcome } = await run([ACCEPTED_DRAFT]);
    if (!outcome.accepted) throw new Error("통과 경로가 아니다");
    expect(outcome.patch.status).toBe("draft");
    expect(Object.keys(outcome.patch).sort()).toEqual(["body", "charts", "lintReport", "status"]);
  });

  it("패치를 candidate 아티클에 덮으면 계약을 통과한다", async () => {
    const { outcome } = await run([ACCEPTED_DRAFT]);
    if (!outcome.accepted) throw new Error("통과 경로가 아니다");
    const candidate = {
      _id: "a".repeat(24),
      kind: "pattern" as const,
      sourceRecordIds: [...facts.sourceRecordIds],
      title: "우리는 왜 자꾸 기본값에서 넘어지는가",
      slug: "why-defaults-keep-breaking-us",
      status: "candidate" as const,
      editHistory: [],
      createdAt: new Date("2026-05-05T00:00:00.000Z"),
    };
    const merged = ArticleSchema.parse({
      ...candidate,
      ...outcome.patch,
      charts: [...outcome.patch.charts],
    });
    expect(merged.status).toBe("draft");
    expect(merged.publishedAt).toBeUndefined();
    expect(merged.lintReport).toBeDefined();
  });
});

describe("draftArticle — 재작성 루프", () => {
  it("문체 위반이면 지적사항을 붙여 다시 쓰게 한다", async () => {
    const { outcome, model } = await run([LINT_FAILING_DRAFT, ACCEPTED_DRAFT]);
    expect(outcome.accepted).toBe(true);
    expect(outcome.report.rewrites).toBe(1);
    expect(outcome.report.attempts).toBe(2);
    expect(model.calls).toHaveLength(2);
    expect(model.calls[1]?.messages).toHaveLength(3);
    expect(model.calls[1]?.messages[2]?.content).toContain("banned-phrase");
  });

  it("상한은 스펙 문면 그대로 2회다", () => {
    // 아래 호출 수 단언을 `MAX_REWRITES`로 쓰면 상수를 10으로 올려도 테스트가 따라 올라가
    // **자기충족적**이 된다. 상수 자체를 여기서 못박고, 호출 수는 리터럴로 센다.
    expect(MAX_REWRITES).toBe(2);
  });

  it("상한을 넘겨 부르지 않는다 — 최악 호출은 3회다", async () => {
    const { outcome, model } = await run([LINT_FAILING_DRAFT]);
    expect(model.calls).toHaveLength(3);
    expect(outcome.accepted).toBe(false);
    if (outcome.accepted) return;
    expect(outcome.reason).toBe("lint");
    expect(outcome.report.rewrites).toBe(2);
    expect(outcome).not.toHaveProperty("patch");
  });

  it("린트에서 끝나면 팩트 대조는 null이다 — 통과가 아니라 미실행이다", async () => {
    const { outcome } = await run([LINT_FAILING_DRAFT]);
    expect(outcome.report.factCheck).toBeNull();
  });

  it("재작성 지시문에는 레코드 산문이 들어가지 않는다 (NFR-03·중복 방지)", () => {
    const instruction = rewriteInstruction(lintDraft(LINT_FAILING_DRAFT));
    expect(instruction).toContain("[banned-phrase]");
    expect(instruction).not.toContain("pnpm 10부터 의존성의 postinstall");
  });
});

describe("draftArticle — 팩트 대조 반려", () => {
  it("팩트 팩에 없는 수치가 있으면 반려하고 패치를 만들지 않는다", async () => {
    const { outcome } = await run([DRAFT_WITH_INVENTED_NUMBER]);
    expect(outcome.accepted).toBe(false);
    if (outcome.accepted) return;
    expect(outcome.reason).toBe("fact-check");
    expect(outcome).not.toHaveProperty("patch");
    expect(outcome.report.lint?.passed).toBe(true);
    expect(outcome.report.factCheck?.violations).toEqual([{ kind: "number", value: "97" }]);
  });

  it("팩트 위반은 재작성 대상이 아니다 — §4의 순서상 루프 밖이다", async () => {
    const { model } = await run([DRAFT_WITH_INVENTED_NUMBER]);
    expect(model.calls).toHaveLength(1);
  });
});

describe("draftArticle — 재료가 없으면 모델을 부르지 않는다", () => {
  it("서사 재료 0건이면 호출이 아예 발생하지 않는다", async () => {
    const { outcome, model } = await run([ACCEPTED_DRAFT], { records: [] });
    expect(model.calls).toHaveLength(0);
    expect(outcome.accepted).toBe(false);
    if (outcome.accepted) return;
    expect(outcome.reason).toBe("no-narrative");
    expect(outcome.report.lint).toBeNull();
    expect(outcome.report.factCheck).toBeNull();
    expect(outcome.report.model).toBeNull();
  });
});

describe("draftArticle — 프롬프트에 무엇이 실리는가", () => {
  it("레코드 산문은 실린다 — 팩트 팩만으로는 인과를 쓸 수 없다는 판단의 결과다", async () => {
    const { model } = await run([ACCEPTED_DRAFT]);
    const prompt = model.calls[0]?.messages[0]?.content ?? "";
    expect(prompt).toContain("<records>");
    expect(prompt).toContain("pnpm 10부터 의존성의 postinstall");
  });

  it("유출 문자열과 일본어 인젝션은 프롬프트 어디에도 없다", async () => {
    const { model } = await run([ACCEPTED_DRAFT]);
    const prompt = model.calls[0]?.messages[0]?.content ?? "";
    for (const leaked of LEAKED_STRINGS) expect(prompt, leaked).not.toContain(leaked);
    for (const fragment of JAPANESE_INJECTION_FRAGMENTS) {
      expect(prompt, fragment).not.toContain(fragment);
    }
  });

  it("시스템 프롬프트에 데이터 프레이밍 조항이 실린다 (NFR-05)", async () => {
    const { model } = await run([ACCEPTED_DRAFT]);
    expect(model.calls[0]?.system).toContain("<!-- clause:data-not-instructions -->");
  });

  it("같은 입력이면 같은 요청이 나간다 (결정론)", async () => {
    const a = await run([ACCEPTED_DRAFT]);
    const b = await run([ACCEPTED_DRAFT]);
    expect(a.model.calls[0]?.messages[0]?.content).toBe(b.model.calls[0]?.messages[0]?.content);
  });
});

describe("draftArticle — 실패", () => {
  it("모델이 빈 응답을 주면 던진다", async () => {
    await expect(run(["   "])).rejects.toBeInstanceOf(LlmError);
  });
});
