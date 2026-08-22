/**
 * RRF 융합과 recordId 다양성 제어. **순수 함수만 있다** — DB도 env도 모른다.
 * 출처: specs/03-rag-pipeline.md §2.
 *
 * ```
 * fused = RRF(A, B, k=RRF_K)          // score = Σ 1/(k + rank_i)
 * top   = dedupeByRecordId(fused).slice(0, RETRIEVAL_FINAL_K)
 * ```
 */

/** 융합·dedupe가 필요로 하는 최소 형상. 실제 후보는 이보다 많은 필드를 갖는다. */
export interface Rankable {
  /** 청크의 안정 식별자(hex). 두 경로의 같은 청크를 겹치는 기준이다. */
  readonly chunkId: string;
  /** 소속 record의 안정 식별자(hex). dedupe 기준이다. */
  readonly recordId: string;
}

/** 융합 결과 1건. 어느 경로가 몇 위로 기여했는지 남긴다 — eval(T-013)이 이 값을 본다. */
export interface FusedEntry<Candidate extends Rankable> {
  readonly candidate: Candidate;
  /** `Σ 1/(k + rank)`. **순위 결정 전용**이며 cosine 임계값과 비교할 수 없다 (감사 B-1). */
  readonly score: number;
  /** 1-based. 그 경로에 없었으면 null. */
  readonly vectorRank: number | null;
  readonly textRank: number | null;
}

/**
 * Reciprocal Rank Fusion. 두 랭킹의 **순위만** 쓰고 원시 점수는 쓰지 않는다 —
 * cosine(0–1)과 BM25(무제한)는 척도가 달라 직접 더할 수 없기 때문이다.
 *
 * 한쪽 리스트가 비어도 동작한다. `lucene.standard`가 한국어 서술형을 못 잡아
 * 텍스트 경로가 0건이 되는 것은 **정상 경로**다 (T-010 F-6).
 *
 * 동점 처리: 두 경로 모두에서 같은 순위 조합이면 float 값이 정확히 같아진다.
 * 정렬이 불안정하면 같은 입력이 호출마다 다른 순서를 내므로 (a) 더 좋은 순위,
 * (b) chunkId 사전순으로 결정론을 강제한다.
 */
export function fuseRrf<Candidate extends Rankable>(
  vector: readonly Candidate[],
  text: readonly Candidate[],
  rrfK: number,
): FusedEntry<Candidate>[] {
  const merged = new Map<
    string,
    { candidate: Candidate; score: number; vectorRank: number | null; textRank: number | null }
  >();

  const absorb = (list: readonly Candidate[], path: "vector" | "text"): void => {
    list.forEach((candidate, index) => {
      const rank = index + 1;
      const existing = merged.get(candidate.chunkId) ?? {
        candidate,
        score: 0,
        vectorRank: null,
        textRank: null,
      };
      merged.set(candidate.chunkId, {
        candidate: existing.candidate,
        score: existing.score + 1 / (rrfK + rank),
        vectorRank: path === "vector" ? rank : existing.vectorRank,
        textRank: path === "text" ? rank : existing.textRank,
      });
    });
  };

  absorb(vector, "vector");
  absorb(text, "text");

  return [...merged.values()]
    .map((entry) => ({
      candidate: entry.candidate,
      score: entry.score,
      vectorRank: entry.vectorRank,
      textRank: entry.textRank,
    }))
    .sort((a, b) => {
      if (b.score !== a.score) return b.score - a.score;
      const bestA = bestRank(a);
      const bestB = bestRank(b);
      if (bestA !== bestB) return bestA - bestB;
      return a.candidate.chunkId.localeCompare(b.candidate.chunkId);
    });
}

function bestRank(entry: { vectorRank: number | null; textRank: number | null }): number {
  const ranks = [entry.vectorRank, entry.textRank].filter((r): r is number => r !== null);
  return ranks.length === 0 ? Number.POSITIVE_INFINITY : Math.min(...ranks);
}

/**
 * record당 최대 `maxPerRecord`개만 남긴다. 입력 순서를 보존하며, 초과분은 버린다.
 *
 * specs/03 §2의 `dedupeByRecordId`(record당 최대 2청크)를 그대로 구현한다.
 * 목적은 "같은 record의 여러 섹션이 상위를 점유하지 않도록"이다.
 */
export function dedupeByRecordId<Item extends { readonly recordId: string }>(
  items: readonly Item[],
  maxPerRecord: number,
): Item[] {
  const seen = new Map<string, number>();
  const kept: Item[] = [];

  for (const item of items) {
    const used = seen.get(item.recordId) ?? 0;
    if (used >= maxPerRecord) continue;
    seen.set(item.recordId, used + 1);
    kept.push(item);
  }

  return kept;
}

/**
 * **후보 단계** recordId 다양성 확보. T-005 F-3이 지목한 재현율 붕괴 경로의 해소 지점이다.
 *
 * 문제: 레코드 1건이 청크 28개까지 간다. `$vectorSearch(limit=20)` 후보 리스트가
 * **dedupe 이전**이므로 그 레코드 하나가 20슬롯을 통째로 먹으면 융합 후 dedupe를 거쳐
 * 최종 결과에 레코드가 **1건만** 남는다.
 *
 * 해법(둘 다 쓴다):
 *  1. 후보를 K의 `candidateOverfetch`배로 긁어온다 — 상한을 걸 여유분을 만든다.
 *  2. 여기서 record당 `maxPerRecord`로 자르고 K개로 되자른다.
 *
 * **왜 손실이 없는가**: 후보 상한은 융합 후 dedupe와 **같은 값**을 쓴다. 따라서 여기서
 * 버려지는 청크는 어차피 dedupe가 버렸을 청크들이며, 그 자리를 다른 레코드가 채운다.
 * (chunker에 청크 수 상한을 두는 안은 채택하지 않았다 — 스펙 근거가 없고 지식을 조용히 버린다.)
 */
export function capByRecordId<Item extends { readonly recordId: string }>(
  items: readonly Item[],
  maxPerRecord: number,
  limit: number,
): Item[] {
  return dedupeByRecordId(items, maxPerRecord).slice(0, limit);
}
