/**
 * **실 토크나이저 대조.** `estimateTokens`는 문자 클래스 근사라 상한 증명이 아니고,
 * 그래서 T-015 최초 구현에서는 이모지·비BMP·기호·base64·hex를 **과소평가**했다 —
 * `est.high=430`으로 통과한 응답이 cl100k_base 기준 2,627토큰(NFR-03 예산의 3.3배)이었다.
 * 그 성질은 코드 주석으로 막을 수 없다. 여기서 **실제로 세서** 잠근다.
 *
 * ## 프로덕션 의존성을 늘리지 않는다
 * `gpt-tokenizer`는 `packages/mcp`의 **devDependency**다. 프로덕션 코드(`format.ts`)는
 * 여전히 문자 클래스 근사만 쓴다 — MCP 서버가 요청마다 BPE 사전을 메모리에 올릴 이유가 없고,
 * 필요한 것은 "예산을 지키는가"의 판정이지 정확한 토큰 수가 아니다.
 *
 * ## 두 인코딩을 다 보는 이유
 * 어느 모델이 이 응답을 소비할지 MCP 서버는 모른다. cl100k_base(GPT-4·임베딩 계열)와
 * o200k_base(GPT-4o 계열)는 한국어·이모지 비용이 최대 3배까지 갈린다. **둘 중 비싼 쪽**을
 * 기준으로 예산을 지켜야 한다.
 */
import type { SearchHit } from "@sentinel/contracts";
import { encode as encodeCl100k } from "gpt-tokenizer/encoding/cl100k_base";
import { encode as encodeO200k } from "gpt-tokenizer/encoding/o200k_base";
import { describe, expect, it } from "vitest";

import { estimateTokens, MCP_SEARCH_TOKEN_BUDGET, renderSearchHits } from "./format.js";

/** 두 인코딩 중 **비싼 쪽**. 예산 판정은 언제나 이 값으로 한다. */
function actualTokens(text: string): number {
  return Math.max(encodeCl100k(text).length, encodeO200k(text).length);
}

const IDS = ["68f0c4a1b2c3d4e5f6a7b8c9", "68f0c4a1b2c3d4e5f6a7b8ca", "68f0c4a1b2c3d4e5f6a7b8cb"];

function hits(title: string, summary: string): SearchHit[] {
  return IDS.map((recordId) => ({
    recordId,
    title,
    summary,
    section: "resolution",
    score: 0.016_393_442_622_950_82,
    type: "incident",
    project: "sentinel-kb",
    flags: [],
  }));
}

/**
 * 흔한 이모지 18종. 단일 코드포인트, 변이 선택자(U+FE0F) 결합, 지역 표시자 쌍,
 * ZWJ 시퀀스(가족·깃발·성별)를 모두 섞었다 — 코드포인트당 실비용이 1.0에서 3.0까지 갈린다.
 */
const EMOJI = [
  "🔥", "🚀", "😀", "🎉", "💡", "⚠️", "✅", "❌", "🐛",
  "📦", "🧠", "🛠️", "🇰🇷", "👨‍👩‍👧‍👦", "🏳️‍🌈", "🤦🏽‍♀️", "🫠", "🥲",
];

describe("NFR-03 — 실 토크나이저로 센 응답이 예산을 넘지 않는다", () => {
  /**
   * **검증자가 실증한 회귀다.** "제목에 이모지"는 병리적 입력이 아니라 흔한 관행이고,
   * 레코드 작성자는 **다른 project의 사람**일 수 있다(크로스 project 조회는 이 제품의 정의다).
   * 즉 남의 프로젝트 사람이 이 프로젝트 에이전트의 컨텍스트를 부풀릴 수 있었다.
   * 이전 추정기에서는 18종 전부가 800을 넘었다(3.2–6.1배).
   */
  it.each(EMOJI)("이모지 도배 제목·요약 × limit 최대: %s", (emoji) => {
    const text = renderSearchHits(hits(emoji.repeat(500), emoji.repeat(2000)));
    expect(
      actualTokens(text),
      `${emoji} 도배가 예산을 넘겼다 (추정 ${String(estimateTokens(text).high)})`,
    ).toBeLessThanOrEqual(MCP_SEARCH_TOKEN_BUDGET);
    // recordId는 살아남아야 한다 — 예산을 지키느라 결과를 통째로 버리면 안 된다.
    for (const id of IDS) expect(text).toContain(id);
  });

  /**
   * 문자 클래스별 적대적 코퍼스. 각 줄이 추정기의 한 클래스를 정면으로 겨눈다.
   * 이전 가중치에서 실측/추정 비가 1.0을 넘던(=과소평가) 조성들이 들어 있다:
   * 이모지 0.39배, base64 0.66배, hex 덤프 0.62배, 공백 분산 ASCII 0.84배.
   */
  const CORPUS: [string, string, string][] = [
    ["난수 한글 음절", randomHangul(400), randomHangul(2000)],
    ["반복 한글", "가".repeat(400), "가".repeat(2000)],
    ["한글 자모", "ㄱㄴㄷㄹㅁㅂㅅㅇ".repeat(50), "ㄱㄴㄷㄹㅁㅂㅅㅇ".repeat(250)],
    ["한자", "漢字混在文書処理".repeat(50), "漢字混在文書処理".repeat(250)],
    ["base64풍", "aGVsbG8gd29ybGQgdGhpcyBpcyBiYXNlNjQ=".repeat(20), "aGVsbG8gd29ybGQgdGhpcyBpcyBiYXNlNjQ=".repeat(60)],
    ["hex 덤프", "de ad be ef 01 23 45 67 ".repeat(30), "de ad be ef 01 23 45 67 ".repeat(90)],
    ["공백 분산 ASCII", "a b c d e f g h i j ".repeat(40), "a b c d e f g h i j ".repeat(120)],
    ["난수 ASCII", randomAscii(800), randomAscii(2400)],
    ["기호·박스·수학", "─│┌┐└┘├┤┬┴┼∀∂∃∅∇∈".repeat(50), "─│┌┐└┘├┤┬┴┼∀∂∃∅∇∈".repeat(150)],
    ["비BMP 사용자 정의", "\u{F0000}\u{F0001}".repeat(200), "\u{F0000}\u{F0001}".repeat(600)],
    ["비BMP CJK 확장", "𠀋𠮟𡈽𡌛𡑮".repeat(80), "𠀋𠮟𡈽𡌛𡑮".repeat(240)],
    ["라틴1 악센트", "éàçüñö".repeat(70), "éàçüñö".repeat(200)],
    ["데바나가리", "नमस्ते दुनिया".repeat(40), "नमस्ते दुनिया".repeat(120)],
    ["키릴", "Привет мир это тест".repeat(30), "Привет мир это тест".repeat(90)],
    ["순수 ASCII 산문", "the quick brown fox jumps over the lazy dog ".repeat(20), "the quick brown fox jumps over the lazy dog ".repeat(60)],
  ];

  it.each(CORPUS)("적대적 조성 %s도 예산 안에 든다", (_label, title, summary) => {
    const text = renderSearchHits(hits(title, summary));
    expect(actualTokens(text)).toBeLessThanOrEqual(MCP_SEARCH_TOKEN_BUDGET);
  });

  /**
   * 머리줄은 산문 예산과 무관하게 항상 나가므로 `project` 하나가 병리적으로 길면
   * 머리줄만으로 예산을 넘길 수 있다(`RecordSummary.project`에는 길이 상한이 없다).
   * 그때 예산을 지키는 것은 마지막 하드 클램프뿐이고, 그 성질도 **실측으로** 확인한다.
   */
  it("병리적으로 긴 project 이름도 실측 예산을 넘기지 못한다", () => {
    const text = renderSearchHits(
      IDS.map((recordId) => ({
        recordId,
        title: "제목",
        summary: "요약",
        section: "resolution" as const,
        score: 0.01,
        type: "incident" as const,
        project: "프".repeat(3000),
        flags: [],
      })),
    );
    expect(actualTokens(text)).toBeLessThanOrEqual(MCP_SEARCH_TOKEN_BUDGET);
  });
});

describe("estimateTokens — 실 토크나이저 대비 편차", () => {
  const SAMPLES: [string, string][] = [
    ["한국어 산문", "프록시 앞단에서 proxy_buffering이 켜져 있어 하트비트 이벤트가 모였다가 나갔다. off로 바꾸고 read timeout을 늘려 해결했다. ".repeat(8)],
    ["난수 한글", randomHangul(500)],
    ["한글 자모", "ㄱㄴㄷㄹㅁㅂㅅㅇㅈㅊ".repeat(50)],
    ["한자", "漢字混在文書処理系統設計".repeat(40)],
    ["가나", "これはテストです。バッファリング".repeat(30)],
    ["ASCII 산문", "the quick brown fox jumps over the lazy dog ".repeat(15)],
    ["ASCII 식별자", "proxy_buffering proxy_read_timeout nginx_conf ".repeat(15)],
    ["공백 분산 ASCII", "a b c d e f g h i j k l m n o p ".repeat(25)],
    ["base64풍", "aGVsbG8gd29ybGQgdGhpcyBpcyBiYXNlNjQ=".repeat(15)],
    ["hex 덤프", "de ad be ef 01 23 45 67 89 ab cd ef ".repeat(20)],
    ["난수 ASCII", randomAscii(500)],
    ["이모지 혼합", EMOJI.join("").repeat(6)],
    ["기호", "─│┌┐└┘├┤∀∂∃∅∇∈".repeat(40)],
    ["비BMP 사용자 정의", "\u{F0000}\u{F0001}\u{F0002}".repeat(100)],
    ["라틴1", "éàçüñö".repeat(80)],
    ["키릴", "Привет мир это тест".repeat(26)],
    ["데바나가리", "नमस्ते दुनिया यह एक परीक्षण है".repeat(17)],
    ["타이", "สวัสดีชาวโลกนี่คือการทดสอบ".repeat(19)],
  ];

  /**
   * **과소평가가 없다.** 이게 이 파일의 존재 이유다 — 이전 추정기는 13케이스 중 4개에서
   * 실측이 `high`를 넘었고(이모지가 최악으로 2.6배), 그 상태로 "오차는 언제나 더 엄격한
   * 쪽으로 쏠린다"고 주석에 적혀 있었다. 이 단언이 죽으면 그 주장이 다시 거짓이 된 것이다.
   */
  it.each(SAMPLES)("%s: 실측 <= 추정 상한", (label, text) => {
    const { high } = estimateTokens(text);
    expect(actualTokens(text), `${label}: 실측이 추정 상한을 넘었다 = 과소평가`).toBeLessThanOrEqual(
      high,
    );
  });

  it.each(SAMPLES)("%s: 추정 하한 <= 실측", (label, text) => {
    const { low } = estimateTokens(text);
    expect(low, `${label}: 하한이 실측을 넘었다`).toBeLessThanOrEqual(actualTokens(text));
  });

  /**
   * 과대평가에도 상한을 둔다. 안전하기만 하면 되는 게 아니다 — `high`가 실측의 몇 배가 되면
   * 렌더러가 예산의 대부분을 안 쓰고 산문을 잘라내서, 목록이 "요약+ID"가 아니라 "ID+조각"이 된다.
   * 이 배수가 튀면 가중치를 다시 재라는 신호다.
   */
  it.each(SAMPLES)("%s: 과대평가가 6배를 넘지 않는다", (label, text) => {
    const { high } = estimateTokens(text);
    expect(high / Math.max(1, actualTokens(text)), label).toBeLessThan(6);
  });

  /**
   * 철회된 보정점을 **반대 방향으로** 잠근다. 예전 테스트는 이 페이로드가 953–1,226토큰이라고
   * 단언했는데 실제로는 479다. 이제 그 숫자가 다시 기어 들어오지 못하게 실측 쪽을 박아 둔다.
   */
  it("철회된 T-012 보정점(한글 275 + ASCII 1,626)의 실제 토큰 수는 479다", () => {
    const payload = "가".repeat(275) + "a".repeat(1626);
    expect(encodeCl100k(payload).length).toBe(479);
    expect(encodeO200k(payload).length).toBe(479);
    expect(estimateTokens(payload).high).toBeGreaterThanOrEqual(479);
  });
});

/** 결정적 난수(테스트가 실행마다 다른 것을 재면 회귀 판정이 안 된다). */
function lcg(seed: number): () => number {
  let state = seed;
  return () => {
    state = (state * 1_103_515_245 + 12_345) % 2_147_483_648;
    return state / 2_147_483_648;
  };
}

function randomHangul(count: number): string {
  const next = lcg(20_260_821);
  return Array.from({ length: count }, () =>
    String.fromCodePoint(0xac00 + Math.floor(next() * 11_172)),
  ).join("");
}

function randomAscii(count: number): string {
  const next = lcg(915_733);
  return Array.from({ length: count }, () =>
    String.fromCharCode(33 + Math.floor(next() * 94)),
  ).join("");
}
