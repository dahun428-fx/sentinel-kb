/**
 * T-005 Acceptance: 유닛 7케이스 + "분할 시 문장이 중간에서 잘리지 않음" 검증.
 *
 * 기대값은 구현 상수(`DEFAULT_CHUNK_MAX_CHARS`, prefix 빌더)를 참조하지 않고
 * **리터럴로 박는다** — 테스트가 구현을 미러링하면 상한을 1200→1199로 바꿔도
 * 초록불이 유지되어 아무것도 검증하지 못한다. (T-004 교훈)
 */
import type { DivergenceRecord, IncidentRecord } from "@sentinel/contracts";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import type { ChunkOptions, SectionChunk } from "./chunk-record.js";
import { ChunkBudgetError, chunkRecord } from "./chunk-record.js";
import { readChunkMaxChars } from "./config.js";

/** specs/03 §1-2가 정한 상한. 구현에서 끌어오지 않는다. */
const MAX_CHARS = 1200;

const BASE = {
  _id: "0123456789abcdef01234567",
  project: "sentinel-kb",
  summary: "요약",
  severity: "SEV2",
  tags: ["nginx"],
  sanitizeFlags: [],
  relations: [],
  status: "published",
  embeddingVersion: 1,
  createdAt: new Date("2026-01-01T00:00:00.000Z"),
  updatedAt: new Date("2026-01-01T00:00:00.000Z"),
} as const satisfies Omit<
  IncidentRecord,
  "type" | "title" | "symptom" | "rootCause" | "resolution" | "prevention"
>;

interface IncidentFields {
  title?: string;
  symptom?: string;
  rootCause?: string;
  resolution?: string;
  prevention?: string;
}

function incident(fields: IncidentFields = {}): IncidentRecord {
  return {
    ...BASE,
    type: "incident",
    title: fields.title ?? "기본 인시던트 제목",
    symptom: fields.symptom ?? "증상 본문.",
    rootCause: fields.rootCause,
    resolution: fields.resolution ?? "해결 본문.",
    prevention: fields.prevention,
  };
}

function divergence(fields: {
  title?: string;
  expected?: string;
  actual?: string;
  correction?: string;
  context?: DivergenceRecord["context"];
}): DivergenceRecord {
  return {
    ...BASE,
    type: "divergence",
    title: fields.title ?? "기본 이격 제목",
    expected: fields.expected ?? "기대 본문.",
    actual: fields.actual ?? "실제 본문.",
    context: fields.context ?? {},
    correction: fields.correction ?? "교정 본문.",
  };
}

/** 공백을 지운 뒤 비교하면 "조각 경계에서 공백만 사라졌는지"를 엄밀히 볼 수 있다. */
function squash(text: string): string {
  return text.replace(/\s+/g, "");
}

/** 분할 동작만 보는 테스트용 — 다른 섹션(resolution 등)의 청크를 걸러낸다. */
function symptomChunks(record: IncidentRecord, options?: ChunkOptions): SectionChunk[] {
  return chunkRecord(record, options).filter((chunk) => chunk.section === "symptom");
}

beforeEach(() => {
  // 실행 환경의 CHUNK_MAX_CHARS가 새어 들어오면 경계 케이스가 무의미해진다.
  vi.stubEnv("CHUNK_MAX_CHARS", "");
});

afterEach(() => {
  vi.unstubAllEnvs();
});

describe("chunkRecord — 섹션 매핑", () => {
  it("케이스 1: 전 섹션이 있는 incident는 4개 청크를 순서대로 낸다", () => {
    const chunks = chunkRecord(
      incident({
        title: "전 섹션 인시던트",
        symptom: "배포 후 5분간 502가 지속됐다.",
        rootCause: "keepalive 설정이 어긋났다.",
        resolution: "proxy_read_timeout을 120s로 올렸다.",
        prevention: "배포 전 부하 테스트를 추가했다.",
      }),
    );

    expect(chunks).toEqual([
      {
        section: "symptom",
        seq: 0,
        text: "[전 섹션 인시던트] (symptom) 배포 후 5분간 502가 지속됐다.",
      },
      {
        section: "rootCause",
        seq: 0,
        text: "[전 섹션 인시던트] (rootCause) keepalive 설정이 어긋났다.",
      },
      {
        section: "resolution",
        seq: 0,
        text: "[전 섹션 인시던트] (resolution) proxy_read_timeout을 120s로 올렸다.",
      },
      {
        section: "prevention",
        seq: 0,
        text: "[전 섹션 인시던트] (prevention) 배포 전 부하 테스트를 추가했다.",
      },
    ]);
  });

  it("케이스 2: rootCause·prevention이 없으면 에러 없이 스킵한다", () => {
    const chunks = chunkRecord(
      incident({
        title: "일부 섹션 누락 인시던트",
        symptom: "큐가 밀렸다.",
        resolution: "워커를 늘렸다.",
      }),
    );

    expect(chunks.map((chunk) => chunk.section)).toEqual(["symptom", "resolution"]);
  });

  it("케이스 5: 모든 섹션이 공백뿐이면 빈 배열이다 (에러 아님)", () => {
    const chunks = chunkRecord(
      incident({
        title: "빈 레코드",
        symptom: "   ",
        rootCause: "",
        resolution: "\n\n \t ",
        prevention: "\n",
      }),
    );

    expect(chunks).toEqual([]);
  });

  it("케이스 6: divergence는 expected·actual·correction만 청킹하고 context는 제외한다", () => {
    const chunks = chunkRecord(
      divergence({
        title: "이격 레코드",
        expected: "테스트가 src에 코로케이트되기를 기대했다.",
        actual: "tests 디렉터리에 생성돼 수집되지 않았다.",
        correction: "vitest include 경로에 맞춰 옮겼다.",
        context: { model: "claude-opus-4", tool: "vitest", framework: "node" },
      }),
    );

    expect(chunks.map((chunk) => chunk.section)).toEqual(["expected", "actual", "correction"]);
    expect(chunks.map((chunk) => chunk.text)).toEqual([
      "[이격 레코드] (expected) 테스트가 src에 코로케이트되기를 기대했다.",
      "[이격 레코드] (actual) tests 디렉터리에 생성돼 수집되지 않았다.",
      "[이격 레코드] (correction) vitest include 경로에 맞춰 옮겼다.",
    ]);
    // context는 ChunkSection이 아니다 — 값이 어떤 청크에도 새어 들어가면 안 된다.
    expect(chunks.some((chunk) => chunk.text.includes("claude-opus-4"))).toBe(false);
  });
});

describe("chunkRecord — 1200자 경계", () => {
  const TITLE = "청크 경계 검증 레코드";
  /** 구현의 prefix 빌더를 부르지 않고 형식을 리터럴로 고정한다. */
  const PREFIX = "[청크 경계 검증 레코드] (symptom) ";

  it("케이스 4: prefix 포함 정확히 1200자면 분할하지 않는다", () => {
    const body = "가".repeat(MAX_CHARS - PREFIX.length);
    const chunks = symptomChunks(incident({ title: TITLE, symptom: body }));

    expect(chunks).toHaveLength(1);
    expect(chunks.map((chunk) => chunk.text)).toEqual([PREFIX + body]);
    expect(chunks.map((chunk) => chunk.text.length)).toEqual([MAX_CHARS]);
  });

  it("케이스 4: prefix 포함 1201자면 분할한다 (off-by-one)", () => {
    const body = "가".repeat(MAX_CHARS - PREFIX.length + 1);
    const chunks = symptomChunks(incident({ title: TITLE, symptom: body }));

    expect(chunks).toHaveLength(2);
    expect(chunks[0]?.text.length).toBe(MAX_CHARS);
    expect(squash(chunks.map((chunk) => chunk.text.slice(PREFIX.length)).join(""))).toBe(body);
  });

  it("prefix 길이를 예산에서 빼므로 완성된 청크가 상한을 넘지 않는다", () => {
    // 제목이 길수록 본문 예산이 줄어야 한다. prefix를 예산에서 빼지 않으면 여기서 1200을 넘는다.
    const longTitle = "가".repeat(200);
    const chunks = symptomChunks(incident({ title: longTitle, symptom: "나".repeat(MAX_CHARS) }));

    for (const chunk of chunks) {
      expect(chunk.text.startsWith(`[${longTitle}] (symptom) `)).toBe(true);
      expect(chunk.text.length).toBeLessThanOrEqual(MAX_CHARS);
    }
  });
});

describe("chunkRecord — 분할", () => {
  const TITLE = "초장문 분할 레코드";
  const PREFIX_SYMPTOM = "[초장문 분할 레코드] (symptom) ";
  const SENTENCE = "게이트웨이가 업스트림 응답을 기다리다 타임아웃으로 연결을 끊었다.";
  const PARAGRAPH = Array.from({ length: 12 }, () => SENTENCE).join(" ");
  const LONG_BODY = Array.from({ length: 4 }, () => PARAGRAPH).join("\n\n");

  it("케이스 3: 1200자를 넘기면 여러 청크로 나뉘고 seq가 0부터 연속한다", () => {
    expect(LONG_BODY.length).toBeGreaterThan(MAX_CHARS);

    const chunks = symptomChunks(incident({ title: TITLE, symptom: LONG_BODY }));

    expect(chunks.length).toBeGreaterThan(1);
    expect(chunks.map((chunk) => chunk.seq)).toEqual(chunks.map((_, index) => index));
    expect(chunks.every((chunk) => chunk.section === "symptom")).toBe(true);
  });

  it("분할된 조각마다 prefix가 붙고 prefix 포함 길이가 상한 이하다", () => {
    const chunks = symptomChunks(incident({ title: TITLE, symptom: LONG_BODY }));

    for (const chunk of chunks) {
      expect(chunk.text.startsWith(PREFIX_SYMPTOM)).toBe(true);
      expect(chunk.text.length).toBeLessThanOrEqual(MAX_CHARS);
      expect(chunk.text.length).toBeGreaterThan(PREFIX_SYMPTOM.length);
    }
  });

  /**
   * **문단 경계가 없는 본문**을 쓴다. 이게 핵심이다 — 문단이 있으면 탐욕 패킹이
   * 문단 경계만으로 예산을 맞춰버려 **문장 분할 코드가 한 번도 실행되지 않는다.**
   * 실제로 이전 픽스처(문단 4개)에서는 문장 경계 규칙을 통째로 제거해도 전 테스트가 통과했다.
   *
   * 단언도 "종결부호로 끝난다"에서 **"각 조각이 원문 문장 목록의 연속 부분수열"**로 바꿨다.
   * 전자는 픽스처의 모든 문장이 `다.`로 끝나면 아무 데서나 잘라도 통과하는 자기충족적 단언이다.
   */
  it("문장이 중간에서 잘리지 않는다 — 각 조각은 원문 문장들의 연속 부분수열이다", () => {
    const sentences = [
      "게이트웨이가 업스트림 응답을 기다리다 타임아웃으로 연결을 끊었다.",
      "nginx 로그에는 upstream timed out 이 반복해서 찍혀 있었다.",
      "커넥션 풀이 고갈되어 새 요청이 큐에서 대기하다 만료되는 상황이었다.",
      "The upstream pool was exhausted and every new request queued until it expired.",
      "풀 크기를 두 배로 올리고 keepalive 를 켜자 지표가 정상으로 돌아왔다.",
    ];
    // 문단 구분 없이 한 줄로 이어 붙인다 — 문장 경계만이 유일한 분할 지점이다.
    const body = Array.from({ length: 8 }, () => sentences.join(" ")).join(" ");
    expect(body).not.toContain("\n");
    expect(body.length).toBeGreaterThan(MAX_CHARS);

    const chunks = symptomChunks(incident({ title: TITLE, symptom: body }));
    expect(chunks.length).toBeGreaterThan(1);

    // 원문을 문장 단위로 쪼개 순서대로 소비한다. 조각이 문장 중간에서 끝나면 매칭이 깨진다.
    const flat = Array.from({ length: 8 }, () => sentences).flat();
    let cursor = 0;
    for (const chunk of chunks) {
      const piece = chunk.text.slice(PREFIX_SYMPTOM.length);
      const consumed: string[] = [];
      while (cursor < flat.length && consumed.join(" ").length < piece.length) {
        consumed.push(flat[cursor] ?? "");
        cursor += 1;
      }
      expect(consumed.join(" ")).toBe(piece);
    }
    expect(cursor).toBe(flat.length);
  });

  it("문단 경계가 있으면 문단 단위로 자른다", () => {
    const chunks = symptomChunks(incident({ title: TITLE, symptom: LONG_BODY }));
    // 조각이 문단들의 연속 부분수열인지 본다. 종결부호 단언만으로는 문단 경계 규칙이
    // 줄 경계로 바뀌어도(`\n\n` → `\n`) 통과해 버린다.
    const paragraphs = LONG_BODY.split("\n\n");
    let cursor = 0;
    for (const chunk of chunks) {
      const piece = chunk.text.slice(PREFIX_SYMPTOM.length);
      // 조각 안에서는 원문 구분자(`\n\n`)가 그대로 보존된다 — 경계에서만 공백이 정리된다.
      const consumed: string[] = [];
      while (cursor < paragraphs.length && consumed.join("\n\n").length < piece.length) {
        consumed.push(paragraphs[cursor] ?? "");
        cursor += 1;
      }
      expect(consumed.join("\n\n")).toBe(piece);
    }
    expect(cursor).toBe(paragraphs.length);
  });

  /**
   * T-005 회귀. `hardCut`이 UTF-16 **코드 유닛**으로 자르면 비-BMP 문자(이모지)가
   * 반으로 갈린다. 고아 서로게이트는 UTF-8 인코딩 순간 U+FFFD로 치환되어 **되돌릴 수 없다** —
   * 청크는 임베딩 API와 MongoDB(BSON=UTF-8)로 나가므로 손상이 그대로 굳는다.
   * 한 줄 JSON 로그에 이모지가 섞이는 건 트러블슈팅 KB의 주 용례라 기본 설정에서 재현된다.
   */
  it("경계 없는 초장문을 강제 절단해도 서로게이트 쌍을 쪼개지 않는다", () => {
    const body = `{"lvl":"error","payload":"${"🔥".repeat(1200)}"}`;
    expect(body).not.toContain("\n");

    const chunks = symptomChunks(incident({ title: TITLE, symptom: body }));
    expect(chunks.length).toBeGreaterThan(1);

    for (const chunk of chunks) {
      expect(countLoneSurrogates(chunk.text)).toBe(0);
      // UTF-8 왕복에서 손실이 없어야 저장·전송을 견딘다.
      expect(Buffer.from(chunk.text, "utf8").toString("utf8")).toBe(chunk.text);
    }
  });

  it("절단 위치가 어긋나도(오프셋 이동) 서로게이트가 깨지지 않는다", () => {
    for (let pad = 0; pad < 4; pad += 1) {
      const body = `${"x".repeat(pad)}{"payload":"${"🚀".repeat(1200)}"}`;
      const chunks = symptomChunks(incident({ title: TITLE, symptom: body }));

      const broken = chunks.reduce((sum, c) => sum + countLoneSurrogates(c.text), 0);
      expect(broken, `pad=${String(pad)}에서 서로게이트가 깨졌다`).toBe(0);
    }
  });

  it("분할해도 본문이 유실되지 않는다", () => {
    const chunks = symptomChunks(incident({ title: TITLE, symptom: LONG_BODY }));
    const rejoined = chunks.map((chunk) => chunk.text.slice(PREFIX_SYMPTOM.length)).join("");

    expect(squash(rejoined)).toBe(squash(LONG_BODY));
  });

  it("스택트레이스는 문장이 아니므로 줄 단위로 나뉜다 — 줄 중간이 잘리지 않는다", () => {
    const lines = Array.from(
      { length: 40 },
      (_, index) => `    at Object.<anonymous> (/app/packages/core/src/db/client.ts:${index}:34)`,
    );
    const trace = lines.join("\n");
    expect(trace.length).toBeGreaterThan(MAX_CHARS);

    const prefix = "[스택트레이스 레코드] (symptom) ";
    const chunks = symptomChunks(incident({ title: "스택트레이스 레코드", symptom: trace }));

    expect(chunks.length).toBeGreaterThan(1);
    // 조각 첫 줄의 들여쓰기만 trim으로 사라지므로 양쪽을 trim해 비교한다.
    // 줄 중간이 잘렸다면 그 조각(예: "(/app/...ts:12:34)")은 원본 줄 목록에 없다.
    const expectedLines = lines.map((line) => line.trim());
    for (const chunk of chunks) {
      expect(chunk.text.length).toBeLessThanOrEqual(MAX_CHARS);
      for (const line of chunk.text.slice(prefix.length).split("\n")) {
        expect(expectedLines).toContain(line.trim());
      }
    }
  });

  it("경계가 전혀 없는 초장문만 강제로 절단한다", () => {
    // 줄바꿈도 종결부호도 없는 한 줄 로그. 이 경우에 한해 문장 중간 절단이 불가피하다.
    const body = "A".repeat(3000);
    const prefix = "[무경계 로그 레코드] (symptom) ";
    const chunks = symptomChunks(incident({ title: "무경계 로그 레코드", symptom: body }));

    expect(chunks.length).toBeGreaterThan(1);
    for (const chunk of chunks) {
      expect(chunk.text.length).toBeLessThanOrEqual(MAX_CHARS);
    }
    expect(chunks.map((chunk) => chunk.text.slice(prefix.length)).join("")).toBe(body);
  });

  it("seq는 섹션마다 독립적으로 0부터 다시 센다", () => {
    const chunks = chunkRecord(
      incident({ title: TITLE, symptom: LONG_BODY, resolution: LONG_BODY }),
    );

    const symptomSeqs = chunks.filter((c) => c.section === "symptom").map((c) => c.seq);
    const resolutionSeqs = chunks.filter((c) => c.section === "resolution").map((c) => c.seq);

    expect(symptomSeqs.length).toBeGreaterThan(1);
    expect(symptomSeqs).toEqual(symptomSeqs.map((_, index) => index));
    expect(resolutionSeqs).toEqual(resolutionSeqs.map((_, index) => index));
    expect(resolutionSeqs[0]).toBe(0);
  });

  it("케이스 7: 같은 입력을 두 번 호출하면 완전히 동일한 출력이다", () => {
    const record = incident({
      title: TITLE,
      symptom: LONG_BODY,
      rootCause: "원인 문단.",
      resolution: LONG_BODY,
      prevention: "예방 문단.",
    });

    expect(chunkRecord(record)).toEqual(chunkRecord(record));
    expect(JSON.stringify(chunkRecord(record))).toBe(JSON.stringify(chunkRecord(record)));
  });
});

describe("CHUNK_MAX_CHARS", () => {
  it("env가 상한을 주입한다 (specs/03 §6 — 하드코딩 금지)", () => {
    vi.stubEnv("CHUNK_MAX_CHARS", "300");

    const chunks = symptomChunks(
      incident({ title: "env 주입 레코드", symptom: "짧은 문장이다. ".repeat(60) }),
    );

    expect(chunks.length).toBeGreaterThan(1);
    for (const chunk of chunks) {
      expect(chunk.text.length).toBeLessThanOrEqual(300);
    }
  });

  it("options.maxChars가 env보다 우선한다", () => {
    vi.stubEnv("CHUNK_MAX_CHARS", "300");

    const chunks = symptomChunks(
      incident({ title: "옵션 우선 레코드", symptom: "짧은 문장이다. ".repeat(60) }),
      { maxChars: MAX_CHARS },
    );

    expect(chunks).toHaveLength(1);
  });

  it("미설정·비정상 값은 1200으로 떨어진다", () => {
    expect(readChunkMaxChars({})).toBe(MAX_CHARS);
    expect(readChunkMaxChars({ CHUNK_MAX_CHARS: "" })).toBe(MAX_CHARS);
    expect(readChunkMaxChars({ CHUNK_MAX_CHARS: "0" })).toBe(MAX_CHARS);
    expect(readChunkMaxChars({ CHUNK_MAX_CHARS: "abc" })).toBe(MAX_CHARS);
    expect(readChunkMaxChars({ CHUNK_MAX_CHARS: "800" })).toBe(800);
  });
});

/**
 * T-005 F-5 회귀. `Math.max(1, maxChars - prefix.length)` 가드가 예산을 1로 뭉개면
 * **모든 청크가 상한을 위반한 채 수천 개**가 나오고 임베딩 호출이 폭발한다.
 * specs/03 §6이 eval 스윕을 위해 env화를 요구하므로 작은 `CHUNK_MAX_CHARS`는 실제 시나리오다.
 */
describe("chunkRecord — 예산 가드 (T-005 F-5)", () => {
  const LONG_TITLE = "가".repeat(200); // contracts의 title 상한

  it("prefix가 상한을 잡아먹으면 조용히 쪼개지 않고 즉시 실패한다", () => {
    const record = incident({
      title: LONG_TITLE,
      symptom: "본문".repeat(500),
      resolution: "해결했다.",
    });

    expect(() => chunkRecord(record, { maxChars: 100 })).toThrow(ChunkBudgetError);
  });

  it("실패 에러에 진단 가능한 코드가 붙는다", () => {
    const record = incident({
      title: LONG_TITLE,
      symptom: "본문".repeat(500),
      resolution: "해결했다.",
    });

    try {
      chunkRecord(record, { maxChars: 100 });
      expect.unreachable("throw 했어야 한다");
    } catch (error) {
      expect(error).toBeInstanceOf(ChunkBudgetError);
      expect((error as ChunkBudgetError).code).toBe("CHUNK_BUDGET_TOO_SMALL");
    }
  });

  it("예산이 충분하면 정상 동작한다", () => {
    const record = incident({
      title: LONG_TITLE,
      symptom: "본문".repeat(500),
      resolution: "해결했다.",
    });

    const chunks = chunkRecord(record, { maxChars: 1200 });

    expect(chunks.length).toBeGreaterThan(0);
    for (const chunk of chunks) {
      expect(chunk.text.length).toBeLessThanOrEqual(1200);
    }
  });
});


/** 짝을 잃은 서로게이트 개수. 0이 아니면 UTF-8 인코딩에서 U+FFFD로 손상된다. */
function countLoneSurrogates(text: string): number {
  let lone = 0;
  for (let i = 0; i < text.length; i += 1) {
    const code = text.charCodeAt(i);
    if (code >= 0xd800 && code <= 0xdbff) {
      const next = text.charCodeAt(i + 1);
      if (next >= 0xdc00 && next <= 0xdfff) i += 1;
      else lone += 1;
    } else if (code >= 0xdc00 && code <= 0xdfff) {
      lone += 1;
    }
  }
  return lone;
}


/**
 * T-005 F-B/F-D/F-E 회귀. 서로게이트 안전의 실질적 방벽 세 가지를 못박는다.
 * 재검증에서 이 셋의 뮤턴트가 전부 생존했다 — 동작은 옳은데 잠겨 있지 않았다.
 */
describe("chunkRecord — 서로게이트 안전 불변식 (T-005 F-B/F-D/F-E)", () => {
  it("F-E: ChunkBudgetError를 배럴에서 가져올 수 있다", async () => {
    // T-008 워커가 `instanceof`로 잡아야 한다. 배럴에 없으면 code 문자열 비교로
    // 우회해야 하고, 그건 이 클래스를 만든 이유를 절반 무효화한다.
    const barrel = await import("./index.js");

    expect(barrel.ChunkBudgetError).toBe(ChunkBudgetError);
  });

  it("F-B: 예산이 2 미만이면 hardCut이 조용히 손상시키지 않고 던진다", () => {
    // MIN_BODY_BUDGET을 누가 낮추면 budget=1에서 모든 청크가 고아 서로게이트가 된다.
    // 하한을 hardCut 자신이 다시 검사해 그 경로를 봉한다.
    const record = incident({ title: "가", symptom: "🔥".repeat(20), resolution: "해결했다." });

    expect(() => chunkRecord(record, { maxChars: 1 })).toThrow(ChunkBudgetError);
  });

  it.each([
    ["U+10000 (하한 서로게이트 0xD800)", "\u{10000}"],
    ["U+10FFFD (상한 서로게이트 0xDBFF)", "\u{10FFFD}"],
  ])("F-D: 서로게이트 범위 양끝 %s 도 쪼개지지 않는다", (_name, char) => {
    // 0xD800·0xDBFF 경계를 off-by-one으로 놓치면 이 두 평면만 조용히 깨진다.
    // **pad로 오프셋을 밀어야 한다** — 절단면이 짝수에 떨어지면 백오프가 아예 발동하지 않아
    // 경계 판정이 틀려도 테스트가 통과해 버린다(재검증에서 실제로 그랬다).
    for (let pad = 0; pad < 4; pad += 1) {
      const record = incident({
        title: "경계 평면",
        symptom: `${"x".repeat(pad)}{"payload":"${char.repeat(1400)}"}`,
        resolution: "해결했다.",
      });

      const chunks = chunkRecord(record, { maxChars: 1200 }).filter(
        (chunk) => chunk.section === "symptom",
      );

      expect(chunks.length).toBeGreaterThan(1);
      const lone = chunks.reduce((sum, c) => sum + countLoneSurrogates(c.text), 0);
      expect(lone, `pad=${String(pad)}에서 서로게이트가 깨졌다`).toBe(0);
    }
  });
});
