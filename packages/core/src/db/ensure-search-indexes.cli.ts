/**
 * `pnpm db:search-indexes` 진입점 — Atlas 검색 인덱스(`vec_idx`, `text_idx`)를 멱등하게
 * 적용하고 READY가 될 때까지 기다린다. 출처: specs/02 §인덱스, T-010.
 *
 * **`pnpm db:indexes`와의 관계**: 서로 다른 인덱스 시스템이고 **실행 순서 의존이 없다.**
 * - `db:indexes` → 일반 B-tree 인덱스(`createIndex`). 어떤 mongod에서도 돈다.
 * - `db:search-indexes` → mongot 검색 인덱스(`createSearchIndex`). **Atlas 또는
 *   `mongodb/mongodb-atlas-local`에서만 돈다.** 평범한 mongod면 `SEARCH_INDEX_UNSUPPORTED`.
 * 이 스크립트는 대상 컬렉션이 없으면 직접 만들기 때문에 `db:indexes`가 먼저 돌 필요가 없다.
 *
 * **배포 절차상의 위치는 아직 스펙에 없다.** `specs/06-deployment.md`는 인덱스 부트스트랩을
 * 한 글자도 언급하지 않는다 — 여기에 "배포에서는 이렇게 돌린다"고 적으면 코드 주석이 없는
 * 계약을 발명하는 셈이다. 이 스크립트가 기본 300초까지 블로킹하고 Atlas·atlas-local에서만
 * 도는 이상, compose up 이전인지 이후인지가 첫 검색 성공 여부를 가른다.
 * → specs/06에 단계 신설이 필요하다 (T-010 Findings, 인간 비준 대기).
 *
 * 라이브러리는 process.exit을 부르지 않는다 — 종료 판단은 호출자인 여기의 몫이다(T-003 규약).
 */
import { closeDb, DbConnectionError, getDb } from "./client.js";
import {
  buildSearchIndexPlans,
  ensureSearchIndexes,
  readSearchIndexWaitConfig,
  SearchIndexError,
  waitForSearchIndexesReady,
} from "./search-indexes.js";
import { readEmbeddingDim } from "../embedder/config.js";
import { EmbedderError } from "../embedder/types.js";

const EXIT_CONFIG_ERROR = 78; // EX_CONFIG (sysexits.h) — env 오설정
const EXIT_UNAVAILABLE = 69; // EX_UNAVAILABLE (sysexits.h) — DB에 닿지 못함
const EXIT_FAILURE = 1;

async function main(): Promise<void> {
  // env는 DB에 붙기 전에 읽는다 — 오설정을 확인하려고 클러스터까지 갈 이유가 없다.
  const dim = readEmbeddingDim();
  const wait = readSearchIndexWaitConfig();
  const plans = buildSearchIndexPlans(dim);

  const db = await getDb();
  const results = await ensureSearchIndexes(db, { dim });
  for (const result of results) {
    console.log(`[db:search-indexes] ${result.collection}.${result.name} (${result.type}) — ${result.action}`);
  }

  console.log(
    `[db:search-indexes] READY 대기 중 (timeout=${wait.readyTimeoutMs}ms, interval=${wait.pollIntervalMs}ms)`,
  );
  await waitForSearchIndexesReady(db, plans);
  console.log(`[db:search-indexes] ${results.length}개 검색 인덱스 READY (dim=${dim})`);
}

try {
  await main();
} catch (error) {
  if (error instanceof DbConnectionError) {
    console.error(`[db:search-indexes] ${error.code}: ${error.message}`);
    process.exitCode =
      error.code === "DB_CONNECTION_FAILED" ? EXIT_UNAVAILABLE : EXIT_CONFIG_ERROR;
  } else if (error instanceof EmbedderError) {
    // EMBEDDING_DIM 미설정·비정상 — 재시도해도 소용없는 설정 실수다.
    console.error(`[db:search-indexes] ${error.code}: ${error.message}`);
    process.exitCode = EXIT_CONFIG_ERROR;
  } else if (error instanceof SearchIndexError) {
    console.error(`[db:search-indexes] ${error.code}: ${error.message}`);
    // DIM_MISMATCH·DEFINITION_INVALID는 설정/정의 문제, 나머지는 실행 실패로 나눈다.
    process.exitCode =
      error.code === "SEARCH_INDEX_DIM_MISMATCH" ||
      error.code === "SEARCH_INDEX_DEFINITION_INVALID"
        ? EXIT_CONFIG_ERROR
        : EXIT_FAILURE;
  } else {
    console.error("[db:search-indexes] SEARCH_INDEX_CREATION_FAILED:", error);
    process.exitCode = EXIT_FAILURE;
  }
} finally {
  await closeDb();
}
