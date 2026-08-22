/**
 * 구조 인지 chunker — Record를 섹션별 청크로 쪼갠다.
 * 출처: specs/03-rag-pipeline.md §1-2, specs/02-data-model.md chunks, T-005.
 *
 * 이 모듈은 임베딩도 DB도 모른다(T-005 Out of scope). `recordId`·`embedding`·`meta`는
 * 인제스트 워커(T-008)가 저장 시점에 조립한다. 여기서 결정하는 것은 **무엇을 임베딩할지**
 * 뿐이다.
 */
import type { ChunkSection, RecordSchema } from "@sentinel/contracts";

import { readChunkMaxChars } from "./config.js";

/**
 * 청킹 결과. `ChunkSchema`(contracts)의 부분집합이며 core 내부 타입이다 —
 * DB 도큐먼트가 아니므로 contracts에 올리지 않는다.
 */
export interface SectionChunk {
  readonly section: ChunkSection;
  readonly seq: number;
  readonly text: string;
}

export interface ChunkOptions {
  /** 청크 1개의 최대 문자 수(prefix 포함). 미지정 시 `CHUNK_MAX_CHARS` env. */
  readonly maxChars?: number;
}

/**
 * 섹션 순회 순서. 스펙에 적힌 본문 순서를 그대로 따른다 — 결정론적 출력의 일부다.
 * divergence의 `context`는 재현 맥락 객체(model/tool/framework)이지 본문이 아니라서
 * `ChunkSection` 열거형에 없다. 따라서 청크를 만들지 않는다. (specs/02 chunks.section)
 */
const INCIDENT_SECTIONS = ["symptom", "rootCause", "resolution", "prevention"] as const;
const DIVERGENCE_SECTIONS = ["expected", "actual", "correction"] as const;

/**
 * Record → SectionChunk[].
 *
 * - 섹션마다 독립 청크. 빈 섹션(미입력·공백만)은 **스킵**한다. incident에 expected가 없고
 *   divergence에 symptom이 없는 것은 정상이며 에러가 아니다. (specs/03 §1-2)
 * - 섹션이 상한을 넘으면 문단 → 문장/줄 → (불가피할 때만) 강제 순서로 쪼개고,
 *   조각마다 `seq`를 0부터 부여한다.
 * - 같은 입력은 항상 같은 출력이다. 난수·시각·LLM을 쓰지 않는다.
 */
/**
 * 본문에 최소한 남겨야 할 예산. 이보다 적으면 청크가 prefix 덩어리가 되어
 * 임베딩이 제목만 보게 된다 — 검색 신호가 사라진다.
 */
const MIN_BODY_BUDGET = 32;

/** `CHUNK_MAX_CHARS` 설정이 제목 길이를 감당하지 못할 때. 조용한 오작동 대신 즉시 실패한다. */
export class ChunkBudgetError extends Error {
  readonly code = "CHUNK_BUDGET_TOO_SMALL";

  constructor(message: string) {
    super(message);
    this.name = "ChunkBudgetError";
  }
}

export function chunkRecord(record: RecordSchema, options: ChunkOptions = {}): SectionChunk[] {
  const maxChars = options.maxChars ?? readChunkMaxChars();
  const title = record.title.trim();
  const chunks: SectionChunk[] = [];

  for (const [section, body] of readSections(record)) {
    if (body === undefined || body.trim() === "") continue;

    const prefix = buildPrefix(title, section);
    // prefix도 임베딩되는 텍스트다. 예산에서 빼지 않으면 완성된 청크가 상한을 넘는다.
    const budget = maxChars - prefix.length;
    if (budget < MIN_BODY_BUDGET) {
      // `Math.max(1, ...)` 로 뭉개면 안 된다 — 제목 200자 + CHUNK_MAX_CHARS=100 조합에서
      // **모든 청크가 상한을 위반한 채 3000개**가 나오고 임베딩 호출이 폭발한다(T-005 F-5).
      // specs/03 §6이 eval 스윕을 위해 env화를 요구하므로 작은 값은 가상 시나리오가 아니다.
      // 조용히 잘못된 결과를 내느니 설정 오류로 즉시 실패시킨다.
      throw new ChunkBudgetError(
        `CHUNK_MAX_CHARS(${String(maxChars)})가 prefix 길이(${String(prefix.length)})를 감당하지 못한다. ` +
          `본문 예산이 ${String(budget)}자로 최소 ${String(MIN_BODY_BUDGET)}자 미만이다. ` +
          `상한을 올리거나 제목(${String(title.length)}자)을 줄여야 한다.`,
      );
    }

    const pieces = splitBody(body, budget);
    for (const [seq, piece] of pieces.entries()) {
      chunks.push({ section, seq, text: `${prefix}${piece}` });
    }
  }

  return chunks;
}

/** 청크 텍스트 prefix. specs/03 §1-2가 명시한 형식 — 임베딩에 문맥을 준다. */
function buildPrefix(title: string, section: ChunkSection): string {
  return `[${title}] (${section}) `;
}

/** 판별 유니온을 `type`으로 갈라 (섹션, 본문) 쌍을 스펙 순서대로 낸다. */
function readSections(
  record: RecordSchema,
): readonly (readonly [ChunkSection, string | undefined])[] {
  if (record.type === "incident") {
    return INCIDENT_SECTIONS.map((section) => [section, record[section]] as const);
  }
  return DIVERGENCE_SECTIONS.map((section) => [section, record[section]] as const);
}

/**
 * 문단 경계 — 빈 줄 **뒤**에서 자른다. 폭 0 assertion이라 원문 문자가 하나도 유실되지 않고,
 * 조각을 이어붙이면 원문이 그대로 복원된다.
 */
const PARAGRAPH_BOUNDARY = /(?<=\n[ \t]*\n)/;

/**
 * 문장 경계 후보.
 * 1. 종결부호(`.?!…`) 뒤 + 공백 앞 — 한국어 `다.`·`요.`·`함.`이 여기 걸린다.
 *    "공백 앞"을 요구하므로 `foo.ts`·`v1.2.3`처럼 부호 뒤가 붙어 있는 토큰은 쪼개지지 않는다.
 * 2. 한국어 종결 어미 + 종결부호 뒤 (공백이 없어도) — "…했다.그래서" 같은 표기 대응.
 * 3. 줄바꿈 뒤 — 코드 블록·스택트레이스는 문장이 아니므로 줄이 곧 경계다.
 */
const SENTENCE_BOUNDARY = /(?<=[.?!…。！？])(?=\s)|(?<=[다요함음임][.?!])(?=[^\s.?!])|(?<=\n)/;

/**
 * 본문을 예산 이하 조각들로 나눈다. 앞 단계에서 예산 이하가 되면 더 내려가지 않는다:
 * 문단 → 문장/줄 → 강제 절단.
 */
function splitBody(body: string, budget: number): string[] {
  const trimmed = body.trim();
  if (trimmed === "") return [];
  if (trimmed.length <= budget) return [trimmed];

  return packUnits(tokenize(body, PARAGRAPH_BOUNDARY), budget, (paragraph) =>
    packUnits(tokenize(paragraph, SENTENCE_BOUNDARY), budget, (sentence) =>
      hardCut(sentence, budget),
    ),
  );
}

/** 경계에서 자르되 구분자를 앞 조각 끝에 남겨, 이어붙이면 원문이 되는 토큰 배열을 만든다. */
function tokenize(text: string, boundary: RegExp): string[] {
  return text.split(boundary).filter((token) => token.trim() !== "");
}

/**
 * 토큰을 예산까지 탐욕적으로 채운다. 토큰 하나가 그 자체로 예산을 넘으면 `splitOversized`로
 * 한 단계 더 내려간다. 각 조각은 항상 토큰 경계에서 끝나므로 문장이 중간에서 잘리지 않는다.
 */
function packUnits(
  tokens: readonly string[],
  budget: number,
  splitOversized: (token: string) => string[],
): string[] {
  const pieces: string[] = [];
  let current = "";

  const flush = (): void => {
    const piece = current.trim();
    if (piece !== "") pieces.push(piece);
    current = "";
  };

  for (const token of tokens) {
    const candidate = current + token;
    if (candidate.trim().length <= budget) {
      current = candidate;
      continue;
    }
    flush();
    if (token.trim().length <= budget) {
      current = token;
      continue;
    }
    pieces.push(...splitOversized(token));
  }
  flush();

  return pieces;
}

/**
 * 마지막 수단. 줄바꿈도 종결부호도 없는 초장문(예: 한 줄짜리 거대 로그)은 경계가 없으므로
 * 예산 단위로 강제 절단한다. **이때만** 문장 중간이 잘린다.
 *
 * 절단 위치가 **서로게이트 쌍 사이에 걸리면 안 된다.** `slice`는 UTF-16 코드 유닛 단위라
 * 이모지 같은 비-BMP 문자가 반으로 갈리고, 그 고아 서로게이트는 UTF-8로 인코딩되는 순간
 * U+FFFD로 치환되어 **되돌릴 수 없다**(T-005). 청크 텍스트는 임베딩 API 페이로드와
 * MongoDB(BSON=UTF-8)로 나가므로 손상이 그대로 굳는다.
 * 한 줄 JSON 로그·base64·긴 URL에 이모지가 섞이면 기본 설정에서도 재현된다.
 */
function hardCut(text: string, budget: number): string[] {
  // 백오프가 진행을 멈추지 않으려면 예산이 최소 2는 돼야 한다. `chunkRecord`의
  // `MIN_BODY_BUDGET` 가드가 이를 보장하지만, 그 가드가 완화되면 여기서 무한 루프나
  // 서로게이트 손상이 조용히 부활한다. 불변식을 이 함수 안에서도 못박는다. (T-005 F-B/F-C)
  if (budget < 2) {
    throw new ChunkBudgetError(`hardCut 예산이 ${String(budget)}자다. 최소 2자가 필요하다.`);
  }
  const trimmed = text.trim();
  const pieces: string[] = [];
  let index = 0;
  while (index < trimmed.length) {
    let end = Math.min(index + budget, trimmed.length);
    // 절단면이 상위 서로게이트면 한 칸 물러 쌍을 온전히 남긴다.
    if (end < trimmed.length && isHighSurrogate(trimmed.charCodeAt(end - 1))) {
      end -= 1;
    }
    const piece = trimmed.slice(index, end).trim();
    if (piece !== "") pieces.push(piece);
    index = end;
  }
  return pieces;
}

function isHighSurrogate(code: number): boolean {
  return code >= 0xd800 && code <= 0xdbff;
}
