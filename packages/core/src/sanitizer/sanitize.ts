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
import { applyMasking } from "./masking.js";

/** 호출자가 넘길 수 있는 옵션. 넘기지 않으면 env에서 읽는다. */
export interface SanitizeOptions {
  /** 이메일 마스킹 여부. 기본 false — 담당자 이메일은 대개 진단 정보다. */
  readonly maskEmail?: boolean;
}

/** 옵션을 모두 실체화한 형태. 내부 계산은 항상 이 값으로 한다. */
export interface ResolvedSanitizeOptions {
  readonly maskEmail: boolean;
}

export interface SanitizeResult {
  /** 시크릿이 라벨로 치환된 본문. 인젝션 의심 문구는 원문 그대로 남는다. */
  readonly text: string;
  /** specs/02가 정의한 2종만 나온다. contracts의 `SanitizeFlag`를 그대로 쓴다. */
  readonly flags: SanitizeFlag[];
}

/**
 * env에서 옵션을 읽는다. 정책 상수를 코드에 박지 않는다(specs/03 §6).
 * `SANITIZE_MASK_EMAIL`은 `1|true|yes|on`(대소문자 무시)일 때만 켜진다 —
 * 오타가 조용히 "켜짐"으로 해석되면 기록에서 이메일이 소리 없이 사라진다.
 */
export function readSanitizeOptions(env: NodeJS.ProcessEnv = process.env): ResolvedSanitizeOptions {
  const raw = env["SANITIZE_MASK_EMAIL"]?.trim().toLowerCase();
  return { maskEmail: raw === "1" || raw === "true" || raw === "yes" || raw === "on" };
}

function resolveOptions(options: SanitizeOptions | undefined): ResolvedSanitizeOptions {
  if (options?.maskEmail !== undefined) return { maskEmail: options.maskEmail };
  return readSanitizeOptions();
}

/**
 * 텍스트 하나를 새니타이즈한다.
 *
 * 플래그는 `secret-masked`(실제 치환이 일어남)와 `injection-suspect`(의심 패턴 발견)
 * 두 종뿐이다 — contracts가 닫아 둔 집합이며 늘리려면 스펙 변경(인간 승인)이 먼저다.
 * 어떤 종류가 마스킹됐는지는 본문 라벨(`[MASKED:aws-access-key]`)이 알려준다(specs/07 §3).
 * 구조화된 목록이 필요하면 `applyMasking`을 직접 부른다.
 */
export function sanitize(text: string, options?: SanitizeOptions): SanitizeResult {
  const { maskEmail } = resolveOptions(options);

  // 인젝션 판정은 **원문**을 본다. 마스킹 라벨이 문장을 끊어 회피 경로가 되면 안 된다.
  const injectionHits = detectInjection(text);
  const { text: maskedText, masked } = applyMasking(text, maskEmail);

  const flags: SanitizeFlag[] = [];
  if (masked.length > 0) flags.push("secret-masked");
  if (injectionHits.length > 0) flags.push("injection-suspect");

  return { text: maskedText, flags };
}
