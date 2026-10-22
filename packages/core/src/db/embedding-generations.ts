/**
 * 임베딩 세대 장부 (T-053, P1 리뷰 C1).
 *
 * `embeddingVersion`은 사람이 올리는 숫자다. provider나 모델을 바꾸고 버전을 그대로 두면 서로 다른 벡터
 * 공간이 같은 버전으로 섞이고, 질의 벡터와 문서 벡터의 cosine이 0 근처가 되어 검색이 **에러 없이**
 * `found:false`를 낸다. UPLIFT P3(fake) → P4(Voyage) 전환이 정확히 그 경로다.
 *
 * 그래서 버전마다 "어느 임베더가 이 세대를 만드는가"를 한 줄 남기고, 임베딩을 쓰는 프로세스(worker,
 * core-api)가 기동할 때 자기 설정과 대조한다. 다르면 기동하지 않는다.
 *
 * 청크 스키마(contracts `.strict()`)를 바꾸지 않으려고 별도 컬렉션에 둔다. 청크마다 적을 필요도 없다 —
 * 세대 안의 청크는 정의상 같은 임베더가 만든다.
 */
import type { Db } from "mongodb";

export const EMBEDDING_GENERATIONS_COLLECTION = "embedding_generations";

export interface EmbeddingGenerationDocument {
  /** `embeddingVersion`. */
  readonly _id: number;
  /** `readEmbeddingIdentity()` 값. 예: `voyage/voyage-3/dim=1024/input-type`. */
  readonly identity: string;
  readonly createdAt: Date;
}

export class EmbeddingGenerationMismatchError extends Error {
  readonly code = "EMBEDDING_GENERATION_MISMATCH";

  constructor(message: string) {
    super(message);
    this.name = "EmbeddingGenerationMismatchError";
  }
}

const DUPLICATE_KEY_ERROR = 11_000;

function isDuplicateKeyError(error: unknown): boolean {
  return (
    typeof error === "object" &&
    error !== null &&
    (error as { code?: unknown }).code === DUPLICATE_KEY_ERROR
  );
}

export interface ClaimEmbeddingGenerationInput {
  readonly version: number;
  readonly identity: string;
  readonly now: Date;
}

/**
 * 이 프로세스의 임베더가 `version` 세대를 써도 되는지 확인하고, 처음이면 장부에 남긴다.
 *
 * - 장부에 같은 identity가 있으면 통과.
 * - 다른 identity가 있으면 `EmbeddingGenerationMismatchError`.
 * - 장부가 비었는데 그 버전의 청크가 이미 있으면 **출처를 모르는 벡터**다. 같은 임베더라고 가정하지 않고 거부한다.
 * - 장부도 청크도 없으면 기록하고 통과. 두 프로세스가 동시에 기록하면 한쪽이 키 충돌로 지고, 진 쪽은 다시 읽어 대조한다.
 */
export async function claimEmbeddingGeneration(
  db: Db,
  input: ClaimEmbeddingGenerationInput,
): Promise<"claimed" | "matched"> {
  const generations = db.collection<EmbeddingGenerationDocument>(EMBEDDING_GENERATIONS_COLLECTION);

  const existing = await generations.findOne({ _id: input.version });
  if (existing !== null) {
    assertSameIdentity(existing, input);
    return "matched";
  }

  const orphanChunk = await db
    .collection("chunks")
    .findOne({ embeddingVersion: input.version }, { projection: { _id: 1 } });
  if (orphanChunk !== null) {
    throw new EmbeddingGenerationMismatchError(
      `embeddingVersion=${String(input.version)}의 청크가 있지만 어느 임베더가 만들었는지 기록이 없다. ` +
        `지금 설정(${input.identity})과 같은 공간이라는 보장이 없어 기동하지 않는다. ` +
        "EMBEDDING_VERSION을 올리고 재임베딩(`pnpm --filter @sentinel/worker reembed`)하거나, 로컬이면 DB를 비운다(docs/local-run.md §5).",
    );
  }

  try {
    await generations.insertOne({ _id: input.version, identity: input.identity, createdAt: input.now });
    return "claimed";
  } catch (error) {
    if (!isDuplicateKeyError(error)) throw error;
    const winner = await generations.findOne({ _id: input.version });
    if (winner === null) throw error;
    assertSameIdentity(winner, input);
    return "matched";
  }
}

function assertSameIdentity(
  recorded: EmbeddingGenerationDocument,
  input: ClaimEmbeddingGenerationInput,
): void {
  if (recorded.identity === input.identity) return;
  throw new EmbeddingGenerationMismatchError(
    `embeddingVersion=${String(input.version)}은 ${recorded.identity}로 만든 세대인데 지금 설정은 ${input.identity}다. ` +
      "다른 벡터 공간이 섞이면 검색이 에러 없이 실패한다. EMBEDDING_VERSION을 올리고 재임베딩하라.",
  );
}
