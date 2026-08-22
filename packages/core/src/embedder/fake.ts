/**
 * 테스트·시드용 결정론적 embedder. 출처: specs/05 "결정론 원칙 — LLM·임베딩 호출은
 * 인터페이스로 격리하고 unit/integration에서는 fixture 목을 쓴다".
 *
 * 규칙 셋:
 * 1. **랜덤·시간 금지.** 같은 텍스트는 프로세스·머신을 넘어 항상 같은 벡터를 낸다.
 *    안 그러면 검색 테스트가 실행마다 다른 순위를 뱉는다.
 * 2. **L2 정규화.** specs/02가 `vec_idx`를 cosine으로 정의한다. 정규화된 벡터에서만
 *    내적이 곧 cosine이고, 임계값(SIMILARITY_THRESHOLD)이 의미를 갖는다.
 * 3. **서로 다른 텍스트는 서로 다른 벡터.** 상수 벡터를 돌려주면 모든 후보가 동점이 되어
 *    retrieval eval이 아무것도 측정하지 못한다.
 */
import type { Embedder } from "./types.js";

/** FNV-1a 32비트 오프셋 베이시스. */
const FNV_OFFSET_BASIS = 0x811c9dc5;

/** FNV-1a 32비트 프라임. */
const FNV_PRIME = 0x01000193;

/**
 * FNV-1a. 코드포인트 단위로 돌려 서로게이트 페어(이모지)도 안정적으로 섞는다.
 * 암호학적 용도가 아니라 **분산 좋은 시드**가 목적이다.
 */
function fnv1a32(text: string): number {
  let hash = FNV_OFFSET_BASIS;
  for (const char of text) {
    hash ^= char.codePointAt(0) ?? 0;
    hash = Math.imul(hash, FNV_PRIME);
  }
  return hash >>> 0;
}

/** mulberry32 — 시드 하나로 재현 가능한 난수열을 만드는 최소 PRNG. */
function mulberry32(seed: number): () => number {
  let state = seed >>> 0;
  return () => {
    state = (state + 0x6d2b79f5) >>> 0;
    let t = state;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** 텍스트 하나 → L2 노름 1의 결정론적 벡터. */
export function deterministicVector(text: string, dim: number): number[] {
  const next = mulberry32(fnv1a32(text));
  const vector = Array.from({ length: dim }, () => next() * 2 - 1);

  const norm = Math.sqrt(vector.reduce((sum, v) => sum + v * v, 0));
  if (norm === 0) {
    // 이론적으로만 가능한 전(全)0 벡터. cosine이 정의되지 않으므로 축 하나로 대체한다.
    const fallback = new Array<number>(dim).fill(0);
    if (dim > 0) fallback[0] = 1;
    return fallback;
  }
  return vector.map((v) => v / norm);
}

export interface FakeEmbedderOptions {
  readonly dim: number;
  readonly version: number;
}

/**
 * HTTP를 타지 않는 embedder. `Embedder`를 그대로 만족하므로 워커·retriever는
 * 진짜 provider와의 차이를 알지 못한다 — 그게 격리의 목적이다.
 */
export function createFakeEmbedder(options: FakeEmbedderOptions): Embedder {
  const { dim, version } = options;
  return {
    dim,
    version,
    embed(texts: string[]): Promise<number[][]> {
      return Promise.resolve(texts.map((text) => deterministicVector(text, dim)));
    },
  };
}
