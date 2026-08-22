/**
 * compose가 **해소한 값**을 계약과 대조한다 (T-026).
 *
 * `nginx-contract.spec.ts`는 파일의 문자열을 본다. 이 파일은 `docker compose config`를 실제로
 * 돌려서 앵커·기본값·오버레이가 다 적용된 **최종 값**을 본다. 둘 다 필요한 이유는
 * 앵커를 잘못 참조해도 문자열 검사는 통과하기 때문이다.
 *
 * docker가 없으면 skip된다 — 그리고 `require-docker.int.spec.ts`가 CI에서 그 skip을
 * 하드 실패로 승격한다.
 */
import { spawnSync } from "node:child_process";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";

import { dockerAvailable } from "./require-docker.int.spec.js";

const repoRoot = fileURLToPath(new URL("..", import.meta.url));
const HAS_DOCKER = dockerAvailable();

/** 테스트용 env. **실제 시크릿이 아니다** — 값의 모양만 맞춘 더미다. */
const FIXTURE_ENV: Record<string, string> = {
  API_KEYS: "testkey:sentinel-kb",
  MONGODB_URI: "mongodb+srv://user:pass@cluster/sentinel",
  EMBEDDING_MODEL: "voyage-3",
  ANTHROPIC_API_KEY: "sk-test",
  ANTHROPIC_MODEL: "claude-opus-5",
  CORE_API_KEY: "testkey",
  AWS_REGION: "ap-northeast-2",
  LOG_GROUP_NAME: "/sentinel-kb/prod/app",
  ECR_REGISTRY: "111122223333.dkr.ecr.ap-northeast-2.amazonaws.com",
  IMAGE_TAG: "test-tag",
  DOMAIN_NAME: "kb.example.com",
  CERTBOT_EMAIL: "ops@example.com",
};

function writeEnvFile(overrides: Record<string, string | null> = {}): string {
  // `null`은 "이 변수를 빼라"는 뜻이다 — 필수 env 누락을 재현하는 데 쓴다.
  const merged = Object.fromEntries(
    Object.entries({ ...FIXTURE_ENV, ...overrides }).filter(
      (entry): entry is [string, string] => entry[1] !== null,
    ),
  );
  const dir = mkdtempSync(join(tmpdir(), "sentinel-compose-"));
  const path = join(dir, "fixture.env");
  writeFileSync(
    path,
    `${Object.entries(merged)
      .map(([key, value]) => `${key}=${value}`)
      .join("\n")}\n`,
  );
  return path;
}

interface ComposeService {
  readonly environment?: Record<string, string | null>;
  readonly depends_on?: Record<string, { readonly condition?: string }>;
  readonly mem_limit?: number | string;
  readonly restart?: string;
  readonly logging?: { readonly driver?: string };
  readonly healthcheck?: { readonly test?: readonly string[] };
  readonly image?: string;
  readonly ports?: readonly { readonly published?: string; readonly target?: number }[];
}

interface ComposeConfig {
  readonly services: Record<string, ComposeService>;
}

function runComposeConfig(
  files: readonly string[],
  envFile: string,
): { status: number; stdout: string; stderr: string } {
  const args = files.flatMap((file) => ["-f", file]);
  const result = spawnSync(
    "docker",
    ["compose", ...args, "--env-file", envFile, "config", "--format", "json"],
    // `--env-file`이 기본 `.env` 탐색을 대체하므로 개발자 로컬의 `.env`가 결과를 흔들지 않는다.
    { cwd: repoRoot, encoding: "utf8" },
  );
  return { status: result.status ?? -1, stdout: result.stdout ?? "", stderr: result.stderr ?? "" };
}

function config(files: readonly string[], envFile: string): ComposeConfig {
  const result = runComposeConfig(files, envFile);
  if (result.status !== 0) throw new Error(`docker compose config 실패: ${result.stderr}`);
  return JSON.parse(result.stdout) as ComposeConfig;
}

const BASE = ["docker-compose.yml"];
const PROD = ["docker-compose.yml", "docker-compose.prod.yml"];

describe.skipIf(!HAS_DOCKER)("compose 베이스 계약 (T-026)", () => {
  const resolved = config(BASE, writeEnvFile());
  const service = (name: string): ComposeService => {
    const found = resolved.services[name];
    expect(found, `compose에 ${name} 서비스가 없다`).toBeDefined();
    return found as ComposeService;
  };

  it("specs/06이 말하는 5개 서비스가 전부 있다 (+ 인덱스 부트스트랩 one-shot)", () => {
    expect(Object.keys(resolved.services).sort()).toEqual(
      ["core-api", "db-init", "mcp", "nginx", "web", "worker"].sort(),
    );
  });

  // ================================================ 인계 8: API_KEYS 동일성
  /**
   * **이 태스크에서 가장 중요한 단언이다.** MCP는 호출자 Bearer를 그대로 core-api로
   * 넘긴다(confused deputy 방지, T-014 D-5). 두 값이 갈라지면 MCP 연결도 도구 목록도
   * 정상인데 **도구 호출 시점에만** core-api가 401을 낸다. 두 프로세스는 서로의 env를
   * 모르므로 **코드로는 절대 탐지할 수 없고**, compose 설정이 유일한 방어선이다.
   */
  it("core-api와 mcp가 **글자 그대로 같은** API_KEYS를 받는다", () => {
    const coreApiKeys = service("core-api").environment?.["API_KEYS"];
    const mcpKeys = service("mcp").environment?.["API_KEYS"];
    expect(coreApiKeys, "core-api에 API_KEYS가 없다").toBeTruthy();
    expect(mcpKeys, "mcp에 API_KEYS가 없다").toBeTruthy();
    expect(mcpKeys, "MCP와 core-api의 API_KEYS가 갈라졌다 — docs/connect.md §2").toBe(
      coreApiKeys,
    );
  });

  it("API_KEYS가 없으면 `compose config`가 **거절한다** (조용한 기본값 금지)", () => {
    const result = runComposeConfig(BASE, writeEnvFile({ API_KEYS: null }));
    expect(result.status, "API_KEYS 없이도 설정이 해소됐다").not.toBe(0);
    expect(result.stderr).toContain("API_KEYS");
  });

  it("MONGODB_URI·ANTHROPIC_API_KEY도 같은 규약이다 — 부팅 전에 죽는다", () => {
    for (const name of ["MONGODB_URI", "ANTHROPIC_API_KEY", "CORE_API_KEY"]) {
      const result = runComposeConfig(BASE, writeEnvFile({ [name]: null }));
      expect(result.status, `${name} 없이도 설정이 해소됐다`).not.toBe(0);
    }
  });

  // ================================================ 인계 9: 인덱스 부트스트랩 순서
  /**
   * `db:search-indexes`가 **compose up 이전**에 완료되어야 첫 검색이 성공한다(T-010 비준 3).
   * 이후로 밀리면 첫 `/v1/search`가 "Index vec_idx not initialized"로 죽고, 그건
   * 배포 실패가 아니라 "가끔 검색이 안 됨"으로 보고된다.
   */
  it("core-api와 worker가 db-init의 **정상 종료**를 기다린다", () => {
    for (const name of ["core-api", "worker"]) {
      expect(
        service(name).depends_on?.["db-init"]?.condition,
        `${name}이 인덱스 부트스트랩을 기다리지 않는다`,
      ).toBe("service_completed_successfully");
    }
  });

  it("db-init은 재시작하지 않는다 — one-shot이 재시작하면 게이트가 영영 안 닫힌다", () => {
    expect(service("db-init").restart).toBe("no");
  });

  it("nginx는 core-api가 healthy가 된 뒤에 뜬다", () => {
    expect(service("nginx").depends_on?.["core-api"]?.condition).toBe("service_healthy");
  });

  // ================================================ 인계 3: t3.small 메모리 예산
  /**
   * t3.small은 2GiB인데 컨테이너가 5개다(T-025 F-2). 여유가 없어 상한을 명시하지 않으면
   * Next.js 하나가 커널 OOM killer를 부르고, 그때 죽는 것이 **누구인지 고를 수 없다.**
   * 상한이 있으면 초과한 컨테이너만 죽고 `restart: unless-stopped`가 되살린다.
   *
   * 근거 수치는 docker/README.md "메모리 예산" 절에 있다.
   */
  const HOST_MIB = 1966; // AL2023이 t3.small에서 실제로 보고하는 대략치 (2GiB - 커널 예약)
  const HOST_RESERVE_MIB = 320; // 커널 + dockerd + ssm-agent
  const CONCURRENT_BUDGET_MIB = HOST_MIB - HOST_RESERVE_MIB;

  const toMib = (value: number | string | undefined): number =>
    value === undefined ? 0 : Math.round(Number(value) / (1024 * 1024));

  it("동시에 도는 컨테이너들의 mem_limit 합이 t3.small 예산 안에 있다", () => {
    // db-init은 one-shot이고 앱 컨테이너보다 **먼저 끝난다** — 동시 예산에서 뺀다.
    const concurrent = ["nginx", "core-api", "mcp", "worker", "web"];
    const total = concurrent.reduce((sum, name) => sum + toMib(service(name).mem_limit), 0);
    expect(total, `동시 mem_limit 합계 ${String(total)}MiB`).toBeLessThanOrEqual(
      CONCURRENT_BUDGET_MIB,
    );
    // 상한이 0이면(=미설정) 위 합계가 통과해 버린다. 전부 실제로 걸려 있는지 확인한다.
    for (const name of concurrent) {
      expect(toMib(service(name).mem_limit), `${name}에 mem_limit이 없다`).toBeGreaterThan(0);
    }
  });

  it("Node 서비스는 힙 상한을 mem_limit 아래로 못박는다", () => {
    // 이게 없으면 V8이 **호스트** 메모리를 기준으로 힙을 키우다 컨테이너 한도에 먼저
    // 부딪혀 GC 기회 없이 OOM-kill 당한다.
    for (const name of ["core-api", "mcp", "worker", "web"]) {
      const nodeOptions = service(name).environment?.["NODE_OPTIONS"] ?? "";
      const heap = /--max-old-space-size=(\d+)/.exec(nodeOptions)?.[1];
      expect(heap, `${name}에 --max-old-space-size가 없다`).toBeDefined();
      expect(Number(heap)).toBeLessThan(toMib(service(name).mem_limit));
    }
  });

  // ================================================ 재시작·로그·헬스체크
  it("앱 서비스는 재시작 정책과 로그 드라이버를 갖는다 (T-026 Scope)", () => {
    for (const name of ["core-api", "mcp", "worker", "web", "nginx"]) {
      expect(service(name).restart, `${name}에 재시작 정책이 없다`).toBe("unless-stopped");
      expect(service(name).logging?.driver, `${name}에 로그 드라이버가 없다`).toBe("json-file");
    }
  });

  it("HTTP 표면이 있는 서비스는 헬스체크를 갖는다", () => {
    for (const name of ["core-api", "mcp", "web", "nginx"]) {
      expect(service(name).healthcheck?.test, `${name}에 헬스체크가 없다`).toBeTruthy();
    }
  });

  // ================================================ 포트·주소 계약
  it("mcp가 compose 네트워크 안의 core-api를 가리킨다", () => {
    expect(service("mcp").environment?.["CORE_API_URL"]).toBe("http://core-api:3001");
    expect(service("mcp").environment?.["MCP_PORT"]).toBe("3002");
    expect(service("core-api").environment?.["CORE_API_PORT"]).toBe("3001");
  });

  it("외부로 열리는 포트는 nginx 하나뿐이다 — SG가 443만 여는 것과 같은 모양이다", () => {
    for (const [name, svc] of Object.entries(resolved.services)) {
      if (name === "nginx") continue;
      expect(svc.ports ?? [], `${name}이 호스트 포트를 직접 연다`).toEqual([]);
    }
  });

  it("웹의 core-api 키가 브라우저 번들로 새지 않는 이름을 쓴다", () => {
    const env = service("web").environment ?? {};
    expect(env["CORE_API_KEY"]).toBeTruthy();
    expect(Object.keys(env).filter((key) => key.startsWith("NEXT_PUBLIC_"))).toEqual([]);
  });
});

describe.skipIf(!HAS_DOCKER)("compose 프로덕션 오버레이 (T-026, specs/06)", () => {
  const resolved = config(PROD, writeEnvFile());
  const service = (name: string): ComposeService => resolved.services[name] as ComposeService;

  it("모든 앱 이미지가 ECR에서 온다 (로컬 build가 남아 있지 않다)", () => {
    for (const name of ["core-api", "mcp", "worker", "web", "nginx", "db-init"]) {
      expect(service(name).image, `${name}이 ECR 이미지를 쓰지 않는다`).toContain(
        "dkr.ecr.ap-northeast-2.amazonaws.com/sentinel-kb-",
      );
      expect(service(name).image).toContain(":test-tag");
    }
  });

  it("로그가 CloudWatch로 간다 (specs/06 관측 행)", () => {
    for (const name of ["core-api", "mcp", "worker", "web", "nginx"]) {
      expect(service(name).logging?.driver, `${name}의 로그가 CloudWatch로 가지 않는다`).toBe(
        "awslogs",
      );
    }
  });

  it("nginx만 443을 연다. 22는 어디에도 없다 (specs/06 네트워크 행)", () => {
    const published = Object.entries(resolved.services).flatMap(([name, svc]) =>
      (svc.ports ?? []).map((port) => ({ name, published: port.published })),
    );
    expect(published.map((entry) => entry.name)).toEqual(["nginx", "nginx"]);
    expect(published.map((entry) => entry.published).sort()).toEqual(["443", "80"]);
    expect(published.some((entry) => entry.published === "22")).toBe(false);
  });

  it("nginx가 prod 모드로 뜨고 도메인을 받는다", () => {
    expect(service("nginx").environment?.["NGINX_MODE"]).toBe("prod");
    expect(service("nginx").environment?.["DOMAIN_NAME"]).toBe("kb.example.com");
  });

  it("certbot이 평상시 `up`에 뜨고, 최초 발급용 one-shot은 profile 뒤에 숨는다", () => {
    expect(resolved.services["certbot"]).toBeDefined();
    // `certbot-init`은 `--profile bootstrap` 없이는 나타나지 않아야 한다.
    expect(resolved.services["certbot-init"]).toBeUndefined();
  });
});
