/**
 * publisher 튜닝 파라미터. `generator/config.ts`와 같은 규약이다 —
 * 값이 등장하는 리터럴 자리는 이 파일 하나뿐이고, 오설정은 던지지 않고 기본값으로 되돌린다.
 *
 * ## 여기에 **재작성 상한이 없는 것은 누락이 아니다**
 *
 * `MAX_REWRITES`는 `draft.ts`에 상수로 박혀 있다. specs/08 §4의 "최대 2회"는 스펙 문면이지
 * 튜닝 값이 아니다 — env로 열면 0으로 꺼서 린터를 무력화하거나 10으로 올려 배치 비용을
 * 태울 수 있다. `generator`의 `MAX_REGENERATIONS`가 같은 이유로 env 밖에 있다.
 */

/** `.env.example`과 같은 값. */
export const PUBLISHER_DEFAULTS = {
  /** 초안 1건의 출력 상한. 아티클은 답변보다 길어서 `ANSWER_MAX_TOKENS`보다 크다. */
  DRAFT_MAX_TOKENS: 4096,
  /**
   * 다이어그램 1건의 출력 상한(§5.2, T-032). 초안보다 훨씬 작다 — 산출물이 mermaid 코드
   * 한 덩이이고, 상한이 크면 재생성 3회의 비용만 커진다.
   *
   * **재생성 상한(`MAX_DIAGRAM_REGENERATIONS`)은 여기 없다.** `MAX_REWRITES`와 같은 이유다:
   * env로 열면 0으로 꺼서 컴파일 검증 루프를 무력화할 수 있다.
   */
  DIAGRAM_MAX_TOKENS: 1024,
  /**
   * 스타일 표본 1편의 상한. 사람이 넣는 글이라 길이를 제어할 수 없고,
   * 표본 셋이 초안 프롬프트를 통째로 밀어내면 팩트가 뒤로 밀린다.
   */
  STYLE_SAMPLE_MAX_CHARS: 6000,
  /**
   * 서사 재료로 실리는 레코드 본문 **한 섹션**의 상한.
   * 레코드 본문을 프롬프트에 넣는다는 결정(`narrative.ts` 서두)의 비용 상한이기도 하다.
   */
  NARRATIVE_PART_MAX_CHARS: 600,
} as const;

export type PublisherEnvName = keyof typeof PUBLISHER_DEFAULTS;

export interface PublisherConfig {
  readonly draftMaxTokens: number;
  readonly diagramMaxTokens: number;
  readonly styleSampleMaxChars: number;
  readonly narrativePartMaxChars: number;
  /** 스타일 few-shot 디렉터리. 미지정이면 레포 루트의 `prompts/style/`. */
  readonly styleSamplesDir: string | undefined;
}

export function readPublisherConfig(env: NodeJS.ProcessEnv = process.env): PublisherConfig {
  const dir = env["STYLE_SAMPLES_DIR"]?.trim();
  return {
    draftMaxTokens: readPositiveInt(env["DRAFT_MAX_TOKENS"], PUBLISHER_DEFAULTS.DRAFT_MAX_TOKENS),
    diagramMaxTokens: readPositiveInt(
      env["DIAGRAM_MAX_TOKENS"],
      PUBLISHER_DEFAULTS.DIAGRAM_MAX_TOKENS,
    ),
    styleSampleMaxChars: readPositiveInt(
      env["STYLE_SAMPLE_MAX_CHARS"],
      PUBLISHER_DEFAULTS.STYLE_SAMPLE_MAX_CHARS,
    ),
    narrativePartMaxChars: readPositiveInt(
      env["NARRATIVE_PART_MAX_CHARS"],
      PUBLISHER_DEFAULTS.NARRATIVE_PART_MAX_CHARS,
    ),
    styleSamplesDir: dir === undefined || dir.length === 0 ? undefined : dir,
  };
}

function readPositiveInt(raw: string | undefined, fallback: number): number {
  const trimmed = raw?.trim();
  if (!trimmed) return fallback;
  const parsed = Number(trimmed);
  if (!Number.isInteger(parsed) || parsed <= 0) return fallback;
  return parsed;
}
