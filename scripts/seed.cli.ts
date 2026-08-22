/**
 * `pnpm db:seed` 진입점 (T-009, FR-10).
 *
 * 컴포지션 루트다 — env를 읽는 유일한 지점이고, 적재 로직은 `seed.ts`가 전부 갖는다.
 * `ensure-indexes.cli.ts`와 같은 규약을 따른다: 라이브러리는 process.exit을 부르지 않고,
 * 종료 판단과 종료 코드는 여기서만 정한다.
 *
 * 사용법:
 *   pnpm db:seed                          # 멱등 적재 (이미 있는 시드는 건너뛴다)
 *   pnpm db:seed --reset                  # 시드가 만든 레코드만 지우고 다시 넣는다
 *   pnpm db:seed --project=<slug>         # 다른 project로 적재
 *   pnpm db:seed --allow-fake-embeddings  # fake embedder 승인 (검색 품질 검증 불가)
 *
 * 인덱스는 만들지 않는다 — `pnpm db:indexes`가 그 일을 한다. 시드 전에 한 번 돌려라.
 */
// `parseApiKeys`는 T-037에서 `@sentinel/api` → `@sentinel/core`로 올라갔다(T-014 F-1 회수).
import {
  readSanitizeOptions,
  createEmbedder,
  parseApiKeys,
  readEmbedderConfig,
} from "@sentinel/core";
import { closeDb, DbConnectionError, getDb } from "@sentinel/core/db";

import {
  loadSeedRecords,
  parseSeedArgs,
  resolveSeedApiKey,
  runSeed,
  SEED_ERROR_CODES,
  SeedError,
} from "./seed.js";

const EXIT_CONFIG_ERROR = 78; // EX_CONFIG (sysexits.h) — env·인자 오설정
const EXIT_UNAVAILABLE = 69; // EX_UNAVAILABLE (sysexits.h) — DB에 닿지 못함
const EXIT_FAILURE = 1;

/** 인자·env 오설정. 종료 코드를 EX_CONFIG로 가르기 위한 표식이다. */
class SeedConfigError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "SeedConfigError";
  }
}

/**
 * 설정 해석 단계의 실패를 EX_CONFIG로 분류한다.
 * 오타난 인자나 빠진 API_KEYS는 "시드가 실패했다"가 아니라 "설정이 틀렸다"이고,
 * 종료 코드가 그 둘을 구분해야 자동화(런북·CI)가 재시도할지 사람을 부를지 가를 수 있다.
 */
function asConfig<T>(read: () => T): T {
  try {
    return read();
  } catch (error) {
    throw new SeedConfigError(error instanceof Error ? error.message : String(error));
  }
}

async function main(): Promise<void> {
  const args = asConfig(() => parseSeedArgs(process.argv.slice(2)));
  const apiKeys = asConfig(() => parseApiKeys(process.env["API_KEYS"]));
  const apiKey = asConfig(() => resolveSeedApiKey(apiKeys, args.project));
  // `asConfig()` 밖에 두면 env 오설정이 EX_CONFIG(78)이 아니라 일반 exit 1로 나간다 —
  // CLI가 스스로 선언한 "설정 오류는 78, 자동화가 재시도할지 사람을 부를지 가른다"는 계약이 깨진다.
  const sanitizeOptions = asConfig(() => readSanitizeOptions());

  /**
   * **fake embedder로 운영 시드를 넣지 않는다.**
   * fake 벡터는 서로 다른 텍스트 간 cosine이 0 근처라 `SIMILARITY_THRESHOLD` 게이트가 항상
   * `found:false`를 낸다(T-006 F-8, 시드 INC-18). 그 상태로 적재된 데이터는 T-013의
   * retrieval eval을 무의미하게 만든다. 통합 테스트는 `runSeed`를 직접 부르며 fake를 쓰고,
   * 거기서 검증하는 것은 청크 생성·멱등성이지 유사도 값이 아니라 문제가 없다.
   */
  const { provider } = asConfig(() => readEmbedderConfig(process.env));
  if (provider === "fake" && !args.allowFakeEmbeddings) {
    throw new SeedConfigError(
      "EMBEDDING_PROVIDER=fake로는 시드를 적재하지 않는다. fake 벡터는 서로 다른 텍스트 간 " +
        "cosine이 0 근처라 유사도 임계값 게이트가 모든 질의에 found:false를 낸다. " +
        "운영·eval 시드는 실제 임베딩 provider로 넣어라. 그래도 진행하려면 --allow-fake-embeddings.",
    );
  }
  const embedder = asConfig(() => createEmbedder());
  if (provider === "fake") {
    console.warn(
      "[db:seed] 경고: fake embedder로 적재한다. 이 데이터로는 검색 품질을 측정할 수 없다.",
    );
  }

  const records = await loadSeedRecords();
  console.log(
    `[db:seed] 시드 ${String(records.length)}건 로드 완료 ` +
      `(project=${args.project}, provider=${provider}, reset=${String(args.reset)})`,
  );

  const db = await getDb();
  const result = await runSeed({
    db,
    project: args.project,
    apiKey,
    apiKeys,
    sanitizeOptions,
    embedder,
    records,
    reset: args.reset,
    log: (line) => {
      console.log(line);
    },
  });

  if (result.failedJobs.length > 0) {
    // 청크가 없는 레코드는 검색되지 않는다 — 조용히 성공으로 끝내면 안 된다.
    throw new SeedError(
      SEED_ERROR_CODES.EMBED_JOB_FAILED,
      `임베딩 잡 ${String(result.failedJobs.length)}건이 done으로 끝나지 않았다: ` +
        result.failedJobs
          .map((job) => `${job.recordId}=${job.status}(${job.error ?? "no error"})`)
          .join(", "),
    );
  }
  console.log(
    `[db:seed] 완료 — 삽입 ${String(result.inserted)}, 건너뜀 ${String(result.skipped)}, ` +
      `삭제 ${String(result.deletedRecords)}, 임베딩 ${String(result.embeddedJobs)}`,
  );
}

try {
  await main();
} catch (error) {
  if (error instanceof DbConnectionError) {
    console.error(`[db:seed] ${error.code}: ${error.message}`);
    process.exitCode =
      error.code === "DB_CONNECTION_FAILED" ? EXIT_UNAVAILABLE : EXIT_CONFIG_ERROR;
  } else if (error instanceof SeedConfigError) {
    console.error(`[db:seed] SEED_CONFIG_INVALID: ${error.message}`);
    process.exitCode = EXIT_CONFIG_ERROR;
  } else if (error instanceof SeedError) {
    console.error(`[db:seed] ${error.code}: ${error.message}`);
    process.exitCode = EXIT_FAILURE;
  } else {
    console.error("[db:seed] SEED_FAILED:", error);
    process.exitCode = EXIT_FAILURE;
  }
} finally {
  await closeDb();
}
