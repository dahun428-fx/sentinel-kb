/**
 * 카탈로그가 **실물 계약**을 읽는지 확인한다. 여기서 잠그는 것은 두 가지다:
 *   1. 도구 5종의 description과 인자를 실제로 읽어 온다 (스냅샷이 아니다)
 *   2. description이 한 글자만 바뀌어도 지문이 바뀐다 → G6가 기계적으로 성립한다
 *
 * `packages/mcp`는 **읽기만** 한다. 이 파일은 도구를 등록하지도, description을 고치지도 않는다.
 */
import { describe, expect, it } from "vitest";

import { fingerprint, findTool, loadToolCatalog, renderCatalog, toolNames } from "./catalog.js";

const catalog = loadToolCatalog();

describe("loadToolCatalog — 실물 도구 계약", () => {
  it("specs/07의 도구 5종을 읽는다", () => {
    expect(toolNames(catalog).sort()).toEqual(
      [
        "get_record",
        "give_feedback",
        "record_knowledge",
        "search_knowledge",
        "suggest_resolution",
      ].sort(),
    );
  });

  it("description이 비어 있는 도구가 없다 — 이 eval이 재는 대상이 description이다", () => {
    for (const tool of catalog.tools) {
      expect(tool.description.length, `${tool.name}에 description이 없다`).toBeGreaterThan(0);
    }
  });

  it("인자 이름과 필수 여부를 읽는다", () => {
    const search = findTool(catalog, "search_knowledge");
    expect(search?.args.map((arg) => arg.name)).toEqual(["query", "type", "project", "limit"]);
    expect(search?.args.find((arg) => arg.name === "query")?.required).toBe(true);
    expect(search?.args.find((arg) => arg.name === "limit")?.required).toBe(false);
  });

  /**
   * **T-015 F-2의 스펙 누락이 여기서 관측된다.** `specs/07:35`의 `give_feedback` 인자 목록은
   * `recordId`, `helped`, `note?` 셋뿐인데 구현(=HTTP 계약)은 `query`를 필수로 요구한다.
   * 시나리오 TS-10·TS-11이 `query`를 필수 인자로 채점하는 근거가 이 사실이다.
   */
  it("give_feedback의 query는 필수다 — specs/07:35 인자 목록에는 빠져 있다(T-015 F-2)", () => {
    const feedback = findTool(catalog, "give_feedback");
    expect(feedback?.args.find((arg) => arg.name === "query")?.required).toBe(true);
  });

  it("record_knowledge의 섹션 필드는 스키마상 optional이다 — type별로 갈리기 때문", () => {
    const record = findTool(catalog, "record_knowledge");
    expect(record?.args.find((arg) => arg.name === "type")?.required).toBe(true);
    expect(record?.args.find((arg) => arg.name === "symptom")?.required).toBe(false);
    expect(record?.args.find((arg) => arg.name === "expected")?.required).toBe(false);
  });
});

describe("fingerprint — G6의 기계적 근거", () => {
  it("같은 계약이면 같은 지문이다", () => {
    expect(loadToolCatalog().descriptionSha256).toBe(catalog.descriptionSha256);
  });

  it("description이 한 글자만 바뀌어도 지문이 바뀐다", () => {
    const mutated = catalog.tools.map((tool, index) =>
      index === 0 ? { ...tool, description: `${tool.description}.` } : tool,
    );
    expect(fingerprint(mutated)).not.toBe(catalog.descriptionSha256);
  });

  it("인자 description이 바뀌어도 지문이 바뀐다 — 거기만 고쳐 점수를 올릴 수 없다", () => {
    const mutated = catalog.tools.map((tool, index) =>
      index === 0
        ? {
            ...tool,
            args: tool.args.map((arg, argIndex) =>
              argIndex === 0 ? { ...arg, description: `${arg.description} (추가)` } : arg,
            ),
          }
        : tool,
    );
    expect(fingerprint(mutated)).not.toBe(catalog.descriptionSha256);
  });
});

describe("renderCatalog — selector에게 넘기는 도구 목록", () => {
  const rendered = renderCatalog(catalog);

  it("도구 이름과 description을 그대로 싣는다", () => {
    for (const tool of catalog.tools) {
      expect(rendered).toContain(tool.name);
      expect(rendered).toContain(tool.description);
    }
  });

  it("필수·선택 인자를 구분해 적는다", () => {
    expect(rendered).toContain("(필수)");
    expect(rendered).toContain("(선택)");
  });
});
