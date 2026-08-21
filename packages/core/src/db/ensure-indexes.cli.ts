/**
 * `pnpm db:indexes` 진입점 — 일반 인덱스를 멱등하게 생성한다.
 *
 * 라이브러리(client.ts)는 process.exit을 부르지 않는다. 종료 판단은 여기,
 * 즉 호출자의 몫이다. 실패 시 원인 코드를 stderr에 찍고 non-zero로 죽는다 (T-003 Acceptance 2).
 *
 * src에 두는 이유: packages/core의 tsconfig `include`가 `src`뿐이라
 * scripts/에 두면 `pnpm typecheck`가 이 파일을 검사하지 않는다 — 타입 구멍이 생긴다.
 */
import { closeDb, DbConnectionError, getDb } from "./client.js";
import { ensureIndexes } from "./indexes.js";

const EXIT_CONFIG_ERROR = 78; // EX_CONFIG (sysexits.h) — env 오설정
const EXIT_UNAVAILABLE = 69; // EX_UNAVAILABLE (sysexits.h) — DB에 닿지 못함
const EXIT_FAILURE = 1;

async function main(): Promise<void> {
  const db = await getDb();
  const names = await ensureIndexes(db);
  console.log(`[db:indexes] ${names.length}개 인덱스 확인 완료`);
  for (const name of names) console.log(`  - ${name}`);
}

function exitCodeFor(error: DbConnectionError): number {
  return error.code === "DB_CONNECTION_FAILED" ? EXIT_UNAVAILABLE : EXIT_CONFIG_ERROR;
}

try {
  await main();
} catch (error) {
  if (error instanceof DbConnectionError) {
    console.error(`[db:indexes] ${error.code}: ${error.message}`);
    process.exitCode = exitCodeFor(error);
  } else {
    console.error("[db:indexes] INDEX_CREATION_FAILED:", error);
    process.exitCode = EXIT_FAILURE;
  }
} finally {
  await closeDb();
}
