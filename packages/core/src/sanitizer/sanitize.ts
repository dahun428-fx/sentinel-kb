/**
 * 새니타이즈 게이트. 출처: specs/00-product.md FR-06, specs/tasks/T-004.
 *
 * 저장 경로의 **동기** 게이트다 — 정규식만 쓰고 LLM·네트워크를 부르지 않는다.
 * 같은 입력은 언제나 같은 출력을 낸다.
 *
 * 마스킹과 플래그는 성격이 다르다:
 * - 시크릿은 **지운다**. 남으면 유출이다.
 * - 인젝션 의심은 **표시만 한다**. 지우면 "무엇이 에이전트를 탈선시켰나"라는 지식이 사라진다.
 */
import type { SanitizeFlag } from "@sentinel/contracts";

import { detectInjection } from "./injection.js";
import { applyMasking, type MaskKind } from "./masking.js";

/** 호출자가 넘길 수 있는 옵션. 넘기지 않으면 env에서 읽는다. */
export interface SanitizeOptions {
  /** 이메일 마스킹 여부. 기본 false — 담당자 이메일은 대개 진단 정보다. */
  readonly maskEmail?: boolean;
  /** 입력 길이 상한(문자 수). 초과하면 `SanitizeInputTooLargeError`를 던진다. */
  readonly maxInputChars?: number;
}

/** 옵션을 모두 실체화한 형태. 내부 계산은 항상 이 값으로 한다. */
export interface ResolvedSanitizeOptions {
  readonly maskEmail: boolean;
  readonly maxInputChars: number;
}

/**
 * 입력 길이 상한의 기본값. 청크 상한(1200자)의 50배가 넘으니 정상 기록에는 걸리지 않는다.
 *
 * 이 상한이 필요한 이유는 크기가 아니라 **모양**이다. `Bearer Bearer Bearer…` 처럼 7바이트마다
 * 매치가 생기는 입력은 세그먼트가 선형으로 늘고 겹침 해소가 그 위에서 다시 비용을 먹는다
 * (T-004 F-11/F-14). 저장 경로의 **동기** 게이트라 그 시간 동안 API 프로세스가 통째로 멈춘다.
 */
export const DEFAULT_MAX_INPUT_CHARS = 65_536;

/**
 * 입력이 상한을 넘었을 때. **조용히 자르지 않는다.**
 *
 * 자르면 잘려나간 부분의 시크릿이 검사되지 않은 채 사라지는 게 아니라, 호출자가 그 사실을
 * 모른 채 잘린 본문을 저장한다 — 기록은 손상되고 유출 여부는 아무도 모른다.
 * 명시적 실패라야 T-007이 400으로 거절하고 사용자가 본문을 나눠 올릴 수 있다.
 */
export class SanitizeInputTooLargeError extends Error {
  readonly code = "SANITIZE_INPUT_TOO_LARGE";

  constructor(
    readonly length: number,
    readonly maxLength: number,
  ) {
    super(
      `새니타이즈 입력이 상한을 초과했다: ${String(length)}자 (상한 ${String(maxLength)}자). ` +
        `SANITIZE_MAX_INPUT_CHARS로 조정할 수 있다.`,
    );
    this.name = "SanitizeInputTooLargeError";
  }
}

export interface SanitizeResult {
  /** 시크릿이 라벨로 치환된 본문. 인젝션 의심 문구는 원문 그대로 남는다. */
  readonly text: string;
  /** specs/02가 정의한 2종만 나온다. contracts의 `SanitizeFlag`를 그대로 쓴다. */
  readonly flags: SanitizeFlag[];
  /**
   * **실제로 마스킹된 종류.** specs/07 §3이 "마스킹이 발생하면 무엇이 마스킹됐는지
   * 알려준다(조용히 삼키지 않음)"고 못박았는데, 예전 계약은 `{text, flags}`뿐이라
   * 호출자가 그 경고를 채울 수단이 없었다(T-004 F-1 / T-002 F-6).
   *
   * 대안은 둘 다 나빴다. 본문에서 `[MASKED:...]` 라벨을 **재파싱**하는 것은 사용자가 그
   * 문자열을 직접 적은 경우와 구별할 수 없고, API 계층에서 `applyMasking`을 다시 부르는 것은
   * 게이트를 두 번 돌린다(비용도 두 배, 두 경로가 갈라질 여지도 생긴다).
   * `applyMasking`이 이미 이 값을 계산해 반환하므로 **버리지 않고 흘려보내면 된다.**
   *
   * contracts 스키마가 아니라 core 내부 타입이라 계약 재개방(G3)이 아니다.
   */
  readonly masked: readonly MaskKind[];
  /** 발화한 인젝션 규칙 id. `detectInjection`이 이미 돌려주던 값을 보존한다. */
  readonly injectionRules: readonly string[];
}

/**
 * env에서 옵션을 읽는다. 정책 상수를 코드에 박지 않는다(specs/03 §6).
 * `SANITIZE_MASK_EMAIL`은 `1|true|yes|on`(대소문자 무시)일 때만 켜진다 —
 * 오타가 조용히 "켜짐"으로 해석되면 기록에서 이메일이 소리 없이 사라진다.
 */
export function readSanitizeOptions(env: NodeJS.ProcessEnv = process.env): ResolvedSanitizeOptions {
  const raw = env["SANITIZE_MASK_EMAIL"]?.trim().toLowerCase();
  return {
    maskEmail: raw === "1" || raw === "true" || raw === "yes" || raw === "on",
    maxInputChars: readMaxInputChars(env["SANITIZE_MAX_INPUT_CHARS"]),
  };
}

/**
 * `SANITIZE_MAX_INPUT_CHARS`. 양의 정수가 아니면 **기본값으로 되돌린다.**
 * 오타(`SANITIZE_MAX_INPUT_CHARS=많이`)가 상한을 무한대로 해석돼 게이트를 조용히
 * 무력화하는 경로를 만들지 않기 위함이다.
 */
function readMaxInputChars(raw: string | undefined): number {
  const parsed = Number(raw?.trim());
  if (!Number.isSafeInteger(parsed) || parsed <= 0) return DEFAULT_MAX_INPUT_CHARS;
  return parsed;
}

/**
 * 옵션 해석. **필드별로 독립적으로** env를 읽는다.
 *
 * "둘 다 주어졌을 때만 env를 건너뛴다"로 쓰면 안 된다 — `{maskEmail}`만 명시한 호출이
 * `maxInputChars` 때문에 env를 읽게 되고, 그러면 **테스트가 주변 셸 환경에 결합된다.**
 * 개발자 셸에 `SANITIZE_MAX_INPUT_CHARS=1000`이 있으면 기본값 기반 유닛 테스트가
 * 위양성으로 실패한다. 명시된 필드는 env를 아예 조회하지 않아야 한다. (T-004 F-4)
 */
function resolveOptions(options: SanitizeOptions | undefined): ResolvedSanitizeOptions {
  return {
    maskEmail: options?.maskEmail ?? readSanitizeOptions().maskEmail,
    maxInputChars:
      options?.maxInputChars ?? readMaxInputChars(process.env["SANITIZE_MAX_INPUT_CHARS"]),
  };
}

/**
 * 텍스트 하나를 새니타이즈한다.
 *
 * 플래그는 `secret-masked`(실제 치환이 일어남)와 `injection-suspect`(의심 패턴 발견)
 * 두 종뿐이다 — contracts가 닫아 둔 집합이며 늘리려면 스펙 변경(인간 승인)이 먼저다.
 * 어떤 종류가 마스킹됐는지는 본문 라벨(`[MASKED:aws-access-key]`)과 함께
 * `masked`·`injectionRules`로도 돌려준다 — specs/07 §3의 "무엇이 마스킹됐는지" 경고를
 * 채우는 유일한 신뢰 가능한 출처다.
 *
 * @throws {SanitizeInputTooLargeError} 입력이 `maxInputChars`를 초과할 때.
 */
export function sanitize(text: string, options?: SanitizeOptions): SanitizeResult {
  const { maskEmail, maxInputChars } = resolveOptions(options);
  if (text.length > maxInputChars) {
    throw new SanitizeInputTooLargeError(text.length, maxInputChars);
  }

  // 인젝션 판정은 **원문**을 본다. 마스킹 라벨이 문장을 끊어 회피 경로가 되면 안 된다.
  const injectionHits = detectInjection(text);
  const { text: maskedText, masked } = applyMasking(text, maskEmail);

  const flags: SanitizeFlag[] = [];
  if (masked.length > 0) flags.push("secret-masked");
  if (injectionHits.length > 0) flags.push("injection-suspect");

  return { text: maskedText, flags, masked, injectionRules: injectionHits };
}
