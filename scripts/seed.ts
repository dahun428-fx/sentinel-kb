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
 *
 * ## 왜 `--reset`이 삭제 후 재삽입이 아니라 제자리 PATCH인가
 * 삭제 후 재삽입은 두 가지를 동시에 깬다.
 * 1. **`_id`가 새로 발급된다.** `EvalCaseSchema.expectedRecordIds`가 `ObjectIdString[]`이므로
 *    골든셋(T-013)이 `--reset` 한 번에 통째로 죽는다.
 * 2. **동명 사용자 레코드가 함께 지워진다.** 삭제 필터가 멱등 키(`{project,title}`)와 같아서
 *    사용자가 MCP로 기록한 같은 제목의 사례를 원리적으로 구분할 수 없다(T-009 F-6).
 * 제자리 PATCH는 지우지 않으므로 사용자 레코드가 안전하고 `_id`가 보존된다.
 * "어느 레코드가 시드의 것인가"는 추측하지 않고 **`seedManifest` 장부**에 적어 둔다 —
 * records 컬렉션 밖이므로 `RecordSchema`(`.strict()`)를 재개방하지 않는다.
 */
import { readdir, readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { createApp } from "@sentinel/api";
import { CreateRecordInput } from "@sentinel/contracts";
import { VERSION, type Embedder, type ResolvedSanitizeOptions } from "@sentinel/core";
import { createEmbedWorker, type JobOutcome } from "@sentinel/worker";
import { ObjectId as ObjectIdCtor, type Db, type ObjectId } from "mongodb";

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
  /** `--reset`의 제자리 갱신 PATCH가 200이 아닌 응답을 냈다. */
  PATCH_FAILED: "SEED_PATCH_FAILED",
  /** 시드 JSON의 `type`이 저장된 레코드와 다르다 — PATCH로 표현할 수 없다. */
  TYPE_CHANGED: "SEED_TYPE_CHANGED",
  /** 장부에 없는 title에 후보 레코드가 둘 이상이다 — 어느 것이 시드의 것인지 알 수 없다. */
  AMBIGUOUS_TITLE: "SEED_AMBIGUOUS_TITLE",
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
  readonly type: "incident" | "divergence";
}

/**
 * 시드가 만든 레코드의 소유권 장부.
 *
 * **왜 records 밖의 별도 컬렉션인가.** `--reset`이 사용자 레코드를 건드리지 않으려면
 * "이 레코드는 시드가 만들었다"는 사실이 어딘가에 **안정적으로** 남아야 한다.
 * `RecordSchema`에 `seedBatch` 같은 마커를 넣는 것이 직관적이지만 그건 `.strict()` 계약
 * 재개방(G3, 인간 승인)이고, 무엇보다 **그것만으로는 `_id` 문제가 안 풀린다**(재삽입하면
 * 여전히 새 `_id`다). 장부는 계약을 건드리지 않고 둘을 동시에 푼다.
 *
 * 이 컬렉션은 API 계약의 일부가 아니다 — 시드 스크립트만 읽고 쓴다.
 */
export const SEED_MANIFEST_COLLECTION = "seedManifest";

interface SeedManifestDocument {
  readonly _id: ObjectId;
  readonly project: string;
  readonly title: string;
  /** 이 `{project,title}` 시드가 소유한 records 도큐먼트. */
  readonly recordId: ObjectId;
  readonly updatedAt: Date;
}

/** `--reset`이 제자리 갱신할 대상 1건. */
interface SeedTarget {
  readonly recordId: ObjectId;
  /** 저장된 레코드의 종류. 시드 JSON과 다르면 PATCH로 표현할 수 없다. */
  readonly type: "incident" | "divergence";
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
  /**
   * 시드가 만든 레코드를 **제자리에서 갱신**한다. 아무것도 지우지 않는다.
   * 소유권 판정은 `seedManifest` 장부가 하므로 동명 사용자 레코드는 대상이 아니다.
   */
  readonly reset?: boolean;
  readonly now?: () => Date;
  readonly log?: (line: string) => void;
}

export interface SeedResult {
  readonly inserted: number;
  /** 이미 있어서 건너뛴 수. 2회차 실행에서는 이 값이 전체 수와 같다. */
  readonly skipped: number;
  /** `--reset`이 제자리 갱신한(PATCH한) 레코드 수. `_id`는 보존된다. */
  readonly patched: number;
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
 * **왜 `--reset` 없이는 건너뛰기이고 PATCH가 아닌가.** 시드는 "이 사례가 존재하게 한다"가
 * 목적이지 "시드 파일이 항상 이긴다"가 목적이 아니다. 사람이 시드 레코드를 손봤을 때
 * 그것을 덮어쓰면 시드가 사용자 편집을 조용히 되돌리는 도구가 된다. 시드 내용을 실제로
 * 갱신하고 싶으면 `--reset`이 그 의도를 명시적으로 표현하는 경로다.
 *
 * **`--reset`은 제자리 갱신이다.** 지우지 않으므로 `_id`가 보존되고(골든셋이 산다),
 * 장부에 적힌 것만 건드리므로 동명 사용자 레코드가 안전하다. 워터마크(`embeddingVersion`)는
 * PATCH 라우트가 부분 `$set`만 하므로 그대로 유지되고, 본문 섹션이 바뀌었으니 재임베딩 잡이
 * 걸린다 — 그 잡은 아래 드레인이 같은 실행 안에서 처리한다.
 */
export async function runSeed(options: SeedOptions): Promise<SeedResult> {
  const log = options.log ?? ((): void => undefined);
  const titles = options.records.map((record) => record.input.title);
  const reset = options.reset === true;

  /**
   * `--reset`일 때만 소유권을 해석한다. 비-reset 경로는 존재 여부만 알면 되고,
   * 그 경로의 동작(건너뛰기)을 이 변경이 바꾸지 않는다는 것이 T-009의 멱등성 계약이다.
   */
  const targets = reset
    ? await resolveSeedTargets(options.db, options.project, titles)
    : new Map<string, SeedTarget>();
  const existing = reset
    ? new Set<string>()
    : await findSeedTitles(options.db, options.project, titles);

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
  let patched = 0;
  try {
    for (const record of options.records) {
      const title = record.input.title;
      const target = reset ? targets.get(title) : undefined;

      if (target !== undefined) {
        if (target.type !== record.input.type) {
          /**
           * **조용히 넘기지 않는다.** `PatchRecordInput`에 `type`이 없고(`.partial().strict()`),
           * PATCH 라우트도 `type` 키를 400으로 거부한다 — 종류가 바뀌면 본문 섹션의 의미가
           * 통째로 달라지기 때문이다. 무시하면 시드 JSON과 DB가 조용히 갈라져 "갱신했다고
           * 믿는데 안 바뀐" 상태가 되고, 그 레코드를 가리키는 골든셋은 다른 지식을 채점한다.
           * 삭제 후 재삽입으로 우회하지도 않는다 — 그건 `_id`를 버리는 일이고 이 변경이
           * 없애려는 바로 그 동작이다. 사람이 결정해야 한다.
           */
          throw new SeedError(
            SEED_ERROR_CODES.TYPE_CHANGED,
            `${record.source}: 시드의 type이 "${record.input.type}"인데 저장된 레코드는 ` +
              `"${target.type}"이다(_id=${target.recordId.toHexString()}). ` +
              "종류 변경은 PATCH로 표현할 수 없다(specs/04: type은 수정 불가). " +
              "그 레코드를 명시적으로 삭제하고 다시 시드하거나, 시드 title을 새로 지어라 — " +
              "재삽입은 _id를 바꾸므로 그 레코드를 가리키는 골든셋도 함께 갱신해야 한다.",
          );
        }
        await patchSeedRecord(app, options, record, target.recordId);
        await rememberSeedRecord(options, title, target.recordId);
        patched += 1;
        continue;
      }

      if (existing.has(title)) {
        skipped += 1;
        continue;
      }

      const recordId = await createSeedRecord(app, options, record);
      await rememberSeedRecord(options, title, recordId);
      inserted += 1;
    }
  } finally {
    await app.close();
  }

  if (reset) {
    log(`[db:seed] --reset: 시드 레코드 ${String(patched)}건 제자리 갱신(_id 보존)`);
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
    `[db:seed] 삽입 ${String(inserted)} / 갱신 ${String(patched)} / 건너뜀 ${String(skipped)} / ` +
      `임베딩 잡 ${String(drained.embeddedJobs)}건 처리`,
  );

  return { inserted, skipped, patched, ...drained };
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
    .toArray()) as unknown as { title: string }[];
  return new Set(found.map((document) => document.title));
}

/**
 * `--reset`이 제자리 갱신할 레코드를 title별로 해석한다.
 *
 * **장부가 1순위다.** 장부에 적힌 `recordId`가 살아 있으면 그것이 시드의 레코드다 —
 * 같은 `{project,title}`을 가진 사용자 레코드가 옆에 있어도 대상이 아니다.
 * 이것이 T-009 F-6이 "원리적으로 구분할 수 없다"고 적은 지점을 닫는다.
 *
 * **장부가 없는 기존 DB는 1회 입양한다.** 이 변경 이전에 적재된 배포에는 장부가 없다.
 * `{project,title}` 일치가 **정확히 1건**이면 그것을 시드의 레코드로 받아들이고 장부에 적는다.
 * 그렇게 하지 않으면 첫 `--reset`이 전부를 새로 삽입해 제목이 중복되고, 이미 만들어 둔
 * 골든셋도 그 자리에서 죽는다. **2건 이상이면 입양하지 않고 던진다** — 어느 쪽이 시드의
 * 것인지 알 방법이 없고, 여기서 찍으면 사용자 레코드를 덮어쓸 수 있다.
 */
async function resolveSeedTargets(
  db: Db,
  project: string,
  titles: readonly string[],
): Promise<Map<string, SeedTarget>> {
  const manifest = (await db
    .collection(SEED_MANIFEST_COLLECTION)
    .find({ project, title: { $in: [...titles] } })
    .toArray()) as unknown as SeedManifestDocument[];

  const byRecordId = new Map<string, string>();
  for (const entry of manifest) byRecordId.set(entry.recordId.toHexString(), entry.title);

  const claimed = (await db
    .collection("records")
    .find(
      { _id: { $in: manifest.map((entry) => entry.recordId) }, project },
      { projection: { title: 1, type: 1 } },
    )
    .toArray()) as unknown as SeedRecordProjection[];

  const targets = new Map<string, SeedTarget>();
  for (const document of claimed) {
    const title = byRecordId.get(document._id.toHexString());
    // 장부가 가리키는 레코드는 그 사이 제목이 바뀌었어도 여전히 시드의 것이다.
    // `--reset`은 시드 파일을 정본으로 되돌리는 경로이므로 제목도 함께 되돌린다.
    if (title !== undefined) targets.set(title, { recordId: document._id, type: document.type });
  }

  const unclaimed = titles.filter((title) => !targets.has(title));
  if (unclaimed.length === 0) return targets;

  const candidates = (await db
    .collection("records")
    .find({ project, title: { $in: unclaimed } }, { projection: { title: 1, type: 1 } })
    .toArray()) as unknown as SeedRecordProjection[];

  const byTitle = new Map<string, SeedRecordProjection[]>();
  for (const document of candidates) {
    const bucket = byTitle.get(document.title);
    if (bucket === undefined) byTitle.set(document.title, [document]);
    else bucket.push(document);
  }

  const ambiguous: string[] = [];
  for (const [title, bucket] of byTitle) {
    const only = bucket[0];
    if (bucket.length > 1 || only === undefined) {
      ambiguous.push(title);
      continue;
    }
    targets.set(title, { recordId: only._id, type: only.type });
  }

  if (ambiguous.length > 0) {
    throw new SeedError(
      SEED_ERROR_CODES.AMBIGUOUS_TITLE,
      `시드 소유권 장부(${SEED_MANIFEST_COLLECTION})에 없는 title에 후보 레코드가 둘 이상이다: ` +
        `${ambiguous.join(" / ")}. 어느 것이 시드의 레코드인지 알 방법이 없고, ` +
        "찍어서 갱신하면 사용자 레코드를 덮어쓴다. 중복을 정리하거나 장부에 소유 레코드를 적어라.",
    );
  }

  return targets;
}

/** 시드 소유권을 장부에 적는다. 같은 `{project,title}`은 언제나 1건이다(upsert). */
async function rememberSeedRecord(
  options: SeedOptions,
  title: string,
  recordId: ObjectId,
): Promise<void> {
  const now = options.now === undefined ? new Date() : options.now();
  await options.db
    .collection<SeedManifestDocument>(SEED_MANIFEST_COLLECTION)
    .updateOne(
      { project: options.project, title },
      { $set: { recordId, updatedAt: now } },
      { upsert: true },
    );
}

/** `POST /v1/records`로 새로 넣고 서버가 발급한 `_id`를 돌려준다. */
async function createSeedRecord(
  app: Awaited<ReturnType<typeof createApp>>,
  options: SeedOptions,
  record: SeedRecord,
): Promise<ObjectId> {
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
  const { _id } = JSON.parse(response.body) as { _id: string };
  return new ObjectIdCtor(_id);
}

/**
 * `PATCH /v1/records/:id`로 시드 내용을 제자리 갱신한다.
 *
 * **시드가 가진 필드를 전부 보낸다.** 바뀐 것만 골라 보내면 diff 계산이 새니타이즈 결과와
 * 저장값을 비교해야 하는데, 그 비교가 어긋나는 순간 "갱신했다고 믿는데 안 바뀐" 조용한
 * 실패가 된다. 전송 비용은 in-process inject라 무시할 수 있고, 재임베딩 잡 1건은
 * 삭제 후 재삽입이 어차피 만들던 것과 같다.
 *
 * **`type`·`project`·`embeddingVersion`은 보내지 않는다** — `PatchRecordInput`에 없고,
 * PATCH 라우트가 부분 `$set`만 하므로 워터마크는 여기서 보존된다(specs/02).
 */
async function patchSeedRecord(
  app: Awaited<ReturnType<typeof createApp>>,
  options: SeedOptions,
  record: SeedRecord,
  recordId: ObjectId,
): Promise<void> {
  const { input } = record;
  const common = {
    title: input.title,
    severity: input.severity,
    tags: input.tags,
    status: input.status,
  };
  const payload =
    input.type === "incident"
      ? {
          ...common,
          symptom: input.symptom,
          resolution: input.resolution,
          ...(input.rootCause === undefined ? {} : { rootCause: input.rootCause }),
          ...(input.prevention === undefined ? {} : { prevention: input.prevention }),
        }
      : {
          ...common,
          expected: input.expected,
          actual: input.actual,
          context: input.context,
          correction: input.correction,
        };

  const response = await app.inject({
    method: "PATCH",
    url: `/v1/records/${recordId.toHexString()}`,
    headers: { authorization: `Bearer ${options.apiKey}` },
    payload,
  });
  if (response.statusCode !== 200) {
    throw new SeedError(
      SEED_ERROR_CODES.PATCH_FAILED,
      `${record.source}: PATCH /v1/records/${recordId.toHexString()}가 ` +
        `${String(response.statusCode)}를 반환했다 — ${response.body}`,
    );
  }
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
