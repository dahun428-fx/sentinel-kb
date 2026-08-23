/**
 * 코퍼스가 실물인지 본다.
 *
 * ## 대조군에 린터를 대 보는 것은 judge 독립성을 깨지 않는다
 *
 * 린터는 **judge 경로에 닿지 않는다**(`judge.ts` 서두). 여기서 린터를 부르는 것은
 * 판정이 아니라 **대조군이 정말로 상투적인 글인지에 대한 독립적 확인**이다 —
 * "내가 상투적이라고 선언했으니 상투적이다"보다 다른 계기가 동의하는 편이 낫다.
 *
 * 그리고 그 확인은 T-031 F-2("린터 통과는 품질의 증거가 아니다")를 **관측 가능한 항목**으로
 * 만든다: CTL-04는 린터를 통과하도록 쓴 대조군이다. 린터가 통과시키는 글 중에도 누가 봐도
 * AI가 쓴 글이 있다는 것이 F-2의 주장이고, 그 주장의 실물이 코퍼스 안에 있다.
 */
import { lintDraft, loadStyleSamples } from "@sentinel/core";
import { describe, expect, it } from "vitest";

import {
  ARTICLE_SOURCE_COUNT,
  CONTROL_PIECES,
  clip,
  controlPieces,
  detectStyleSampleOverlap,
  HUMAN_SOURCES,
  loadArticleSources,
  loadHumanCorpus,
  PIECE_MAX_CHARS,
  REQUIRED_HUMAN_PIECES,
  sourceObjectId,
} from "./corpus.js";
import { REPO_ROOT } from "./report-io.js";

describe("사람 글", () => {
  it("§6이 요구하는 편수는 3이다", () => {
    expect(REQUIRED_HUMAN_PIECES).toBe(3);
  });

  it("목록에 오른 글은 전부 실제로 읽힌다 — 없는 파일을 세지 않는다", async () => {
    const corpus = await loadHumanCorpus(REPO_ROOT);

    expect(corpus.missing).toEqual([]);
    expect(corpus.pieces).toHaveLength(HUMAN_SOURCES.length);
    for (const piece of corpus.pieces) {
      expect(piece.origin).toBe("human");
      expect(piece.text.trim().length).toBeGreaterThan(0);
    }
  });

  it("목록의 항목마다 '왜 사람 글인가'가 적혀 있다 — 근거 없이 올리지 않는다", () => {
    for (const source of HUMAN_SOURCES) {
      expect(source.provenance.length).toBeGreaterThan(20);
    }
  });

  it("없는 파일은 조용히 빠지지 않고 missing에 남는다", async () => {
    const corpus = await loadHumanCorpus(REPO_ROOT, [
      { path: "docs/이런-파일은-없다.md", provenance: "테스트용" },
    ]);

    expect(corpus.pieces).toEqual([]);
    expect(corpus.missing).toHaveLength(1);
  });

  it("모든 글을 같은 상한으로 자른다 — 길이 자체가 신호가 되면 안 된다", async () => {
    const corpus = await loadHumanCorpus(REPO_ROOT);

    for (const piece of corpus.pieces) {
      expect(piece.text.length).toBeLessThanOrEqual(PIECE_MAX_CHARS);
    }
    expect(clip("abcdef", 3)).toBe("abc");
    expect(clip("ab", 3)).toBe("ab");
  });
});

describe("오염 검사 — 사람 글이 초안의 문체 표본으로도 쓰였는가", () => {
  it("표본이 사람 글의 발췌면 잡는다 (머리말이 붙어 있어도)", async () => {
    const corpus = await loadHumanCorpus(REPO_ROOT);
    const samples = loadStyleSamples().samples.map((sample) => sample.text);

    const overlap = detectStyleSampleOverlap(corpus.pieces, samples);

    // 지금 레포 상태가 정확히 그렇다: prompts/style/01-t004-postmortem.md는
    // docs/analysis/T-004-POSTMORTEM.md의 발췌다. 잡히지 않으면 검사가 죽은 것이다.
    expect(overlap).toContain("docs/analysis/T-004-POSTMORTEM.md");
  });

  it("겹치지 않는 표본은 잡지 않는다", () => {
    const overlap = detectStyleSampleOverlap(
      [{ origin: "human", sourceRef: "docs/x.md", text: "완전히 다른 글이다. ".repeat(40) }],
      ["이 표본은 저 글과 한 문장도 겹치지 않는다. ".repeat(40)],
    );

    expect(overlap).toEqual([]);
  });

  it("표본이 없으면 겹칠 것도 없다", () => {
    expect(detectStyleSampleOverlap([{ origin: "human", sourceRef: "d", text: "본문" }], [])).toEqual(
      [],
    );
  });
});

describe("대조군", () => {
  it("네 편이 각각 다른 축을 노린다", () => {
    expect(CONTROL_PIECES).toHaveLength(4);
    expect(new Set(CONTROL_PIECES.map((piece) => piece.axis)).size).toBe(4);
    expect(new Set(CONTROL_PIECES.map((piece) => piece.id)).size).toBe(4);
  });

  it("origin이 control이고 재현 좌표가 붙는다", () => {
    for (const piece of controlPieces()) {
      expect(piece.origin).toBe("control");
      expect(piece.sourceRef).toContain("eval/style/corpus.ts:");
    }
  });

  it("CTL-01·02·03은 린터도 잡는다 — '상투적'이 내 선언만은 아니다", () => {
    for (const id of ["CTL-01", "CTL-02", "CTL-03"]) {
      const piece = CONTROL_PIECES.find((entry) => entry.id === id);
      if (piece === undefined) throw new Error(`${id}가 없다`);

      expect(lintDraft(piece.text).passed).toBe(false);
    }
  });

  it("CTL-04는 린터를 통과한다 — 린터 통과가 품질의 증거가 아니라는 T-031 F-2의 실물", () => {
    const piece = CONTROL_PIECES.find((entry) => entry.id === "CTL-04");
    if (piece === undefined) throw new Error("CTL-04가 없다");

    expect(lintDraft(piece.text).passed).toBe(true);
  });
});

describe("생성 소스 레코드", () => {
  it("시드를 실행 시점에 읽는다 — 사본을 박아 두지 않는다", async () => {
    const records = await loadArticleSources(REPO_ROOT);

    /*
     * **리터럴 4다.** `loadArticleSources`가 `ARTICLE_SOURCE_COUNT`만큼 읽으므로
     * 그 상수를 기대값으로 쓰면 4→9로 바꿔도 로더가 9개를 읽어 통과한다
     * (T-041 실측: 생존). 상수 자체는 아래에서 따로 고정한다.
     * 근거: specs/08 §1 B의 패턴 하한 3건 + 여유 1건.
     */
    expect(records).toHaveLength(4);
    for (const record of records) {
      expect(record.type).toBe("incident");
      expect(record.project).toBe("sentinel-kb");
      expect(record.summary.length).toBeGreaterThan(0);
      expect(record.sanitizeFlags).toEqual([]);
    }
  });

  it("ARTICLE_SOURCE_COUNT가 specs/08 §1 B의 하한 3 + 여유 1과 일치한다", () => {
    expect(ARTICLE_SOURCE_COUNT).toBe(4);
  });

  it("같은 시드면 같은 id와 같은 시각이 나온다 — 리포트 diff가 흔들리지 않는다", async () => {
    const a = await loadArticleSources(REPO_ROOT);
    const b = await loadArticleSources(REPO_ROOT);

    expect(a.map((record) => record._id)).toEqual(b.map((record) => record._id));
    expect(a.map((record) => record.createdAt.toISOString())).toEqual(
      b.map((record) => record.createdAt.toISOString()),
    );
  });

  it("id는 24자 hex다 (contracts ObjectIdString)", () => {
    expect(sourceObjectId(0)).toMatch(/^[0-9a-f]{24}$/u);
    expect(sourceObjectId(0)).not.toBe(sourceObjectId(1));
  });

  it("레코드마다 시각이 다르다 — 타임라인이 한 점으로 뭉치지 않는다", async () => {
    const records = await loadArticleSources(REPO_ROOT);

    const times = new Set(records.map((record) => record.createdAt.toISOString()));
    expect(times.size).toBe(records.length);
  });
});
