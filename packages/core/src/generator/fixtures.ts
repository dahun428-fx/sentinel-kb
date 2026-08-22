/**
 * 테스트 픽스처 빌더. 출처: specs/05 결정론 원칙.
 *
 * `RetrievedChunk`는 필드가 15개라 각 테스트가 통째로 쓰면 무엇이 관심사인지 안 보인다.
 * 기본값을 여기 모으고 테스트는 **관심 필드만** 덮어쓴다.
 *
 * ⚠️ `*.spec.ts`가 아니라 일반 모듈인 이유: 여러 spec이 공유하고, `import`는 spec 간에
 * 열려 있어야 한다. 배럴에서는 export하지 않는다 — 프로덕션 표면이 아니다.
 */
import type { RetrievedChunk } from "../retriever/types.js";
import type { RetrievalResult } from "../retriever/types.js";

export function makeChunk(overrides: Partial<RetrievedChunk> = {}): RetrievedChunk {
  return {
    chunkId: "chunk-1",
    recordId: "rec-1",
    section: "resolution",
    seq: 0,
    text: "커넥션 풀 상한을 20으로 올리고 애플리케이션을 재시작했다.",
    title: "커넥션 풀 고갈",
    summary: "요약",
    type: "incident",
    project: "sentinel-kb",
    flags: [],
    fusedScore: 0.032,
    vectorScore: 0.81,
    textScore: null,
    vectorRank: 0,
    textRank: null,
    ...overrides,
  };
}

export function makeRetrieval(overrides: Partial<RetrievalResult> = {}): RetrievalResult {
  const hits = overrides.hits ?? [makeChunk()];
  return {
    hits,
    maxVectorScore: 0.81,
    vectorCandidateCount: hits.length,
    textCandidateCount: 0,
    ...overrides,
  };
}
