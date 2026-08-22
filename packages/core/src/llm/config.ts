/**
 * LLM provider 설정. 출처: specs/06-deployment.md(시크릿은 SSM/.env), NFR-01, NFR-06,
 * `.env.example`, T-039 D-2·D-5.
 *
 * `embedder/config.ts`와 같은 규약이다 — **모델 ID와 API 키에는 기본값이 없다.**
 * 없으면 조용히 폴백하지 않고 코드가 붙은 에러로 즉시 실패한다. 임베딩에서 그 규칙의 근거가
 * NFR-06("모델 교체 가능")이었다면, 여기서의 근거는 같은 형태의 두 가지다:
 * 모델 세대가 코드에 박히면 교체가 재배포가 되고, 키가 코드에 박히면 그건 금지 사항이다.
 *
 * ## 타임아웃·재시도 기본값은 어디서 왔나 (T-039 D-5)
 *
 * SDK 기본은 타임아웃 10분, 재시도 2회(=3회 시도)다. **최악 30분**이고 NFR-01(MCP 도구
 * p95 < 2s)의 900배다. 게다가 MCP 클라이언트가 이미 자기 층에서 3회 시도하므로 층이
 * 곱해진다 — 사용자 요청 1건에 모델 호출 9회(T-019 F-7).
 *
 * 역산:
 *  - MCP 클라이언트의 **시도당 타임아웃이 10초**다(T-019 F-7). 그보다 오래 걸린 생성은
 *    아무도 받지 못한다 — 토큰만 태우고 버려진다. 그래서 시도당 상한을 그 아래로 둔다.
 *  - 재시도는 **빠른 실패**(429 즉시 응답, 연결 거부)에 의미가 있다. 타임아웃 뒤의 재시도는
 *    호출자가 이미 포기한 뒤라 거의 언제나 낭비이고 과금만 두 배가 된다. 그래서 1회.
 *
 * 그래도 NFR-01의 2초는 아니다 — 이 층이 할 수 있는 것은 상한을 **유한하고 명시적으로**
 * 만드는 것까지다. 진짜 해소(토큰 스트리밍 또는 스펙 완화)는 T-039 Findings에 인계했다.
 */
import { LLM_ERROR_CODES, LlmError } from "./types.js";

/** `.env.example`과 같은 값. 여기가 유일한 리터럴 등장 지점이다(`generator/config.ts` 규약). */
export const LLM_DEFAULTS = {
  /** 시도 1회의 벽시계 상한(ms). MCP 클라이언트의 시도당 10초보다 **아래**여야 한다. */
  ANTHROPIC_TIMEOUT_MS: 8000,
  /** 재시도 횟수(총 시도 = 이 값 + 1). SDK 기본 2를 낮춘 것이다. */
  ANTHROPIC_MAX_RETRIES: 1,
} as const;

export interface AnthropicConfig {
  readonly model: string;
  readonly apiKey: string;
  readonly timeoutMs: number;
  readonly maxRetries: number;
}

/**
 * env → 설정. **모델·키는 없으면 던지고, 타임아웃·재시도는 오설정 시 기본값으로 되돌린다.**
 *
 * 실패 정책이 갈리는 것은 의도다(`embedder/config.ts`의 같은 갈림과 같은 근거).
 * 모델·키가 없으면 provider가 **아무것도 할 수 없으므로** 그건 진행 불가다.
 * 타임아웃 오타는 파이프라인을 세우는 것보다 안전한 기본값으로 도는 편이 낫다 —
 * 다만 그 기본값이 SDK 기본값이 아니라 위에서 역산한 값이라는 점이 핵심이다.
 */
export function readAnthropicConfig(env: NodeJS.ProcessEnv = process.env): AnthropicConfig {
  const model = env["ANTHROPIC_MODEL"]?.trim();
  if (!model) {
    throw new LlmError(
      LLM_ERROR_CODES.MODEL_MISSING,
      "ANTHROPIC_MODEL이 설정되지 않았다. 모델 세대는 코드가 아니라 env가 소스다 — " +
        "코드에 박으면 교체가 재배포가 된다(EMBEDDING_MODEL과 같은 규약). .env.example 참고.",
    );
  }

  const apiKey = env["ANTHROPIC_API_KEY"]?.trim();
  if (!apiKey) {
    throw new LlmError(
      LLM_ERROR_CODES.API_KEY_MISSING,
      "ANTHROPIC_API_KEY가 설정되지 않았다. 시크릿 하드코딩 금지 — SSM/.env로 주입하라(specs/06).",
    );
  }

  return {
    model,
    apiKey,
    timeoutMs: readPositiveInt(env["ANTHROPIC_TIMEOUT_MS"], LLM_DEFAULTS.ANTHROPIC_TIMEOUT_MS),
    maxRetries: readNonNegativeInt(
      env["ANTHROPIC_MAX_RETRIES"],
      LLM_DEFAULTS.ANTHROPIC_MAX_RETRIES,
    ),
  };
}

function readPositiveInt(raw: string | undefined, fallback: number): number {
  const trimmed = raw?.trim();
  if (!trimmed) return fallback;
  const parsed = Number(trimmed);
  if (!Number.isInteger(parsed) || parsed <= 0) return fallback;
  return parsed;
}

/** 재시도는 **0이 유효값**이다 — "재시도하지 마라"를 표현할 수 있어야 한다. */
function readNonNegativeInt(raw: string | undefined, fallback: number): number {
  const trimmed = raw?.trim();
  if (!trimmed) return fallback;
  const parsed = Number(trimmed);
  if (!Number.isInteger(parsed) || parsed < 0) return fallback;
  return parsed;
}
