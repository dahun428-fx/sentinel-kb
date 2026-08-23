/**
 * 블라인딩. **judge가 어느 글이 무엇인지 알 수 있으면 §6의 판정은 아무것도 재지 않는다.**
 *
 * 새는 경로가 셋이라 셋을 각각 막는다.
 *
 * 1. **메타데이터** — 구조로 막는다. judge가 받는 타입(`StyleJudgeInput`)에는 `itemId`와
 *    `text`밖에 없고 `origin`을 담을 필드가 **아예 없다.** 주석으로 "넘기지 마라"라고 쓰면
 *    언젠가 누가 넘긴다. 필드가 없으면 넘길 수 없다.
 * 2. **순서** — 코퍼스는 종류별로 뭉쳐서 만들어진다(생성분 → 사람 글 → 대조군). 그대로 내면
 *    앞쪽 절반이 전부 AI라는 사실이 순서에 그대로 적혀 있는 것과 같다. 그래서 시드 셔플로
 *    섞는다. **시드 고정**이라 같은 코퍼스면 같은 배치가 나오고 리포트가 재현된다.
 * 3. **식별자** — `ITEM-01`처럼 내용과 무관한 번호를 셔플 **뒤에** 붙인다. 원본 id를 쓰면
 *    `CTL-04`가 대조군임을 판정자가 읽는다.
 *
 * 한 번에 한 편씩 판정한다(`judgeAll`). 여러 편을 한 요청에 넣으면 judge가 **서로 비교해서**
 * 답하게 되고, 그때 재는 것은 "이 글이 AI 같은가"가 아니라 "이 묶음에서 어느 쪽이 더 AI
 * 같은가"다. 후자는 §6이 요구한 판정이 아니다.
 */
import type { StyleOrigin, StylePiece } from "./corpus.js";
import type { StyleJudgeInput } from "./judge.js";

/** 고정 시드. 값 자체에 의미는 없고 **바뀌지 않는다는 것**에 의미가 있다. */
export const BLIND_SEED = "T-034-style-eval";

export interface BlindItem {
  /** judge에게 보이는 유일한 식별자. 내용·출처와 무관하다. */
  readonly itemId: string;
  readonly text: string;
  /** **러너만 안다.** `toJudgeInput`이 이 필드를 떨어뜨린다. */
  readonly origin: StyleOrigin;
  readonly sourceRef: string;
}

/**
 * 셔플 + 익명 번호. 셔플이 먼저이고 번호가 나중인 순서가 중요하다 —
 * 번호를 먼저 붙이면 `ITEM-01`이 언제나 첫 생성분이 되어 번호가 곧 출처가 된다.
 */
export function blindCorpus(pieces: readonly StylePiece[], seed: string = BLIND_SEED): BlindItem[] {
  return shuffle(pieces, seed).map((piece, index) => ({
    itemId: `ITEM-${String(index + 1).padStart(2, "0")}`,
    text: piece.text,
    origin: piece.origin,
    sourceRef: piece.sourceRef,
  }));
}

/** judge에게 넘길 것만 남긴다. **여기가 origin이 떨어지는 유일한 지점이다.** */
export function toJudgeInput(item: BlindItem): StyleJudgeInput {
  return { itemId: item.itemId, text: item.text };
}

/**
 * 결정론적 Fisher–Yates. `Math.random()`을 쓰지 않는 이유는 재현이다 —
 * 판별 정확도가 흔들렸을 때 배치가 달라진 탓인지 judge가 달라진 탓인지 갈라야 한다.
 */
export function shuffle<T>(items: readonly T[], seed: string): T[] {
  const out = [...items];
  const next = mulberry32(hashSeed(seed));
  for (let i = out.length - 1; i > 0; i -= 1) {
    const j = Math.floor(next() * (i + 1));
    const a = out[i];
    const b = out[j];
    // noUncheckedIndexedAccess 아래에서 인덱스 접근은 undefined일 수 있다. 범위 안이므로
    // 실제로는 일어나지 않지만, 단언(`!`)으로 지우는 대신 분기로 남긴다.
    if (a === undefined || b === undefined) continue;
    out[i] = b;
    out[j] = a;
  }
  return out;
}

/** FNV-1a 32비트. 문자열 시드 → 정수. */
export function hashSeed(seed: string): number {
  let hash = 0x811c9dc5;
  for (let i = 0; i < seed.length; i += 1) {
    hash ^= seed.charCodeAt(i);
    hash = Math.imul(hash, 0x01000193) >>> 0;
  }
  return hash >>> 0;
}

/** mulberry32. 짧고 결정론적이면 충분하다 — 암호 용도가 아니다. */
function mulberry32(seed: number): () => number {
  let state = seed >>> 0;
  return () => {
    state = (state + 0x6d2b79f5) >>> 0;
    let t = state;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4_294_967_296;
  };
}
