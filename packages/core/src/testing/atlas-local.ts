/**
 * `mongodb/mongodb-atlas-local` 컨테이너 부팅 헬퍼. **테스트 전용이다** —
 * 어느 배럴에서도 export하지 않으므로 런타임 번들에 실리지 않는다.
 * (`*.spec.ts`가 아니라 vitest가 테스트 파일로 수집하지도 않는다.)
 *
 * T-010(`db/search-indexes.int.spec.ts`)이 처음 썼고 T-011(`retriever/retrieve.int.spec.ts`)이
 * 두 번째 사용처다. 복붙 대신 여기로 뽑았다 — 부팅 게이트가 두 벌이 되면 한쪽만 고쳐지고
 * 다른 쪽이 간헐적으로 실패한다.
 *
 * ## 왜 게이트가 두 단계인가 (T-010 F-3/F-10, 실측)
 * atlas-local은 **mongod와 mongot(검색 프로세스) 두 개**를 띄우고 mongod가 먼저 붙는다.
 * `ping`이 통해도 검색은 `Error connecting to localhost:27027 ... Connection refused`로 죽는다.
 *  1. 컨테이너 healthcheck
 *  2. 없는 인덱스를 향한 `$search`가 "연결 거부"가 아닌 답을 줄 때까지 대기
 * 측정: 둘 다 제거하면 4/4 실패, 1단계만 남기면 이 머신에서 6/6 통과.
 * 1단계가 실제 일을 하고 2단계는 느린 CI 러너용 보험이다.
 *
 * testcontainers 대신 `docker` CLI를 직접 부른다: 컨테이너 수명이 파일 하나에 갇혀 있어
 * 새 devDependency(전이 의존 포함)를 늘릴 만한 이득이 없다 (T-010 결정 유지).
 */
import { spawnSync } from "node:child_process";

import { MongoClient, type Db } from "mongodb";

export const ATLAS_LOCAL_IMAGE = "mongodb/mongodb-atlas-local:latest";
/** 이미지 pull(~2GB)까지 감안한 부팅 상한. */
export const ATLAS_LOCAL_BOOT_TIMEOUT_MS = 600_000;

export function docker(args: string[]): { status: number; stdout: string; stderr: string } {
  const result = spawnSync("docker", args, { encoding: "utf8" });
  return {
    status: result.status ?? -1,
    stdout: result.stdout ?? "",
    stderr: result.stderr ?? "",
  };
}

export function dockerAvailable(): boolean {
  return docker(["info", "--format", "{{.ServerVersion}}"]).status === 0;
}

/**
 * docker가 없으면 **stderr에 배너를 찍는다.** skip이 조용히 일어나면 "docker가 없으니 그린"이라는
 * 가짜 그린이 된다 — skip은 통과가 아니다.
 */
export function warnDockerMissing(taskId: string, file: string, reason: string): void {
  console.warn(
    [
      "",
      "==============================================================",
      `[${taskId}] ${file}을 SKIP한다: docker 데몬에 닿지 못했다.`,
      `        이 파일은 ${ATLAS_LOCAL_IMAGE} 컨테이너가 있어야만 ${reason}을 검증할 수 있다.`,
      "        skip은 '통과'가 아니다 — 이 환경에서 그 Acceptance는 판정되지 않았다.",
      "==============================================================",
      "",
    ].join("\n"),
  );
}

export function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

export interface AtlasLocalHandle {
  readonly client: MongoClient;
  readonly db: Db;
  /** 컨테이너를 제거한다. 연결 종료도 함께 한다. 두 번 불러도 안전하다. */
  stop(): Promise<void>;
}

export interface StartAtlasLocalOptions {
  /** 컨테이너 이름. 같은 머신에서 병렬로 도는 스펙끼리 충돌하지 않게 파일마다 다르게 준다. */
  readonly containerName: string;
  readonly dbName: string;
  readonly bootTimeoutMs?: number;
}

/**
 * 컨테이너를 띄우고 **mongot까지 준비된** 핸들을 돌려준다.
 * 여기서 돌아온 뒤에는 `$search`/`$vectorSearch`가 연결 거부로 죽지 않는다.
 */
export async function startAtlasLocal(options: StartAtlasLocalOptions): Promise<AtlasLocalHandle> {
  const { containerName, dbName } = options;
  const bootTimeoutMs = options.bootTimeoutMs ?? ATLAS_LOCAL_BOOT_TIMEOUT_MS;

  docker(["rm", "-f", containerName]);
  const run = docker(["run", "-d", "--name", containerName, "-P", ATLAS_LOCAL_IMAGE]);
  if (run.status !== 0) {
    throw new Error(`컨테이너 기동 실패: ${run.stderr || run.stdout}`);
  }

  const deadline = Date.now() + bootTimeoutMs / 2;
  try {
    waitForHealthy(containerName, deadline);

    const port = docker(["port", containerName, "27017/tcp"]).stdout.trim().split("\n")[0];
    const hostPort = port?.split(":").pop();
    if (!hostPort) throw new Error(`포트 매핑을 읽지 못했다: ${String(port)}`);

    const client = await connectWithRetry(
      `mongodb://127.0.0.1:${hostPort}/?directConnection=true`,
      dbName,
      deadline,
    );
    const db = client.db(dbName);
    await waitForMongot(db, deadline);

    let stopped = false;
    return {
      client,
      db,
      async stop(): Promise<void> {
        if (stopped) return;
        stopped = true;
        await client.close().catch(() => undefined);
        docker(["rm", "-f", containerName]);
      },
    };
  } catch (error) {
    docker(["rm", "-f", containerName]);
    throw error;
  }
}

function waitForHealthy(containerName: string, deadline: number): void {
  while (Date.now() < deadline) {
    const status = docker([
      "inspect",
      "--format",
      "{{if .State.Health}}{{.State.Health.Status}}{{else}}nohealth{{end}}",
      containerName,
    ]).stdout.trim();
    if (status === "healthy" || status === "nohealth") return;
    if (status === "unhealthy") throw new Error("atlas-local 컨테이너가 unhealthy다");
    spawnSync("sleep", ["1"]);
  }
  throw new Error("atlas-local 컨테이너가 제한 시간 안에 healthy가 되지 않았다");
}

async function connectWithRetry(
  uri: string,
  dbName: string,
  deadline: number,
): Promise<MongoClient> {
  let lastError: unknown;
  while (Date.now() < deadline) {
    const candidate = new MongoClient(uri, { serverSelectionTimeoutMS: 2_000 });
    try {
      await candidate.connect();
      await candidate.db(dbName).admin().command({ ping: 1 });
      return candidate;
    } catch (error) {
      lastError = error;
      await candidate.close().catch(() => undefined);
      await sleep(1_000);
    }
  }
  throw new Error(`atlas-local 컨테이너에 연결하지 못했다: ${String(lastError)}`);
}

/** 게이트 2단계: mongot이 살아 있으면 없는 인덱스를 향한 `$search`도 에러 없이 답한다. */
async function waitForMongot(handle: Db, deadline: number): Promise<void> {
  const probe = handle.collection("_mongot_probe");
  await handle.createCollection("_mongot_probe").catch(() => undefined);
  let lastError: unknown;

  while (Date.now() < deadline) {
    try {
      await probe
        .aggregate([{ $search: { index: "__not_created__", text: { query: "x", path: "y" } } }])
        .toArray();
      return;
    } catch (error) {
      lastError = error;
      const message = error instanceof Error ? error.message : String(error);
      // mongot이 답을 했다면(=인덱스 없음 류의 에러) 준비된 것이다.
      if (!/connection refused|connecting to localhost/i.test(message)) return;
      await sleep(500);
    }
  }
  throw new Error(`mongot이 준비되지 않았다: ${String(lastError)}`);
}

/** 검색 인덱스는 READY 이후에도 새 문서를 반영하는 데 잠깐 걸린다 — 결과가 나올 때까지 폴링. */
export async function pollUntilNonEmpty<Row>(
  run: () => Promise<Row[]>,
  timeoutMs: number,
): Promise<Row[]> {
  const deadline = Date.now() + timeoutMs;
  let last: Row[] = [];
  while (Date.now() < deadline) {
    last = await run();
    if (last.length > 0) return last;
    await sleep(300);
  }
  return last;
}

/** 조건이 만족될 때까지 폴링. 인덱스 반영 지연을 흡수하는 일반형. */
export async function pollUntil<Row>(
  run: () => Promise<Row>,
  predicate: (value: Row) => boolean,
  timeoutMs: number,
): Promise<Row> {
  const deadline = Date.now() + timeoutMs;
  let last = await run();
  while (Date.now() < deadline) {
    if (predicate(last)) return last;
    await sleep(300);
    last = await run();
  }
  return last;
}
