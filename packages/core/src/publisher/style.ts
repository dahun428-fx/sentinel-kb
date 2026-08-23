/**
 * 스타일 few-shot 로더 — specs/08-publishing.md §0-4, T-031 Scope
 * "스타일 few-shot은 `prompts/style/` 디렉토리에서 로드 (사람이 자기 글을 넣는다)".
 *
 * ## 표본이 없어도 던지지 않는다 (T-018 프롬프트 로더와 다른 판단)
 *
 * `generator/prompt.ts`는 조항이 빠지면 **던진다**. 조항은 계약이고 빠지면 NFR-02·NFR-05가
 * 조용히 무너지기 때문이다. 스타일 표본은 성질이 다르다 — 사람이 자기 글을 넣기 전까지
 * 비어 있는 것이 정상 상태이고, 비었다고 초안 생성이 불가능해지는 것은 아니다.
 * 대신 **몇 편을 실제로 실었는지 리포트에 남긴다**(`styleSamples`). 0이면 §0-4의 스타일
 * 주입이 이번 초안에는 작동하지 않았다는 뜻이고, 그 사실이 기록으로 남아야 T-034가
 * "문체가 나쁜가"와 "표본이 없었나"를 구분할 수 있다.
 *
 * ## 표본도 스크린을 통과해야 한다
 *
 * 표본은 **사람이 파일 시스템에 떨어뜨린 임의의 글**이다. 자기 블로그 글에 API 키가
 * 박혀 있을 수 있고, 어디선가 복사해 온 글에 지시문이 섞여 있을 수 있다. 그대로 프롬프트에
 * 실으면 T-030이 인용 경로에서 막아 둔 것이 스타일 경로로 되돌아온다.
 * `containsSecretShape`(T-030 F-4)와 `detectInjection`(T-040)을 그대로 재사용하고,
 * 걸린 표본은 **버리되 사유를 남긴다.**
 */
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

import { compareStrings } from "../facts/order.js";
import { containsSecretShape } from "../facts/screen.js";
import { detectInjection } from "../sanitizer/injection.js";

import { PUBLISHER_DEFAULTS } from "./config.js";

/**
 * 기본 디렉터리 = **레포 루트의 `prompts/style/`**. 스펙 문면 그대로다.
 * `import.meta.url` 기준으로 잡는 이유는 `generator/prompt.ts`와 같다(cwd 의존 금지).
 * 이 파일은 `packages/core/src/publisher/`에 있으므로 네 단계 위가 레포 루트다 —
 * 파일을 옮기면 이 상수를 함께 고쳐야 한다.
 */
const DEFAULT_STYLE_DIR = fileURLToPath(new URL("../../../../prompts/style/", import.meta.url));

/** 로더가 표본으로 읽지 않는 파일. 디렉터리 사용법을 적은 문서다. */
const SKIPPED_FILES = new Set(["README.md", "readme.md"]);

export const STYLE_REJECTION_REASONS = ["secret-shape", "injection-detected", "empty"] as const;
export type StyleRejectionReason = (typeof STYLE_REJECTION_REASONS)[number];

export interface StyleSample {
  /** 파일 이름. 사람이 어느 글이 실렸는지 되짚는 유일한 단서다. */
  readonly name: string;
  readonly text: string;
  readonly truncated: boolean;
}

export interface StyleRejection {
  readonly name: string;
  readonly reason: StyleRejectionReason;
}

export interface StyleSamples {
  readonly dir: string;
  /** 디렉터리가 없으면 `false`. 표본 0편과 구분된다. */
  readonly dirExists: boolean;
  readonly samples: readonly StyleSample[];
  readonly rejected: readonly StyleRejection[];
}

export interface LoadStyleSamplesOptions {
  readonly dir?: string | undefined;
  readonly maxChars?: number | undefined;
}

export function styleSamplesDir(override?: string): string {
  return override ?? DEFAULT_STYLE_DIR;
}

/** `prompts/style/*.md` → few-shot 표본. 파일 이름 순서로 결정론적이다. */
export function loadStyleSamples(options: LoadStyleSamplesOptions = {}): StyleSamples {
  const dir = styleSamplesDir(options.dir);
  const maxChars = options.maxChars ?? PUBLISHER_DEFAULTS.STYLE_SAMPLE_MAX_CHARS;

  let names: string[];
  try {
    names = readdirSync(dir)
      .filter((name) => name.endsWith(".md") && !SKIPPED_FILES.has(name))
      .sort(compareStrings);
  } catch {
    return { dir, dirExists: false, samples: [], rejected: [] };
  }

  const samples: StyleSample[] = [];
  const rejected: StyleRejection[] = [];

  for (const name of names) {
    const path = join(dir, name);
    if (!statSync(path).isFile()) continue;
    const raw = readFileSync(path, "utf8").trim();
    if (raw.length === 0) {
      rejected.push({ name, reason: "empty" });
      continue;
    }
    if (detectInjection(raw).length > 0) {
      rejected.push({ name, reason: "injection-detected" });
      continue;
    }
    if (containsSecretShape(raw)) {
      rejected.push({ name, reason: "secret-shape" });
      continue;
    }
    samples.push({
      name,
      text: raw.length > maxChars ? raw.slice(0, maxChars) : raw,
      truncated: raw.length > maxChars,
    });
  }

  return { dir, dirExists: true, samples, rejected };
}

/**
 * 프롬프트에 실릴 형태. `narrative.ts`와 같은 데이터 프레이밍이다 —
 * 표본은 **문체를 흉내 낼 대상**이지 지시가 아니고, 그 구분이 구조로 보여야 한다.
 */
export function renderStyleSamples(samples: readonly StyleSample[]): string {
  return samples
    .map((sample) => `<style-sample name="${sample.name}">\n${sample.text}\n</style-sample>`)
    .join("\n\n");
}
