import { ArticleKind } from "@sentinel/contracts";
import { describe, expect, it } from "vitest";

import { fixtureFacts } from "./publisher.fixture.js";
import {
  ARTICLE_TEMPLATES,
  TEMPLATES_PER_KIND,
  buildOutline,
  selectTemplate,
  templatesFor,
} from "./templates.js";

const facts = fixtureFacts();

describe("ARTICLE_TEMPLATES", () => {
  it("유형마다 골격이 정확히 3종이다 (§4 로테이션)", () => {
    for (const kind of ArticleKind.options) {
      expect(templatesFor(kind), kind).toHaveLength(TEMPLATES_PER_KIND);
    }
  });

  it("골격 id가 유일하다 — 겹치면 로테이션이 조용히 좁아진다", () => {
    const ids = ARTICLE_TEMPLATES.map((template) => template.id);
    expect(new Set(ids).size).toBe(ids.length);
  });

  it("모든 골격이 마디를 셋 이상 갖는다", () => {
    for (const template of ARTICLE_TEMPLATES) {
      expect(template.sections.length, template.id).toBeGreaterThanOrEqual(3);
    }
  });
});

describe("selectTemplate", () => {
  it("같은 소스 집합이면 언제나 같은 골격이다 (결정론)", () => {
    const first = selectTemplate("case", facts.sourceRecordIds);
    const again = selectTemplate("case", [...facts.sourceRecordIds].reverse());
    expect(again.id).toBe(first.id);
  });

  it("소스 집합이 다르면 골격이 갈린다 — 로테이션이 실제로 돈다", () => {
    const ids = new Set<string>();
    for (let index = 0; index < 30; index += 1) {
      ids.add(selectTemplate("case", [`record-${String(index)}`]).id);
    }
    expect(ids.size).toBe(TEMPLATES_PER_KIND);
  });

  it("고른 골격은 요청한 유형의 것이다", () => {
    for (const kind of ArticleKind.options) {
      expect(selectTemplate(kind, facts.sourceRecordIds).kind).toBe(kind);
    }
  });
});

describe("buildOutline", () => {
  it("마디 순서와 가용 팩트를 함께 싣는다", () => {
    const template = selectTemplate("pattern", facts.sourceRecordIds);
    const outline = buildOutline(template, facts);
    for (const section of template.sections) {
      expect(outline).toContain(section.heading);
    }
    expect(outline).toContain(`레코드 ${String(facts.counts.records)}건`);
  });

  it("같은 입력이면 같은 아웃라인이다 — 모델이 만들지 않으므로 흔들릴 곳이 없다", () => {
    const template = selectTemplate("digest", facts.sourceRecordIds);
    expect(buildOutline(template, facts)).toBe(buildOutline(template, facts));
  });
});
