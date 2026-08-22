/**
 * 인용 후처리 검증 테스트. 출처: specs/03 §5, specs/05 Eval 2(a), T-020 Acceptance 1.
 *
 * ## 왜 시드 50건과 프롬프트 원문으로 분할기를 때리는가
 *
 * 문장 분할기는 **자기가 만든 예문에서는 언제나 옳다.** T-020 스펙이 "실제 레코드 본문과
 * T-018 프롬프트로 검증하라"고 못박은 이유가 그것이고, 실제로 시드에는 마침표 단순 분할을
 * 즉시 깨뜨리는 것들이 들어 있다 — `0.033`·`1/(k+rank)`(SELF-01), `proxy_read_timeout 3600s`·
 * `nginx -s reload.`(INC-06), 그리고 프롬프트가 지시하는 `1. **원인 가설**` 목록 마커.
 *
 * 판정 기준은 **손실 없음**이다: 조각을 순서대로 이어 붙이면 원문과 글자 하나까지 같아야 한다.
 * 이 불변식이 없으면 "인용 없는 문장 제거"가 제거가 아니라 재작성이 되고, 모델이 쓰지 않은
 * 문장이 답변에 남는다.
 */
import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";

import { answerPromptPath } from "./prompt.js";
import {
  NON_CLAIM_REASONS,
  splitAnswerSentences,
  stripUngroundedSentences,
  verifyAnswerCitations,
} from "./citation.js";

const SEED_DIR = fileURLToPath(new URL("../../seed/", import.meta.url));

/** 시드 레코드 본문 전부(중첩 객체 포함). 50건이 아니면 경로가 틀린 것이다. */
function seedTexts(): { file: string; text: string }[] {
  const out: { file: string; text: string }[] = [];
  for (const dir of readdirSync(SEED_DIR)) {
    const path = join(SEED_DIR, dir);
    for (const file of readdirSync(path).filter((name) => name.endsWith(".json"))) {
      const parsed: unknown = JSON.parse(readFileSync(join(path, file), "utf8"));
      collectStrings(parsed, (text) => out.push({ file: `${dir}/${file}`, text }));
    }
  }
  return out;
}

function collectStrings(value: unknown, sink: (text: string) => void): void {
  if (typeof value === "string") {
    if (value.length > 0) sink(value);
    return;
  }
  if (Array.isArray(value)) {
    for (const item of value) collectStrings(item, sink);
    return;
  }
  if (typeof value === "object" && value !== null) {
    for (const item of Object.values(value)) collectStrings(item, sink);
  }
}

function joined(text: string): string {
  return splitAnswerSentences(text)
    .map((sentence) => sentence.raw)
    .join("");
}

/** `token`이 한 조각 안에 온전히 들어 있는가. 쪼개지면 false. */
function intact(text: string, token: string): boolean {
  return splitAnswerSentences(text).some((sentence) => sentence.raw.includes(token));
}

describe("splitAnswerSentences — 손실 없음 (시드 50건 + T-018 프롬프트)", () => {
  const corpus = seedTexts();

  it("시드를 실제로 읽었다 — 빈 배열을 순회하면 아래 단언이 공허하게 통과한다", () => {
    const files = new Set(corpus.map((entry) => entry.file));
    expect(files.size).toBe(50);
    expect(corpus.length).toBeGreaterThan(200);
  });

  it("모든 시드 본문에서 조각을 이어 붙이면 원문이다", () => {
    for (const { file, text } of corpus) {
      expect(joined(text), `${file}에서 분할이 원문을 잃었다`).toBe(text);
    }
  });

  it("답변 시스템 프롬프트 원문에서도 손실이 없다", () => {
    const prompt = readFileSync(answerPromptPath(), "utf8");
    expect(prompt.length).toBeGreaterThan(500);
    expect(joined(prompt)).toBe(prompt);
  });

  /**
   * **마침표 단순 분할이었다면 여기서 전부 죽는다** — T-020이 지목한 뮤테이션이다.
   * 토큰은 전부 시드·스펙 본문에서 그대로 가져왔다.
   */
  it.each([
    ["소수", "RRF 점수는 최대 약 0.033이므로 비교할 수 없다 [REC-a#b]."],
    ["임계값", "임계값 0.62는 cosine 유사도를 전제로 산정했다 [REC-a#b]."],
    ["수식", "score = sum(1/(k+rank)) 척도다 [REC-a#b]."],
    ["버전", "라이브러리를 v1.2에서 v1.10으로 올렸다 [REC-a#b]."],
    ["스펙 경로", "근거는 specs/03 §5와 specs/05다 [REC-a#b]."],
    ["설정값", "proxy_read_timeout 3600s로 늘렸다 [REC-a#b]."],
    ["파일명", "nginx.conf의 location 블록을 나눴다 [REC-a#b]."],
    ["시간", "p95가 1.5초에서 0.9초로 줄었다 [REC-a#b]."],
    ["약어", "예를 들어 e.g. 커넥션 누수 같은 경우다 [REC-a#b]."],
  ])("%s는 한 문장으로 남는다", (_label, text) => {
    expect(splitAnswerSentences(text).filter((s) => s.claim)).toHaveLength(1);
  });

  it.each(["0.033", "1/(k+rank)", "v1.2", "specs/03", "3600s", "1.5초"])(
    "%s 토큰이 조각 경계로 쪼개지지 않는다",
    (token) => {
      const text = `앞 문장이다 [REC-a#b]. 값은 ${token}이었다 [REC-a#b]. 뒷 문장이다 [REC-a#b].`;
      expect(intact(text, token)).toBe(true);
    },
  );
});

describe("splitAnswerSentences — 구조 요소", () => {
  it("코드 펜스 안의 마침표는 문장을 끝내지 않는다", () => {
    const text = "절차는 아래와 같다 [REC-a#b].\n```bash\nnginx -t. nginx -s reload.\n```\n";
    const inFence = splitAnswerSentences(text).filter(
      (sentence) => sentence.nonClaimReason === NON_CLAIM_REASONS.CODE,
    );

    // 펜스 여는 줄·본문·닫는 줄 세 줄이 통째로 비주장이다.
    expect(inFence).toHaveLength(3);
    expect(inFence[1]?.raw).toContain("nginx -t. nginx -s reload.");
    expect(splitAnswerSentences(text).filter((s) => s.claim)).toHaveLength(1);
  });

  it("인라인 코드 안의 마침표도 문장을 끝내지 않는다", () => {
    const text = "`nginx -s reload.` 를 실행했다 [REC-a#b].";
    expect(splitAnswerSentences(text).filter((s) => s.claim)).toHaveLength(1);
  });

  it("목록 마커 `1.`은 문장 끝이 아니다 (프롬프트 출력 형식)", () => {
    const sentences = splitAnswerSentences("1. **원인 가설**\n2. **해결 절차**\n");
    expect(sentences.filter((s) => s.claim)).toHaveLength(0);
    expect(sentences[0]?.nonClaimReason).toBe(NON_CLAIM_REASONS.LABEL);
  });

  it("제목·구분선·표는 주장 문장이 아니다", () => {
    const text = "## 원인 가설\n---\n| 항목 | 값 |\n";
    expect(splitAnswerSentences(text).map((s) => s.nonClaimReason)).toEqual([
      NON_CLAIM_REASONS.HEADING,
      NON_CLAIM_REASONS.RULE,
      NON_CLAIM_REASONS.TABLE,
    ]);
  });

  /** 면제는 **짧은 라벨**에만 준다. 길이 상한이 없으면 문단을 강조로 감싸는 것이 우회로다. */
  it("강조로 감싼 긴 산문은 라벨이 아니라 주장 문장이다", () => {
    const text = "**커넥션 풀 상한을 20으로 올리고 애플리케이션을 재시작하면 해결된다고 한다**";
    expect(splitAnswerSentences(text)[0]?.claim).toBe(true);
  });

  /**
   * **결정 1의 귀결을 그대로 못박는다.** 인사말도 주장 문장이다 — 프롬프트 조항 2가
   * "인용을 붙일 수 없는 문장은 쓰지 않는다"이므로 인사말은 예외가 아니라 위반이다.
   */
  it("인사말도 주장 문장이다 (결정 1)", () => {
    expect(splitAnswerSentences("안녕하세요")[0]?.claim).toBe(true);
  });
});

describe("splitAnswerSentences — 마침표 뒤 인용", () => {
  /**
   * 프롬프트는 "문장 끝에 인용"이라고만 했다. 모델이 마침표 **뒤에** 붙이는 것이 실재하고,
   * 그때 인용을 다음 문장으로 넘기면 앞 문장은 무인용으로 오판되고 뒷 문장은 남의 근거로
   * 통과한다 — 한 번의 실수로 두 개의 거짓이 난다.
   */
  it("마침표 뒤의 인용은 앞 문장에 붙는다", () => {
    const sentences = splitAnswerSentences(
      "풀 상한을 올렸다. [REC-a#resolution] 재시작했다. [REC-b#prevention]",
    );
    const claims = sentences.filter((s) => s.claim);

    expect(claims).toHaveLength(2);
    expect(claims[0]?.citations).toEqual(["[REC-a#resolution]"]);
    expect(claims[1]?.citations).toEqual(["[REC-b#prevention]"]);
  });

  it("줄바꿈은 넘어가서 끌어오지 않는다", () => {
    const claims = splitAnswerSentences("풀 상한을 올렸다.\n[REC-a#resolution] 재시작했다.").filter(
      (s) => s.claim,
    );
    expect(claims[0]?.citations).toEqual([]);
  });
});

describe("verifyAnswerCitations", () => {
  const allowed = ["[REC-a#resolution]", "[REC-b#prevention]"];

  it("모든 주장 문장에 유효 인용이 있으면 통과다", () => {
    const result = verifyAnswerCitations(
      "## 해결 절차\n풀 상한을 올렸다 [REC-a#resolution].\n재시작했다 [REC-b#prevention].",
      allowed,
    );

    expect(result.ok).toBe(true);
    expect(result.claimCount).toBe(2);
    expect(result.citedClaimCount).toBe(2);
    expect(result.violations).toEqual([]);
  });

  /** **T-020 Acceptance 1.** 형식만 보는 검사는 지어낸 ObjectId를 통과시킨다. */
  it("존재하지 않는 ID를 인용한 모의 응답은 위반이다 (Acceptance 1)", () => {
    const invented = "[REC-68f0c4a1b2c3d4e5f6a7b8c9#resolution]";
    const result = verifyAnswerCitations(`풀 상한을 올렸다 ${invented}.`, allowed);

    expect(result.ok).toBe(false);
    expect(result.violations).toEqual([
      { kind: "unknown", index: 0, text: `풀 상한을 올렸다 ${invented}.`, citations: [invented] },
    ]);
    expect(result.unknownCitations).toEqual([invented]);
  });

  it("유효 인용과 지어낸 인용이 섞여 있어도 위반이다", () => {
    const result = verifyAnswerCitations(
      "풀 상한을 올렸다 [REC-a#resolution][REC-zzz#resolution].",
      allowed,
    );
    expect(result.ok).toBe(false);
    expect(result.unknownCitations).toEqual(["[REC-zzz#resolution]"]);
  });

  it("인용이 없는 주장 문장은 missing 위반이다", () => {
    const result = verifyAnswerCitations("풀 상한을 올렸다 [REC-a#resolution]. 재시작하면 된다.", allowed);

    expect(result.ok).toBe(false);
    expect(result.violations.map((violation) => violation.kind)).toEqual(["missing"]);
    expect(result.citedClaimCount).toBe(1);
  });

  /**
   * **M5b의 핵심 상태.** 인용 마커가 0개인 답변은 `citations` 배열이 아무리 그럴듯해도
   * 근거에 묶여 있지 않다. 여기서 `ok:false`가 나오지 않으면 그 구멍이 그대로다.
   */
  it("인용 마커가 0개인 답변은 통과하지 못한다 (T-019 M5b)", () => {
    const result = verifyAnswerCitations(
      "커넥션 풀 상한을 올리면 해결된다. 애플리케이션을 재시작하라.",
      allowed,
    );
    expect(result.ok).toBe(false);
    expect(result.violations).toHaveLength(2);
  });

  /** 주장이 0건인 텍스트(제목만, 인사만)는 "통과"가 아니다. */
  it("주장 문장이 하나도 없으면 통과가 아니다", () => {
    expect(verifyAnswerCitations("## 원인 가설\n\n---\n", allowed).ok).toBe(false);
  });
});

describe("stripUngroundedSentences", () => {
  const allowed = ["[REC-a#resolution]"];

  it("위반 문장만 제거하고 나머지는 원문 그대로 남긴다", () => {
    const answer = "풀 상한을 올렸다 [REC-a#resolution]. 재시작하면 된다. 로그를 확인했다 [REC-a#resolution].";
    const stripped = stripUngroundedSentences(answer, verifyAnswerCitations(answer, allowed));

    expect(stripped.removed).toBe(1);
    expect(stripped.grounded).toBe(true);
    expect(stripped.text).toBe(
      "풀 상한을 올렸다 [REC-a#resolution]. 로그를 확인했다 [REC-a#resolution].",
    );
  });

  it("남은 문장을 다시 검증하면 위반이 없다", () => {
    const answer = "A다 [REC-a#resolution]. B다. C다 [REC-zzz#x].";
    const stripped = stripUngroundedSentences(answer, verifyAnswerCitations(answer, allowed));

    expect(verifyAnswerCitations(stripped.text, allowed).ok).toBe(true);
  });

  /** 근거에 묶인 주장이 하나도 안 남으면 `found:true`로 낼 수 없다. */
  it("전부 제거되면 grounded:false다", () => {
    const answer = "재시작하면 된다. 풀 상한을 올려라.";
    const stripped = stripUngroundedSentences(answer, verifyAnswerCitations(answer, allowed));

    expect(stripped.text).toBe("");
    expect(stripped.grounded).toBe(false);
  });

  /** 제목·인사만 남는 경우가 빈 문자열보다 위험하다 — 인용 배열은 여전히 채워지기 때문이다. */
  it("제목만 남으면 grounded:false다", () => {
    const answer = "## 원인 가설\n커넥션 풀이 고갈됐다.\n";
    const stripped = stripUngroundedSentences(answer, verifyAnswerCitations(answer, allowed));

    expect(stripped.text).toBe("## 원인 가설");
    expect(stripped.grounded).toBe(false);
  });
});
