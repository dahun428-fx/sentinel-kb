/**
 * FakeEmbedder 결정론 검증 (specs/05 "결정론 원칙", T-006 Scope).
 *
 * 기대값은 구현이 아니라 **성질**로 박는다: 재현성, L2 노름 1, 서로 다른 텍스트 →
 * 서로 다른 벡터. 상수 벡터를 돌려주는 구현은 여기서 죽어야 한다.
 */
import { describe, expect, it } from "vitest";

import { createFakeEmbedder, deterministicVector } from "./fake.js";
import { createEmbedder } from "./index.js";

const DIM = 16;
const VERSION = 3;

const FAKE_ENV: NodeJS.ProcessEnv = {
  EMBEDDING_PROVIDER: "fake",
  EMBEDDING_DIM: String(DIM),
  EMBEDDING_VERSION: String(VERSION),
};

function l2(vector: number[]): number {
  return Math.sqrt(vector.reduce((sum, v) => sum + v * v, 0));
}

describe("FakeEmbedder", () => {
  it("같은 텍스트는 항상 같은 벡터를 낸다", async () => {
    const embedder = createFakeEmbedder({ dim: DIM, version: VERSION });

    const first = await embedder.embed(["nginx 502 게이트웨이 오류"]);
    const second = await embedder.embed(["nginx 502 게이트웨이 오류"]);

    expect(first[0]).toEqual(second[0]);
    // 리터럴 스냅샷이 아니라 재현성 자체가 계약이다 — 새 인스턴스도 같은 값을 내야 한다.
    const other = createFakeEmbedder({ dim: DIM, version: VERSION });
    expect((await other.embed(["nginx 502 게이트웨이 오류"]))[0]).toEqual(first[0]);
  });

  it("서로 다른 텍스트는 서로 다른 벡터를 낸다", async () => {
    const texts = Array.from({ length: 200 }, (_, i) => `사례 ${String(i)}: 장애 기록`);
    const embedder = createFakeEmbedder({ dim: DIM, version: VERSION });

    const vectors = await embedder.embed(texts);

    const distinct = new Set(vectors.map((v) => v.join(",")));
    expect(distinct.size).toBe(texts.length);
  });

  it("한 글자만 달라도 벡터가 달라진다", () => {
    const a = deterministicVector("timeout 30s", DIM);
    const b = deterministicVector("timeout 31s", DIM);

    expect(a).not.toEqual(b);
  });

  it("벡터는 L2 정규화되어 있다 (specs/02 vec_idx = cosine)", async () => {
    const embedder = createFakeEmbedder({ dim: DIM, version: VERSION });

    const vectors = await embedder.embed(["가", "나", "다", "라"]);

    for (const vector of vectors) {
      expect(l2(vector)).toBeCloseTo(1, 10);
    }
  });

  it("모든 성분이 0이 아니다 — 상수·영벡터 구현을 배제한다", () => {
    const vector = deterministicVector("샘플 텍스트", DIM);

    expect(new Set(vector).size).toBeGreaterThan(1);
  });

  it("dim이 반환 벡터 길이와 일치한다", async () => {
    const embedder = createFakeEmbedder({ dim: DIM, version: VERSION });

    const vectors = await embedder.embed(["하나", "둘"]);

    expect(embedder.dim).toBe(DIM);
    expect(vectors.map((v) => v.length)).toEqual([DIM, DIM]);
  });

  it("입력 순서를 보존하고, 빈 입력은 빈 배열이다", async () => {
    const embedder = createFakeEmbedder({ dim: DIM, version: VERSION });
    const texts = ["첫째", "둘째", "셋째"];

    const vectors = await embedder.embed(texts);

    expect(vectors).toHaveLength(3);
    for (const [index, text] of texts.entries()) {
      expect(vectors[index]).toEqual(deterministicVector(text, DIM));
    }
    await expect(embedder.embed([])).resolves.toEqual([]);
  });

  it("EMBEDDING_PROVIDER=fake 팩토리는 API 키 없이도 동작한다", async () => {
    const embedder = createEmbedder({ env: FAKE_ENV });

    const vectors = await embedder.embed(["키 없이도 임베딩된다"]);

    expect(embedder.dim).toBe(DIM);
    expect(embedder.version).toBe(VERSION);
    expect(vectors[0]).toHaveLength(DIM);
  });
});
