/**
 * **실물 nginx를 띄워** 스트리밍이 청크 단위로 도달하는지 본다 (T-026 Acceptance 2·3).
 *
 * ## 왜 설정 텍스트 검사로 부족한가
 * `nginx-contract.spec.ts`는 `proxy_buffering off`라는 **글자**가 있는지 본다. 그런데
 * 버퍼링은 여러 지시문이 함께 만드는 성질이라 — `proxy_cache`, `gzip`, 업스트림 응답 크기,
 * `proxy_buffer_size` — 글자가 있어도 실제로는 버퍼링될 수 있다. 시드 INC-06이 값비쌌던
 * 이유가 그거다. 그래서 여기서는 **관측된 도착 시각**으로 판정한다.
 *
 * ## 무엇을 실물로 쓰는가
 * `snippets/routes.conf`·`snippets/proxy-streaming.conf`는 **배포되는 파일 그대로**다.
 * 갈아끼우는 것은 `conf.d/00-upstreams.conf` 하나뿐이다 — 그 파일이 따로 있는 이유다.
 * 라우팅·버퍼링 설정을 테스트용으로 복사하면 이 테스트는 아무것도 지키지 못한다.
 *
 * docker가 없으면 skip되고, `require-docker.int.spec.ts`가 CI에서 그 skip을 하드 실패로
 * 승격한다. **skip은 통과가 아니다.**
 */
import { spawn, spawnSync, type ChildProcess } from "node:child_process";
import { createServer, type Server } from "node:http";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { dockerAvailable } from "./require-docker.int.spec.js";

const repoRoot = fileURLToPath(new URL("..", import.meta.url));
const HAS_DOCKER = dockerAvailable();

const IMAGE_TAG = "sentinel-kb-nginx:t026-test";


/** SSE 프레임 하나 사이의 간격(ms). 버퍼링되면 이 간격이 통째로 사라진다. */
const FRAME_GAP_MS = 150;
const FRAME_COUNT = 5;

/**
 * nginx 기본 `proxy_read_timeout`(60s)을 **넘기는** 침묵 구간. 우리 설정은 300s다.
 * 이 값을 60s 아래로 내리면 테스트가 아무것도 증명하지 않게 된다.
 */
const IDLE_PROBE_GAP_MS = 65_000;

/**
 * `proxy_read_timeout 300s`의 **행동 증명**은 65초가 걸린다. `pnpm verify`에 65초를 항상
 * 얹을 수는 없어 기본 off로 두고, 옵트인으로 돌린다:
 *
 *   T026_READ_TIMEOUT_PROOF=1 pnpm test:integration
 *
 * 끈 상태에서 이 값이 지키는 것은 **구조적 가드뿐이다**(스니펫에 300s가 있고, 두 location이
 * 그 스니펫을 include하며, nginx -T가 그 include를 해소한다). 그건 "값이 설정돼 있다"이지
 * "60초 침묵을 견딘다"가 아니다 — 구분해서 보고해야 한다.
 */
const READ_TIMEOUT_PROOF = /^(1|true|yes|on)$/i.test(
  process.env["T026_READ_TIMEOUT_PROOF"]?.trim() ?? "",
);

const MCP_API_KEY = "t026testkey";
const MCP_PROJECT = "sentinel-kb";

function docker(args: readonly string[]): { status: number; stdout: string; stderr: string } {
  const result = spawnSync("docker", [...args], { encoding: "utf8", cwd: repoRoot });
  return { status: result.status ?? -1, stdout: result.stdout ?? "", stderr: result.stderr ?? "" };
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/** 임의 포트로 리슨한 뒤 실제 포트를 돌려준다. */
async function listenOnEphemeralPort(server: Server): Promise<number> {
  await new Promise<void>((resolve) => server.listen(0, "0.0.0.0", resolve));
  const address = server.address();
  if (address === null || typeof address === "string") throw new Error("포트를 얻지 못했다");
  return address.port;
}

/**
 * 스트리밍 오리진. **일부러 천천히** SSE 프레임을 흘린다.
 *
 * ## 두 경로가 헤더를 다르게 내는 것이 이 하네스의 핵심이다
 * - `/v1` — `X-Accel-Buffering: no`를 **낸다.** `packages/api/src/answer.ts`가 실제로 그렇다(T-019).
 * - `/mcp` — **내지 않는다.** MCP SDK의 Streamable HTTP 전송은 그 헤더를 붙이지 않는다.
 *
 * 왜 구분하는가: nginx는 `X-Accel-Buffering: no`를 받으면 **그 응답 한 건에 한해** 버퍼링을
 * 끈다. 그래서 오리진이 항상 그 헤더를 내면 `proxy_buffering off`를 지워도 테스트가 통과한다
 * (실제로 확인했다 — 뮤테이션이 초록이었다). 그건 설정이 아니라 코드 방어선을 재는 테스트다.
 *
 * **코드 방어선은 설정의 대체재가 아니다**(T-019 F-2). 헤더를 내지 않는 `/mcp`가 설정 자체의
 * 대조군이고, 거기서 버퍼링이 관측되면 `proxy_buffering off`가 사라진 것이다.
 */
function createSseOrigin(): Server {
  return createServer((req, res) => {
    // `/v1`과 `/mcp` 둘 다 흘린다 — 스트리밍 스니펫이 걸린 두 경로다.
    // 그 밖의 경로는 404를 내서 `/`(web_upstream) 대조군이 성립하게 한다.
    const path = req.url ?? "";
    if (!path.startsWith("/v1") && !path.startsWith("/mcp")) {
      res.writeHead(404).end();
      return;
    }
    res.writeHead(200, {
      "content-type": "text/event-stream",
      "cache-control": "no-cache",
      connection: "keep-alive",
      ...(path.startsWith("/v1") ? { "x-accel-buffering": "no" } : {}),
    });
    // `/v1/idle`은 **nginx 기본 proxy_read_timeout(60s)을 넘겨 침묵한다.** 300s 설정이
    // 실제로 걸렸는지 재는 유일한 방법이라 경로를 따로 둔다. 느려서 기본 off다.
    const isIdleProbe = path.includes("idle");
    const gapMs = isIdleProbe ? IDLE_PROBE_GAP_MS : FRAME_GAP_MS;
    const frameCount = isIdleProbe ? 2 : FRAME_COUNT;

    let sent = 0;
    const timer = setInterval(() => {
      sent += 1;
      res.write(`event: delta\ndata: {"seq":${String(sent)}}\n\n`);
      if (sent >= frameCount) {
        clearInterval(timer);
        res.write("event: done\ndata: {}\n\n");
        res.end();
      }
    }, gapMs);
    req.on("close", () => {
      clearInterval(timer);
    });
  });
}

interface Harness {
  readonly proxyPort: number;
  stop(): Promise<void>;
}

/** 실물 nginx 이미지를 빌드해 테스트 업스트림을 물린 채 띄운다. */
async function startNginx(containerName: string, upstreams: string): Promise<Harness> {
  const build = docker([
    "build",
    "-f",
    "docker/Dockerfile.nginx",
    "-t",
    IMAGE_TAG,
    ".",
  ]);
  if (build.status !== 0) throw new Error(`nginx 이미지 빌드 실패:\n${build.stderr}`);

  const dir = mkdtempSync(join(tmpdir(), "sentinel-nginx-"));
  const upstreamsPath = join(dir, "00-upstreams.conf");
  writeFileSync(upstreamsPath, upstreams);

  docker(["rm", "-f", containerName]);
  const run = docker([
    "run",
    "-d",
    "--name",
    containerName,
    // 컨테이너 안에서 호스트(테스트 프로세스)를 부를 수 있게 한다. Desktop·Linux 모두 동작한다.
    "--add-host=host.docker.internal:host-gateway",
    "-e",
    "NGINX_MODE=dev",
    "-p",
    "0:80",
    "-v",
    `${upstreamsPath}:/etc/nginx/conf.d/00-upstreams.conf:ro`,
    IMAGE_TAG,
  ]);
  if (run.status !== 0) throw new Error(`nginx 기동 실패:\n${run.stderr}`);

  const portLine = docker(["port", containerName, "80"]).stdout.trim().split("\n")[0] ?? "";
  const proxyPort = Number(portLine.split(":").pop());
  if (!Number.isSafeInteger(proxyPort) || proxyPort <= 0) {
    throw new Error(`nginx 호스트 포트를 읽지 못했다: ${portLine}`);
  }

  // nginx가 리슨할 때까지 기다린다.
  for (let attempt = 0; attempt < 60; attempt += 1) {
    try {
      await fetch(`http://127.0.0.1:${String(proxyPort)}/`, { signal: AbortSignal.timeout(1000) });
      break;
    } catch {
      await sleep(250);
    }
  }

  return {
    proxyPort,
    stop: async (): Promise<void> => {
      const logs = docker(["logs", containerName]);
      if (process.env["T026_NGINX_LOGS"] !== undefined) console.error(logs.stderr, logs.stdout);
      docker(["rm", "-f", containerName]);
      await Promise.resolve();
    },
  };
}

// =========================================================================
// Acceptance 2 — SSE가 nginx 경유로 **청크 단위** 도달
// =========================================================================

describe.skipIf(!HAS_DOCKER)("SSE 스트리밍이 nginx를 청크 단위로 통과한다 (T-026 A2)", () => {
  let origin: Server;
  let harness: Harness;

  beforeAll(async () => {
    origin = createSseOrigin();
    const originPort = await listenOnEphemeralPort(origin);
    harness = await startNginx(
      "sentinel-kb-t026-nginx-sse",
      [
        `upstream core_api_upstream { server host.docker.internal:${String(originPort)}; }`,
        `upstream mcp_upstream { server host.docker.internal:${String(originPort)}; }`,
        `upstream web_upstream { server host.docker.internal:${String(originPort)}; }`,
        "",
      ].join("\n"),
    );
  }, 300_000);

  afterAll(async () => {
    await harness?.stop();
    await new Promise<void>((resolve) => origin.close(() => {
      resolve();
    }));
  });

  interface Arrival {
    readonly atMs: number;
    readonly text: string;
  }

  async function readStream(
    path: string,
    timeoutMs = 30_000,
  ): Promise<{
    contentType: string;
    arrivals: Arrival[];
    totalMs: number;
  }> {
    const startedAt = performance.now();
    const response = await fetch(`http://127.0.0.1:${String(harness.proxyPort)}${path}`, {
      headers: { accept: "text/event-stream" },
      signal: AbortSignal.timeout(timeoutMs),
    });
    const arrivals: Arrival[] = [];
    const decoder = new TextDecoder();
    const reader = response.body?.getReader();
    if (reader === undefined) throw new Error("응답 본문 스트림이 없다");
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      arrivals.push({ atMs: performance.now() - startedAt, text: decoder.decode(value) });
    }
    return {
      contentType: response.headers.get("content-type") ?? "",
      arrivals,
      totalMs: performance.now() - startedAt,
    };
  }

  it("`text/event-stream`으로 응답한다", async () => {
    const result = await readStream("/v1/answer");
    expect(result.contentType).toContain("text/event-stream");
  }, 60_000);

  /**
   * nginx 자신에게 설정을 검사시킨다. `include` 경로가 틀리면 nginx는 **조용히 무시하지 않고
   * emerg로 죽는다** — 즉 `nginx -T` 성공은 "routes.conf와 그 안의 스니펫 include가 실제로
   * 로드됐다"의 기계 증명이다. 텍스트 가드(`nginx-contract.spec.ts`)가 "include 줄이 있다"를
   * 보고, 이 테스트가 "그 include가 실제로 해소된다"를 본다.
   */
  it("nginx 자신이 설정을 유효하다고 판정한다 (include 경로가 전부 해소된다)", () => {
    const result = docker(["exec", "sentinel-kb-t026-nginx-sse", "nginx", "-T"]);
    expect(result.status, `nginx -T 실패:\n${result.stderr}`).toBe(0);
    // 덤프에 스니펫 파일들이 등장해야 실제로 읽힌 것이다.
    for (const snippet of ["routes.conf", "proxy-common.conf", "proxy-streaming.conf"]) {
      expect(result.stdout, `${snippet}이 로드되지 않았다`).toContain(snippet);
    }
  }, 60_000);

  /**
   * **이 테스트가 INC-06을 잡는 테스트다.**
   *
   * 버퍼링이 켜져 있으면 nginx는 작은 SSE 프레임들을 버퍼(기본 4k)에 모아 두었다가
   * 업스트림이 연결을 닫을 때 한 번에 내보낸다. 즉 도착 이벤트가 **한 덩어리**가 되고
   * 첫 바이트가 스트림 끝과 같은 시각에 온다.
   *
   * 판정은 도착 시각으로 한다: 첫 도착이 마지막 도착보다 **뚜렷하게 앞서야** 한다.
   */
  it("프레임이 한 덩어리가 아니라 시간에 걸쳐 나뉘어 도착한다", async () => {
    const { arrivals, totalMs } = await readStream("/v1/answer");

    expect(arrivals.length, "도착 이벤트가 한 번뿐이다 — 버퍼링되고 있다").toBeGreaterThanOrEqual(
      3,
    );

    const firstAt = arrivals[0]?.atMs ?? 0;
    const lastAt = arrivals[arrivals.length - 1]?.atMs ?? 0;
    const spread = lastAt - firstAt;

    // 오리진이 프레임을 (FRAME_COUNT-1) * FRAME_GAP_MS 에 걸쳐 흘린다. 그 시간의 절반
    // 이상이 도착 간격으로 남아 있어야 "흘러 왔다"고 말할 수 있다.
    const expectedSpread = (FRAME_COUNT - 1) * FRAME_GAP_MS;
    expect(
      spread,
      `도착이 ${String(Math.round(spread))}ms 안에 몰렸다 (오리진은 ${String(expectedSpread)}ms에 걸쳐 보냈다) — 버퍼링 의심`,
    ).toBeGreaterThan(expectedSpread / 2);

    // 첫 바이트가 스트림 종료를 기다리지 않았다.
    expect(
      firstAt,
      `첫 바이트가 ${String(Math.round(firstAt))}ms에 왔다 (전체 ${String(Math.round(totalMs))}ms) — 끝까지 기다렸다면 버퍼링이다`,
    ).toBeLessThan(totalMs / 2);
  }, 60_000);

  /**
   * **설정 자체의 대조군이다.** 이 경로의 오리진은 `X-Accel-Buffering`을 내지 않으므로
   * (실제 MCP SDK와 같다) 버퍼링을 끄는 것은 오직 `proxy_buffering off` 한 줄뿐이다.
   * 그 줄을 지우면 이 테스트만 빨개진다 — 뮤테이션으로 확인했다.
   */
  it("`/mcp`는 코드 방어선 없이 **설정만으로** 스트리밍된다", async () => {
    const { arrivals, totalMs } = await readStream("/mcp");
    expect(
      arrivals.length,
      "X-Accel-Buffering 없는 경로가 한 덩어리로 왔다 — proxy_buffering off가 사라졌다",
    ).toBeGreaterThanOrEqual(3);

    const firstAt = arrivals[0]?.atMs ?? 0;
    const lastAt = arrivals[arrivals.length - 1]?.atMs ?? 0;
    expect(lastAt - firstAt).toBeGreaterThan(((FRAME_COUNT - 1) * FRAME_GAP_MS) / 2);
    expect(firstAt).toBeLessThan(totalMs / 2);
  }, 60_000);

  /**
   * **INC-06의 진짜 메커니즘을 재는 유일한 테스트다.**
   *
   * 시드 INC-06은 "MCP 세션이 30초에 끊겼다"였다. 절단은 버퍼링이 아니라 **타임아웃**이
   * 낸다 — 그리고 `X-Accel-Buffering: no`는 타임아웃을 전혀 건드리지 못한다(T-019 F-2).
   * 업스트림이 nginx 기본값 60초를 넘겨 침묵해도 스트림이 살아 있어야 `proxy_read_timeout
   * 300s`가 실제로 걸린 것이다. `300s`를 지우면 여기서 65초째에 연결이 끊긴다.
   *
   * 65초가 걸려 기본 off다. 옵트인이 아니면 이 Acceptance는 **판정되지 않은 것**이다.
   */
  it.skipIf(!READ_TIMEOUT_PROOF)(
    "업스트림이 65초 침묵해도 스트림이 끊기지 않는다 (nginx 기본 60s 초과)",
    async () => {
      const { arrivals, totalMs } = await readStream("/v1/idle", 150_000);
      expect(totalMs, "65초를 기다리지 않았다 — 프로브가 동작하지 않았다").toBeGreaterThan(
        60_000,
      );
      expect(
        arrivals.length,
        "침묵 구간을 넘긴 두 번째 프레임이 오지 않았다 — proxy_read_timeout이 300s가 아니다",
      ).toBeGreaterThanOrEqual(2);
    },
    180_000,
  );

  it("스트리밍 스니펫이 안 걸린 `/`는 대조군이다 — 라우팅 자체는 동작한다", async () => {
    const response = await fetch(`http://127.0.0.1:${String(harness.proxyPort)}/anything`, {
      signal: AbortSignal.timeout(30_000),
    });
    // 오리진이 `/v1`·`/mcp` 외에는 404를 낸다. 404가 왔다는 것은 web_upstream으로
    // 제대로 넘어갔다는 뜻이다 — 라우팅이 죽어서 통과한 게 아님을 보인다.
    expect(response.status).toBe(404);
  }, 60_000);
});

// =========================================================================
// Acceptance 3 — MCP 클라이언트가 nginx 경유로 도구 목록 조회
// =========================================================================

describe.skipIf(!HAS_DOCKER)("MCP 도구 목록을 nginx 경유로 조회한다 (T-026 A3)", () => {
  let mcp: ChildProcess;
  let harness: Harness;

  beforeAll(async () => {
    // 스텁이 아니라 **실물 MCP 서버**를 띄운다. 스텁을 두면 nginx는 검증되지만
    // "MCP 클라이언트가 붙는다"는 검증되지 않는다.
    const server = createServer();
    const mcpPort = await listenOnEphemeralPort(server);
    await new Promise<void>((resolve) => server.close(() => {
      resolve();
    }));

    mcp = spawn("npx", ["tsx", "packages/mcp/src/http.cli.ts"], {
      cwd: repoRoot,
      env: {
        ...process.env,
        API_KEYS: `${MCP_API_KEY}:${MCP_PROJECT}`,
        MCP_PORT: String(mcpPort),
        // `tools/list`는 core-api를 부르지 않는다. 도달 불가 주소를 줘서 혹시라도
        // 부르면 테스트가 조용히 성공하지 않게 한다.
        CORE_API_URL: "http://127.0.0.1:1",
      },
      stdio: ["ignore", "pipe", "pipe"],
    });

    await new Promise<void>((resolve, reject) => {
      const timer = setTimeout(() => {
        reject(new Error("MCP 서버가 시간 안에 뜨지 않았다"));
      }, 60_000);
      mcp.stdout?.on("data", (chunk: Buffer) => {
        if (chunk.toString().includes("mcp.listening")) {
          clearTimeout(timer);
          resolve();
        }
      });
      mcp.on("error", reject);
    });

    harness = await startNginx(
      "sentinel-kb-t026-nginx-mcp",
      [
        `upstream core_api_upstream { server host.docker.internal:${String(mcpPort)}; }`,
        `upstream mcp_upstream { server host.docker.internal:${String(mcpPort)}; }`,
        `upstream web_upstream { server host.docker.internal:${String(mcpPort)}; }`,
        "",
      ].join("\n"),
    );
  }, 300_000);

  afterAll(async () => {
    await harness?.stop();
    mcp?.kill("SIGTERM");
  });

  /**
   * 판정을 손으로 만든 JSON-RPC 왕복이 아니라 **`pnpm mcp:ping`**으로 한다.
   * docs/connect.md §8-1이 정의한 종료 코드 계약이 그대로 판정 기준이 된다:
   * 0=도구 5개 확인, 76=nginx 라우팅 문제, 77=인증 문제. 실패 시 "누가 고칠 문제인지"까지
   * 나온다는 것이 이 방식의 값어치다.
   */
  it("`pnpm mcp:ping`이 nginx 경유로 도구 5개를 확인한다 (exit 0)", () => {
    const result = spawnSync("npx", ["tsx", "scripts/mcp-ping.cli.ts"], {
      cwd: repoRoot,
      encoding: "utf8",
      env: {
        ...process.env,
        SENTINEL_KB_URL: `http://127.0.0.1:${String(harness.proxyPort)}`,
        SENTINEL_KB_KEY: MCP_API_KEY,
      },
      timeout: 120_000,
    });
    expect(
      result.status,
      [
        `mcp:ping 종료 코드 ${String(result.status)} (docs/connect.md §8-1)`,
        `stderr: ${result.stderr}`,
      ].join("\n"),
    ).toBe(0);
  }, 180_000);

  it("등록되지 않은 키는 nginx를 지나 401을 받는다 (Bearer가 프록시를 그대로 통과한다)", async () => {
    const response = await fetch(`http://127.0.0.1:${String(harness.proxyPort)}/mcp`, {
      method: "POST",
      headers: {
        authorization: "Bearer wrong-key",
        "content-type": "application/json",
        accept: "application/json, text/event-stream",
      },
      body: JSON.stringify({
        jsonrpc: "2.0",
        id: 1,
        method: "initialize",
        params: {
          protocolVersion: "2025-06-18",
          capabilities: {},
          clientInfo: { name: "t026", version: "0" },
        },
      }),
      signal: AbortSignal.timeout(30_000),
    });
    expect(response.status).toBe(401);
    // nginx가 헤더를 삼키면 이 챌린지가 사라진다.
    expect(response.headers.get("www-authenticate")).toContain("Bearer");
  }, 60_000);
});
