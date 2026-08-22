/**
 * 시드 적재 라이브러리 (T-009, FR-10). 프로세스 진입점은 `seed.cli.ts`다.
 *
 * ## 왜 이 파일이 루트 `scripts/`에 있고 `packages/core/seed/`에 없는가
 * 태스크 Acceptance 2가 "chunks 생성 완료(**워커 대기 후** 검증)"를 요구한다. 그러려면
 * `@sentinel/worker`의 `runOnce()`로 큐를 드레인해야 하는데, **`@sentinel/core`는 worker를
 * import할 수 없다** — specs/01의 의존 방향(web/mcp/api/worker → core → contracts)을 정면으로
 * 역행하고 eslint의 `import/no-restricted-paths`가 실제로 막는다. 루트 스크립트는 어느 패키지도
 * 아니므로 api·worker를 함께 소비해도 그 방향을 깨지 않는다.
 * **시드 데이터(JSON)는 그대로 `packages/core/seed/`에 남는다** — 데이터는 core의 자산이고,
 * 이 파일은 그것을 읽어 적재하는 소비자일 뿐이다.
 *
 * ## 왜 DB 직접 삽입이 아니라 HTTP API를 거치는가
 * `POST /v1/records`를 타면 새니타이즈 게이트·`summary` 생성·`sanitizeFlags` 판정·
 * `embeddingVersion=0` 초기화·embed job 삽입이 전부 따라온다. 직접 삽입하면 그 전부를
 * 재구현해야 하고, 재구현한 순간부터 T-007과 드리프트가 시작된다.
 * 무엇보다 **시드가 실제 API 계약을 통과한다는 사실 자체가 계약 적합성 검증**이다.
 * 실제 서버를 띄우지 않고 `app.inject()`로 in-process 호출한다 — CI에서 포트 충돌이 없다.
 */
import { readdir, readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { createApp } from "@sentinel/api";
import { CreateRecordInput } from "@sentinel/contracts";
import { VERSION, type Embedder, type ResolvedSanitizeOptions } from "@sentinel/core";
import { createEmbedWorker, type JobOutcome } from "@sentinel/worker";
import type { Db, ObjectId } from "mongodb";

/** 시드 JSON이 사는 곳. 이 파일 기준 `<repo>/packages/core/seed`. */
export const DEFAULT_SEED_DIR = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "..",
  "packages",
  "core",
  "seed",
);

/** 시드 CLI가 기본으로 쓰는 project 슬러그. `--project=<slug>`로 바꾼다. */
export const DEFAULT_SEED_PROJECT = "sentinel-kb";

export const SEED_ERROR_CODES = {
  /** 시드 JSON이 `CreateRecordInput`을 만족하지 않는다. */
  INVALID_SEED_RECORD: "SEED_INVALID_RECORD",
  /** 같은 title을 가진 시드 파일이 둘 이상이다 — 멱등 키가 무너진다. */
  DUPLICATE_SEED_TITLE: "SEED_DUPLICATE_TITLE",
  /** API가 201이 아닌 응답을 냈다. */
  CREATE_FAILED: "SEED_CREATE_FAILED",
  /** 새니타이저가 title을 고쳐 멱등 키가 어긋났다. */
  TITLE_REWRITTEN: "SEED_TITLE_REWRITTEN",
  /** 임베딩 잡이 done으로 끝나지 않았다 — 청크 없는 레코드가 남는다. */
  EMBED_JOB_FAILED: "SEED_EMBED_JOB_FAILED",
  /** 큐 드레인이 상한을 넘겼다 — 무한 루프 방어. */
  DRAIN_LIMIT: "SEED_DRAIN_LIMIT",
} as const;
export type SeedErrorCode = (typeof SEED_ERROR_CODES)[keyof typeof SEED_ERROR_CODES];

export class SeedError extends Error {
  readonly code: SeedErrorCode;

  constructor(code: SeedErrorCode, message: string) {
    super(message);
    this.name = "SeedError";
    this.code = code;
  }
}

/** 파일 하나에서 읽어 계약으로 파싱한 시드 1건. */
export interface SeedRecord {
  /** 시드 디렉토리 기준 상대 경로. 오류 메시지가 파일을 특정할 수 있어야 한다. */
  readonly source: string;
  readonly input: CreateRecordInput;
}

// ---------------------------------------------------------------- 로딩

/** `.json`만 재귀 수집한다. 정렬해 적재 순서를 결정론적으로 만든다. */
async function collectJsonFiles(dir: string, prefix = ""): Promise<string[]> {
  const entries = await readdir(dir, { withFileTypes: true });
  const files: string[] = [];
  for (const entry of [...entries].sort((a, b) => a.name.localeCompare(b.name))) {
    const relative = prefix === "" ? entry.name : `${prefix}/${entry.name}`;
    if (entry.isDirectory()) {
      files.push(...(await collectJsonFiles(path.join(dir, entry.name), relative)));
    } else if (entry.isFile() && entry.name.endsWith(".json")) {
      files.push(relative);
    }
  }
  return files;
}

/**
 * 시드 디렉토리 전체를 읽어 `CreateRecordInput`으로 파싱한다.
 *
 * **여기서 파싱하는 것이 계약 적합성의 유일한 보증이다.** 시드 JSON에 `project`나 서버 생성
 * 필드(`summary`·`sanitizeFlags`·`status` 이외의 것)가 섞여 있으면 `.strict()`가 여기서 잡는다.
 * 파싱을 미루고 API에 그냥 던지면 400의 원인이 어느 파일인지 알 수 없다.
 */
export async function loadSeedRecords(seedDir: string = DEFAULT_SEED_DIR): Promise<SeedRecord[]> {
  const files = await collectJsonFiles(seedDir);
  const records: SeedRecord[] = [];
  const seenTitles = new Map<string, string>();

  for (const source of files) {
    // BOM은 JSON 규격이 허용하지 않는데 편집기가 붙일 수 있다. 벗겨 내고 파싱한다.
    const text = (await readFile(path.join(seedDir, source), "utf8")).replace(/^\uFEFF/, "");
    let raw: unknown;
    try {
      raw = JSON.parse(text);
    } catch (error) {
      throw new SeedError(
        SEED_ERROR_CODES.INVALID_SEED_RECORD,
        `${source}: JSON 파싱 실패 — ${error instanceof Error ? error.message : String(error)}`,
      );
    }

    const parsed = CreateRecordInput.safeParse(raw);
    if (!parsed.success) {
      throw new SeedError(
        SEED_ERROR_CODES.INVALID_SEED_RECORD,
        `${source}: CreateRecordInput을 만족하지 않는다 — ${JSON.stringify(parsed.error.issues)}`,
      );
    }

    const previous = seenTitles.get(parsed.data.title);
    if (previous !== undefined) {
      // title이 멱등 키다. 두 파일이 같은 title을 가지면 한쪽이 영원히 적재되지 않는다.
      throw new SeedError(
        SEED_ERROR_CODES.DUPLICATE_SEED_TITLE,
        `title이 중복된다: ${source} 와 ${previous} — title은 시드의 멱등 키다.`,
      );
    }
    seenTitles.set(parsed.data.title, source);
    records.push({ source, input: parsed.data });
  }

  return records;
}

// ---------------------------------------------------------------- 적재

/** records 컬렉션에서 시드 식별에 쓰는 최소 형상. */
interface SeedRecordProjection {
  readonly _id: ObjectId;
  readonly title: string;
}

export interface SeedOptions {
  readonly db: Db;
  /** 적재 대상 project. 레코드의 `project`는 인증 키에서 주입되므로 키와 짝이 맞아야 한다. */
  readonly project: string;
  /** `Authorization: Bearer <key>`에 실릴 키. `apiKeys`에서 `project`로 해석되는 값이어야 한다. */
  readonly apiKey: string;
  readonly apiKeys: ReadonlyMap<string, string>;
  readonly sanitizeOptions: ResolvedSanitizeOptions;
  /**
   * 인제스트에 쓸 embedder.
   *
   * **운영 시드는 실제 provider여야 한다.** fake embedder는 텍스트 해시 기반 의사난수 벡터라
   * 서로 다른 텍스트 간 cosine이 0 근처이고, `SIMILARITY_THRESHOLD` 게이트가 항상
   * `found:false`를 낸다(T-006 F-8, 시드 INC-18). 통합 테스트는 fake로 충분하다 —
   * 거기서 검증하는 것은 청크 생성·멱등성이지 유사도 값이 아니기 때문이다.
   * CLI는 `--allow-fake-embeddings` 없이는 fake로 돌지 않는다(`seed.cli.ts`).
   */
  readonly embedder: Embedder;
  readonly records: readonly SeedRecord[];
  /** 시드가 만든 레코드만 지우고 다시 넣는다. 컬렉션 전체를 지우지 않는다. */
  readonly reset?: boolean;
  readonly now?: () => Date;
  readonly log?: (line: string) => void;
}

export interface SeedResult {
  readonly inserted: number;
  /** 이미 있어서 건너뛴 수. 2회차 실행에서는 이 값이 전체 수와 같다. */
  readonly skipped: number;
  /** `--reset`이 지운 레코드 수. */
  readonly deletedRecords: number;
  /** 드레인에서 `done`으로 끝난 잡 수. */
  readonly embeddedJobs: number;
  /** `done`이 아닌 상태로 끝난 잡. 비어 있지 않으면 실패다. */
  readonly failedJobs: readonly JobOutcome[];
}

/**
 * 멱등 키는 `{project, title}`이다.
 *
 * **왜 title인가.** 시드 JSON에는 안정적인 외부 ID가 없고(`_id`는 서버가 만든다), 파일명은
 * 레코드의 속성이 아니라 배치의 속성이라 파일을 옮기면 키가 바뀐다. title은 레코드 자체의
 * 속성이고 사람이 읽을 수 있으며, 같은 title 두 건이 정당하게 존재할 이유도 없다.
 * 로딩 단계에서 시드 내부 title 중복을 이미 거부하므로 키의 유일성도 보장된다.
 *
 * **왜 건너뛰기이고 PATCH가 아닌가.** PATCH는 `embeddingVersion` 워터마크 보존을 신경 써야
 * 하고 본문 섹션이 바뀌면 재임베딩 잡이 다시 걸린다. 시드는 "이 사례가 존재하게 한다"가
 * 목적이지 "시드 파일이 항상 이긴다"가 목적이 아니다. 사람이 시드 레코드를 손봤을 때
 * 그것을 덮어쓰면 시드가 사용자 편집을 조용히 되돌리는 도구가 된다. 시드 내용을 실제로
 * 갱신하고 싶으면 `--reset`이 그 의도를 명시적으로 표현하는 경로다.
 */
export async function runSeed(options: SeedOptions): Promise<SeedResult> {
  const log = options.log ?? ((): void => undefined);
  const titles = options.records.map((record) => record.input.title);

  let deletedRecords = 0;
  if (options.reset === true) {
    deletedRecords = await deleteSeedRecords(options.db, options.project, titles);
    log(`[db:seed] --reset: 시드 레코드 ${String(deletedRecords)}건 삭제`);
  }

  const existing = await findSeedTitles(options.db, options.project, titles);

  const app = createApp({
    db: options.db,
    apiKeys: options.apiKeys,
    sanitizeOptions: options.sanitizeOptions,
    embeddingVersion: options.embedder.version,
    version: VERSION,
    ...(options.now === undefined ? {} : { now: options.now }),
  });

  let inserted = 0;
  let skipped = 0;
  try {
    for (const record of options.records) {
      if (existing.has(record.input.title)) {
        skipped += 1;
        continue;
      }
      const response = await app.inject({
        method: "POST",
        url: "/v1/records",
        headers: { authorization: `Bearer ${options.apiKey}` },
        payload: record.input,
      });
      if (response.statusCode !== 201) {
        throw new SeedError(
          SEED_ERROR_CODES.CREATE_FAILED,
          `${record.source}: POST /v1/records가 ${String(response.statusCode)}를 반환했다 — ${response.body}`,
        );
      }
      inserted += 1;
    }
  } finally {
    await app.close();
  }

  /**
   * **멱등 키가 실제로 성립하는지 확인한다.**
   * 새니타이저가 title을 고치면(마스킹 라벨 삽입 등) 저장된 title이 시드 title과 달라지고,
   * 다음 실행의 조회가 그 레코드를 못 찾아 **매번 새로 삽입한다.** 개수가 조용히 늘어나는
   * 대신 여기서 시끄럽게 실패하는 편이 낫다 — 조용한 중복은 eval 골든셋까지 오염시킨다.
   */
  const stored = await findSeedTitles(options.db, options.project, titles);
  const missing = titles.filter((title) => !stored.has(title));
  if (missing.length > 0) {
    throw new SeedError(
      SEED_ERROR_CODES.TITLE_REWRITTEN,
      `적재 후에도 조회되지 않는 title이 ${String(missing.length)}건 있다. ` +
        `새니타이저가 title을 고쳐 멱등 키가 어긋났을 수 있다: ${missing[0] ?? ""}`,
    );
  }

  const drained = await drainEmbedJobs(options);
  log(
    `[db:seed] 삽입 ${String(inserted)} / 건너뜀 ${String(skipped)} / ` +
      `임베딩 잡 ${String(drained.embeddedJobs)}건 처리`,
  );

  return { inserted, skipped, deletedRecords, ...drained };
}

/** `{project, title}`로 이미 있는 시드를 찾는다. 반환은 존재하는 title 집합. */
async function findSeedTitles(
  db: Db,
  project: string,
  titles: readonly string[],
): Promise<ReadonlySet<string>> {
  const found = (await db
    .collection("records")
    .find({ project, title: { $in: [...titles] } }, { projection: { title: 1 } })
    .toArray()) as unknown as SeedRecordProjection[];
  return new Set(found.map((document) => document.title));
}

/**
 * 시드가 만든 레코드만 지운다.
 *
 * **컬렉션 전체를 지우지 않는다.** 사용자가 MCP로 기록한 사례까지 날아가면 `--reset`은
 * 재적재 도구가 아니라 데이터 파괴 도구가 된다. 필터는 멱등 키와 정확히 같은
 * `{project, title: {$in: 시드 title들}}`이다 — 시드가 만들 수 있었던 것만이 대상이다.
 * 딸린 chunks·jobs도 함께 지운다. 남겨 두면 고아 청크가 검색에 계속 잡히고, 남은 잡은
 * 사라진 레코드를 찾다 실패한다.
 */
async function deleteSeedRecords(
  db: Db,
  project: string,
  titles: readonly string[],
): Promise<number> {
  const filter = { project, title: { $in: [...titles] } };
  const targets = (await db
    .collection("records")
    .find(filter, { projection: { title: 1 } })
    .toArray()) as unknown as SeedRecordProjection[];
  if (targets.length === 0) return 0;

  const ids = targets.map((document) => document._id);
  await db.collection("chunks").deleteMany({ recordId: { $in: ids } });
  await db.collection("jobs").deleteMany({ recordId: { $in: ids } });
  const { deletedCount } = await db.collection("records").deleteMany({ _id: { $in: ids } });
  return deletedCount;
}

/**
 * pending 잡이 없어질 때까지 워커를 돌린다.
 *
 * `runOnce()`가 공개 API인 것이 이 용도에 유용하다 — 폴링 루프를 띄우지 않고 큐를 비울 수
 * 있어 스크립트가 스스로 끝난다. 일시 실패한 잡은 백오프 때문에 즉시 다시 집히지 않으므로
 * 드레인은 그 시점에 자연히 멈춘다. 그래도 상한을 둔다: 잡이 무한히 재큐잉되는 구현 결함이
 * 생기면 시드가 영원히 안 끝나는 대신 시끄럽게 실패해야 한다.
 */
async function drainEmbedJobs(
  options: SeedOptions,
): Promise<{ embeddedJobs: number; failedJobs: readonly JobOutcome[] }> {
  const worker = createEmbedWorker({
    db: options.db,
    embedder: options.embedder,
    ...(options.now === undefined ? {} : { now: options.now }),
  });

  // 레코드당 잡 1건이 정상이고, 재시도 여유로 4배를 준다. 리터럴이며 구현 상수가 아니다.
  const limit = options.records.length * 4 + 16;
  const failedJobs: JobOutcome[] = [];
  let embeddedJobs = 0;

  for (let iteration = 0; iteration < limit; iteration += 1) {
    const outcome = await worker.runOnce();
    if (outcome === undefined) return { embeddedJobs, failedJobs };
    if (outcome.status === "done") embeddedJobs += 1;
    else failedJobs.push(outcome);
  }

  throw new SeedError(
    SEED_ERROR_CODES.DRAIN_LIMIT,
    `임베딩 잡 드레인이 ${String(limit)}회를 넘겼다 — 잡이 무한 재큐잉되고 있을 수 있다.`,
  );
}

// ---------------------------------------------------------------- CLI 인자

export interface SeedArgs {
  readonly reset: boolean;
  readonly project: string;
  /** fake embedder로 적재하는 것을 명시 승인했는가. */
  readonly allowFakeEmbeddings: boolean;
}

/** `--reset`, `--project=<slug>`, `--allow-fake-embeddings`. 모르는 인자는 던진다. */
export function parseSeedArgs(argv: readonly string[]): SeedArgs {
  let reset = false;
  let project = DEFAULT_SEED_PROJECT;
  let allowFakeEmbeddings = false;

  for (const arg of argv) {
    if (arg === "--reset") reset = true;
    else if (arg === "--allow-fake-embeddings") allowFakeEmbeddings = true;
    else if (arg.startsWith("--project=")) {
      const value = arg.slice("--project=".length).trim();
      if (value === "") throw new Error("--project= 뒤에 project 슬러그가 필요하다.");
      project = value;
    } else {
      throw new Error(
        `알 수 없는 인자: ${arg}. 사용법: pnpm db:seed [--reset] [--project=<slug>] [--allow-fake-embeddings]`,
      );
    }
  }

  return { reset, project, allowFakeEmbeddings };
}

/**
 * `API_KEYS` 맵에서 이 project로 해석되는 키 하나를 고른다.
 *
 * 키를 못 찾으면 던진다. 임의의 키로 적재하면 레코드가 엉뚱한 project에 들어가고,
 * 그건 조용히 잘못된 데이터가 되는 경로다. `parseApiKeys`가 이미 중복 키를 거부하므로
 * 여기서 나오는 후보는 project별로 결정론적이다.
 */
export function resolveSeedApiKey(apiKeys: ReadonlyMap<string, string>, project: string): string {
  for (const [key, claimed] of apiKeys) {
    if (claimed === project) return key;
  }
  throw new Error(
    `API_KEYS에 project "${project}"로 해석되는 키가 없다. ` +
      `\`<key>:${project}\` 항목을 추가하거나 --project=<slug>로 대상을 바꿔라(.env.example 참조).`,
  );
}
