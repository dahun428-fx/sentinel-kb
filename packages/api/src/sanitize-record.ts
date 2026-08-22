/**
 * 저장 경로의 새니타이즈 게이트 연결. 출처: specs/00 FR-06, specs/07 §3, T-004 인계 사항.
 *
 * core의 `sanitize()`를 부르기만 하는 얇은 층처럼 보이지만, 여기서 결정한 것이 셋 있다.
 *
 * ## 1. 옵션은 **항상 명시적으로** 넘긴다
 * `sanitize()`는 옵션 미지정 시 `process.env`를 직접 읽는다(T-004 F-4). 요청마다 env를 읽으면
 * 같은 프로세스의 두 요청이 다른 정책으로 검사될 수 있고, 테스트는 주변 셸 환경에 결합된다.
 * 컴포지션 루트가 `readSanitizeOptions()`로 한 번 만들고 그 값을 끝까지 들고 다닌다.
 *
 * ## 2. 길이 상한은 **레코드 단위로** 먼저 잰다
 * `SANITIZE_MAX_INPUT_CHARS`(기본 65536)는 **`sanitize()` 호출 1회의 상한**이다.
 * 레코드는 섹션이 여러 개고 섹션마다 부르므로, 그 상한만 믿으면
 * `5 × 65536 = 327KB` 요청이 게이트를 통째로 통과한다. 상한의 목적은 크기가 아니라
 * **동기 블록 시간**이고(겹침 해소가 세그먼트 수에 이차 — T-004 F-11), 한 요청의 시간은
 * 섹션별 시간의 **합**이다. 그러니 합에 상한을 걸어야 방어가 성립한다.
 *
 * 상한을 초과하면 core와 **같은 에러 타입**(`SanitizeInputTooLargeError`)을 던진다.
 * 번역 지점을 하나로 두기 위해서다 — 새 예외 타입을 만들면 라우터에 분기가 하나 더 생기고
 * 그중 하나를 빠뜨리는 순간 500이 된다.
 *
 * ## 3. 마스킹 내역을 **버리지 않는다**
 * specs/07 §3이 "마스킹이 발생하면 무엇이 마스킹됐는지 알려준다(조용히 삼키지 않음)"고
 * 못박았다. core의 `SanitizeResult`를 `{text, flags, masked, injectionRules}`로 넓혀
 * (T-004 F-1 / T-002 F-6의 결론) 그 값을 여기서 합산해 응답 경고로 올린다.
 */
import type { SanitizeFlag } from "@sentinel/contracts";
import {
  sanitize,
  SanitizeInputTooLargeError,
  type MaskKind,
  type ResolvedSanitizeOptions,
} from "@sentinel/core";

/** 레코드 하나에서 새니타이즈를 거친 텍스트 필드 묶음과 그 부산물. */
export interface SanitizedFields {
  /** 필드명 → 마스킹된 텍스트. 입력에 있던 키만 들어 있다. */
  readonly texts: Readonly<Record<string, string>>;
  /** specs/02가 정의한 2종. 저장되는 `record.sanitizeFlags`가 된다. */
  readonly flags: SanitizeFlag[];
  /** 실제로 마스킹된 종류(중복 제거, 정렬 고정). */
  readonly masked: MaskKind[];
  /** 발화한 인젝션 규칙 id(중복 제거). */
  readonly injectionRules: string[];
}

/** specs/02가 정의한 플래그 순서. 응답이 요청마다 뒤집히지 않도록 고정한다. */
const FLAG_ORDER: readonly SanitizeFlag[] = ["secret-masked", "injection-suspect"];

/**
 * 텍스트 필드들을 한꺼번에 새니타이즈한다.
 *
 * @throws {SanitizeInputTooLargeError} 필드 길이의 **합**이 상한을 넘을 때.
 */
export function sanitizeFields(
  fields: Readonly<Record<string, string>>,
  options: ResolvedSanitizeOptions,
  countOnly: readonly string[] = [],
): SanitizedFields {
  const entries = Object.entries(fields);

  // 합계를 **먼저** 잰다. 섹션을 하나씩 돌리면서 재면 이미 그만큼 CPU를 쓴 뒤다.
  //
  // `countOnly`는 **길이만 세고 마스킹하지 않는** 값이다 — 지금은 `tags`가 유일하다.
  // 태그를 마스킹하면 안 되는 이유: `{tags:1}` 인덱스와 `meta.tags` 필터의 **정확 일치 키**라
  // 마스킹은 비가역이고 저장 태그와 질의 태그가 갈려 **조회가 조용히 깨진다.**
  // 그렇다고 합계에서 빼면 게이트에 구멍이 난다 — contracts의 `tags`는
  // `z.array(z.string()).max(20)`이라 **개당 길이 제한이 없어**, `tags: ["<900KB>"]` 하나가
  // 새니타이즈 게이트를 통째로 지나 `chunks.meta.tags`를 거쳐 검색·MCP 응답까지 전파된다.
  // 마스킹과 **검출·계량**은 별개다. 길이는 여기서 세고, 시크릿 검출 여부는 별건이다(T-007 F-4).
  const total =
    entries.reduce((sum, [, value]) => sum + value.length, 0) +
    countOnly.reduce((sum, value) => sum + value.length, 0);
  if (total > options.maxInputChars) {
    throw new SanitizeInputTooLargeError(total, options.maxInputChars);
  }

  const texts: Record<string, string> = {};
  const flags = new Set<SanitizeFlag>();
  const masked = new Set<MaskKind>();
  const injectionRules = new Set<string>();

  for (const [name, value] of entries) {
    const result = sanitize(value, options);
    texts[name] = result.text;
    for (const flag of result.flags) flags.add(flag);
    for (const kind of result.masked) masked.add(kind);
    for (const rule of result.injectionRules) injectionRules.add(rule);
  }

  return {
    texts,
    flags: FLAG_ORDER.filter((flag) => flags.has(flag)),
    masked: [...masked].sort(),
    injectionRules: [...injectionRules].sort(),
  };
}

/**
 * 응답에 싣는 경고. specs/07 §3의 `record_knowledge` → `{recordId, sanitizeFlags[], warning?}`가
 * 기대하는 정보의 출처다.
 *
 * **contracts 스키마가 아니다.** `openapi.ts`의 201은 `Record` 전문으로 등록돼 있어
 * 경고를 실을 자리가 계약에 없다(T-002 F-6). 계약을 여는 것은 G3(인간 승인) 사안이므로
 * 이번에는 **응답 바디의 추가 필드**로 우회한다 — `RecordSchema`가 `.strict()`가 아니라
 * 미승인 키를 흘려보내므로, 기존 클라이언트의 `RecordSchema.parse()`는 이 필드를 떨어뜨리고
 * 그대로 통과한다. 헤더가 아니라 바디를 택한 것은 `masked`·`injectionRules`가 목록이라
 * 헤더 한 줄로 무손실 표현하려면 결국 JSON을 인코딩해야 하기 때문이다.
 */
export interface SanitizeWarning {
  readonly message: string;
  readonly masked: MaskKind[];
  readonly injectionRules: string[];
}

/** 마스킹도 인젝션 의심도 없으면 `undefined` — 경고 없는 응답에 빈 객체를 싣지 않는다. */
export function toSanitizeWarning(result: SanitizedFields): SanitizeWarning | undefined {
  if (result.masked.length === 0 && result.injectionRules.length === 0) return undefined;

  const parts: string[] = [];
  if (result.masked.length > 0) {
    parts.push(`시크릿이 마스킹됐다: ${result.masked.join(", ")}`);
  }
  if (result.injectionRules.length > 0) {
    parts.push(`인젝션 의심 패턴이 발견됐다: ${result.injectionRules.join(", ")}`);
  }
  return {
    message: parts.join(" / "),
    masked: result.masked,
    injectionRules: result.injectionRules,
  };
}
