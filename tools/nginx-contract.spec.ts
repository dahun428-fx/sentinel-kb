/**
 * T-026 nginx·compose 설정 가드.
 *
 * 설정은 코드보다 조용히 썩는다. `proxy_buffering off` 한 줄이 사라져도 lint도 typecheck도
 * 테스트도 초록이고, 증상은 **배포 후 스트리밍이 끊길 때** 처음 나타난다. 시드 INC-06이
 * 정확히 그 사건이다. T-017의 `connect-docs.spec.ts`가 문서에 대해 한 일을 여기서는
 * nginx 설정과 compose에 대해 한다.
 *
 * **정본은 `specs/06-deployment.md`다** (CLAUDE.md 원칙 1). 이 파일은 스펙의 라우팅표를
 * 파싱해서 실제 설정과 대조한다 — 스펙을 다시 옮겨 적지 않는다. 옮겨 적으면 그 사본이
 * 또 하나의 썩을 자리가 된다.
 *
 * docker가 필요 없는 **정적** 판정만 여기 있다. 실제 동작(스트리밍이 청크로 도달하는가)은
 * `nginx-streaming.int.spec.ts`가, compose가 해소한 값은 `compose-contract.int.spec.ts`가 본다.
 */
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";

const repoRoot = fileURLToPath(new URL("..", import.meta.url));

function read(relativePath: string): string {
  return readFileSync(join(repoRoot, relativePath), "utf8");
}

const deploymentSpec = read("specs/06-deployment.md");
const routesConf = read("nginx/snippets/routes.conf");
const streamingConf = read("nginx/snippets/proxy-streaming.conf");
const upstreamsConf = read("nginx/conf.d/00-upstreams.conf");
const devConf = read("nginx/available/dev.conf");
const prodConf = read("nginx/available/prod.conf");
const envExample = read(".env.example");
const composeYml = read("docker-compose.yml");
const composeProdYml = read("docker-compose.prod.yml");
const dockerfileNode = read("docker/Dockerfile.node");
const lockfile = read("pnpm-lock.yaml");

/** 주석(`#` 이후)을 걷어낸 지시문 텍스트. 주석 속 문자열이 판정을 통과시키면 안 된다. */
function stripComments(conf: string): string {
  return conf
    .split("\n")
    .map((line) => line.replace(/#.*$/, ""))
    .join("\n");
}

interface LocationBlock {
  /** `= /health`, `/v1` 같은 매치 지시자 원문. */
  readonly match: string;
  readonly body: string;
}

/** 평평한 nginx 설정에서 최상위 `location` 블록을 뽑는다. 중괄호를 세어 중첩을 견딘다. */
function parseLocations(conf: string): LocationBlock[] {
  const source = stripComments(conf);
  const blocks: LocationBlock[] = [];
  const header = /location\s+([^{]+?)\s*\{/g;
  let match: RegExpExecArray | null;
  while ((match = header.exec(source)) !== null) {
    let depth = 1;
    let index = header.lastIndex;
    while (index < source.length && depth > 0) {
      const char = source[index];
      if (char === "{") depth += 1;
      else if (char === "}") depth -= 1;
      index += 1;
    }
    blocks.push({ match: match[1] ?? "", body: source.slice(header.lastIndex, index - 1) });
  }
  return blocks;
}

const locations = parseLocations(routesConf);
const locationByMatch = new Map(locations.map((block) => [block.match, block]));

/** `upstream <name> { server host:port; }` → `name → host:port` */
function parseUpstreams(conf: string): Map<string, string> {
  const result = new Map<string, string>();
  const source = stripComments(conf);
  const pattern = /upstream\s+(\S+)\s*\{([^}]*)\}/g;
  let match: RegExpExecArray | null;
  while ((match = pattern.exec(source)) !== null) {
    const server = /server\s+([^\s;]+)\s*;/.exec(match[2] ?? "");
    if (match[1] !== undefined && server?.[1] !== undefined) result.set(match[1], server[1]);
  }
  return result;
}

const upstreams = parseUpstreams(upstreamsConf);

/** location 본문의 `proxy_pass http://<upstream>;`을 `host:port`로 해소한다. */
function resolveProxyTarget(block: LocationBlock): string | undefined {
  const proxyPass = /proxy_pass\s+http:\/\/([^\s;/]+)/.exec(block.body);
  const name = proxyPass?.[1];
  return name === undefined ? undefined : upstreams.get(name);
}

// ======================================================= specs/06 라우팅표 대조

interface SpecRoute {
  readonly path: string;
  readonly target: string;
}

/** specs/06의 라우팅 코드블록에서 `/path → service:port` 줄을 읽는다. */
function parseSpecRoutes(spec: string): SpecRoute[] {
  const section = /## nginx 라우팅\s*```([\s\S]*?)```/.exec(spec)?.[1] ?? "";
  return [...section.matchAll(/^(\/\S*)\s+→\s+([a-z0-9-]+:\d+)/gm)].map((match) => ({
    path: match[1] ?? "",
    target: match[2] ?? "",
  }));
}

const specRoutes = parseSpecRoutes(deploymentSpec);

describe("specs/06 라우팅표 ↔ nginx 설정 (T-026)", () => {
  it("스펙에서 라우트 3개를 읽어낸다 (파싱 자체의 회귀 방지)", () => {
    expect(specRoutes.map((route) => route.path)).toEqual(["/mcp", "/v1", "/"]);
  });

  it("스펙의 모든 라우트가 nginx에 있고 **같은 업스트림**을 가리킨다", () => {
    for (const route of specRoutes) {
      const block = locationByMatch.get(route.path);
      expect(block, `nginx에 location ${route.path}가 없다`).toBeDefined();
      expect(
        resolveProxyTarget(block as LocationBlock),
        `${route.path}의 업스트림이 specs/06(${route.target})과 다르다`,
      ).toBe(route.target);
    }
  });

  /**
   * ⚠️ 이 테스트가 실패하면 "라우트를 추가했는데 specs/06을 안 고쳤다"는 뜻이다.
   * 목록을 늘려서 통과시키지 마라 — 스펙을 먼저 고치는 것이 CLAUDE.md 원칙 1이다.
   *
   * 현재 허용된 초과분은 `= /health` 하나다. specs/06의 관측 행이 "`/health` 모니터"를
   * 요구하는데 라우팅표에는 `/health`가 없어, 표대로면 모니터가 core-api가 아니라 web에
   * 닿는다. 이 초과분은 **인간 비준 대기 중인 스펙 결함**이다(T-026 Findings F-1).
   */
  it("스펙에 없는 라우트를 발명하지 않는다 (`= /health` 하나만 예외, 비준 대기)", () => {
    const documentedExtras = ["= /health"];
    const specPaths = new Set(specRoutes.map((route) => route.path));
    const extras = locations.map((block) => block.match).filter((match) => !specPaths.has(match));
    expect(extras.sort()).toEqual(documentedExtras.sort());
  });

  it("`/health` 초과분은 core-api를 가리킨다 — web으로 가면 모니터가 거짓 초록이 된다", () => {
    const health = locationByMatch.get("= /health");
    expect(health).toBeDefined();
    expect(resolveProxyTarget(health as LocationBlock)).toBe("core-api:3001");
  });
});

// ============================================================ 스트리밍 (INC-06)

describe("SSE·MCP 스트리밍 설정 (T-026 Scope, 시드 INC-06)", () => {
  it("`proxy_buffering off`가 있다 — 이 한 줄이 INC-06의 원인이었다", () => {
    expect(stripComments(streamingConf)).toMatch(/^\s*proxy_buffering\s+off\s*;/m);
  });

  it("`proxy_read_timeout 300s`가 있다 — 기본 60s로는 긴 생성이 잘린다", () => {
    expect(stripComments(streamingConf)).toMatch(/^\s*proxy_read_timeout\s+300s\s*;/m);
  });

  it("gzip을 끈다 — 압축 버퍼가 차기를 기다리면 버퍼링을 끈 의미가 없다", () => {
    expect(stripComments(streamingConf)).toMatch(/^\s*gzip\s+off\s*;/m);
  });

  it("캐시를 끈다 — proxy_cache가 켜져 있으면 nginx가 응답을 다시 모은다", () => {
    expect(stripComments(streamingConf)).toMatch(/^\s*proxy_cache\s+off\s*;/m);
  });

  /**
   * **specs/06 문면과 다른 지점이다.** 스펙 18행은 버퍼링 해제를 `/mcp`에만 적었는데
   * `/v1/answer`도 `text/event-stream`으로 답한다(T-019). `/v1`이 버퍼링된 채면
   * INC-06이 core-api 쪽에서 그대로 재발한다. specs/06 정정이 필요하다(F-1).
   */
  it("**`/mcp`와 `/v1` 양쪽**이 스트리밍 스니펫을 include한다", () => {
    for (const path of ["/mcp", "/v1"]) {
      const block = locationByMatch.get(path);
      expect(block, `location ${path}가 없다`).toBeDefined();
      expect(
        (block as LocationBlock).body,
        `${path}에 proxy-streaming.conf include가 없다 — 스트리밍이 버퍼링된다`,
      ).toContain("snippets/proxy-streaming.conf");
    }
  });

  it("코드 방어선(X-Accel-Buffering)이 설정을 대체하지 못하는 이유가 적혀 있다", () => {
    // 근거가 사라지면 다음 사람이 "코드가 헤더를 보내니 설정은 빼도 되겠다"로 되돌린다.
    expect(streamingConf).toContain("proxy_read_timeout");
    expect(streamingConf).toContain("X-Accel-Buffering");
  });
});

// ================================================================ 설정 단일화

describe("라우팅 정의가 한 벌뿐이다 (T-026)", () => {
  it("dev·prod 서버 블록이 같은 routes.conf를 include한다", () => {
    for (const [name, conf] of [
      ["dev.conf", devConf],
      ["prod.conf", prodConf],
    ] as const) {
      expect(conf, `${name}이 routes.conf를 include하지 않는다`).toContain(
        "snippets/routes.conf",
      );
    }
  });

  it("서버 블록이 라우팅을 복붙하지 않는다 — 갈라지면 배포 후에야 드러난다", () => {
    for (const [name, conf] of [
      ["dev.conf", devConf],
      ["prod.conf", prodConf],
    ] as const) {
      expect(parseLocations(conf), `${name}에 location 블록이 직접 적혀 있다`).toEqual([]);
    }
  });

  it("prod만 TLS를 건다 — 로컬에서는 인증서를 발급할 수 없다", () => {
    expect(prodConf).toContain("ssl_certificate");
    expect(devConf).not.toContain("ssl_certificate");
  });
});

// =========================================================== 포트·서비스 이름

describe("업스트림 ↔ compose 서비스·포트 (T-026)", () => {
  const declaredPorts = new Map([
    ["CORE_API_PORT", "3001"],
    ["MCP_PORT", "3002"],
    ["WEB_PORT", "3000"],
  ]);

  it(".env.example이 선언한 포트와 업스트림 포트가 같다", () => {
    for (const [envName, port] of declaredPorts) {
      expect(envExample, `.env.example에 ${envName}이 없다`).toContain(`${envName}=${port}`);
    }
    expect([...upstreams.values()].sort()).toEqual(
      ["core-api:3001", "mcp:3002", "web:3000"].sort(),
    );
  });

  it("업스트림 호스트 이름이 실제 compose 서비스 이름이다", () => {
    for (const target of upstreams.values()) {
      const service = target.split(":")[0] ?? "";
      expect(composeYml, `compose에 ${service} 서비스가 없다`).toMatch(
        new RegExp(`^\\s{2}${service}:$`, "m"),
      );
    }
  });
});

// ================================================ API_KEYS 동일성 (T-014 D-5)

describe("MCP와 core-api의 API_KEYS 동일성 (T-014 D-5, docs/connect.md §2)", () => {
  /**
   * 이 실패는 **코드로 탐지할 수 없다** — 두 프로세스는 서로의 env를 모르고, 증상은
   * 도구 호출 시점의 401로만 나타난다. compose 설정이 유일한 방어선이라 앵커 구조 자체를
   * 잠근다. 해소된 값 대조는 `compose-contract.int.spec.ts`가 한다.
   */
  it("compose가 API_KEYS를 앵커 하나로 정의한다 (복붙 두 벌이 아니다)", () => {
    const definitions = [...composeYml.matchAll(/^\s*API_KEYS:\s*(.+)$/gm)];
    expect(definitions, "API_KEYS 정의가 한 곳이 아니다 — 갈라질 자리가 생겼다").toHaveLength(1);
    expect(composeYml).toContain("x-shared-auth: &shared-auth");
  });

  it("core-api와 mcp가 둘 다 그 앵커를 참조한다", () => {
    const references = [...composeYml.matchAll(/<<:\s*(\[[^\]]*\]|\*[\w-]+)/g)]
      .map((match) => match[1] ?? "")
      .filter((value) => value.includes("*shared-auth"));
    expect(references.length).toBeGreaterThanOrEqual(2);
  });
});

// ===================================================== env 문서화 (T-014 F-2)

describe(".env.example이 서비스가 실제로 읽는 env를 담는다 (T-014 F-2, T-023 F-3)", () => {
  // docs/connect.md §5 표와 packages/web/src/lib/env.ts가 근거다. 이 넷과 웹 둘이
  // .env.example에 없어 "표가 정본"인 상태로 남아 있었다.
  const required = [
    "CORE_API_URL",
    "CORE_API_TIMEOUT_MS",
    "CORE_API_MAX_ATTEMPTS",
    "SENTINEL_KB_KEY",
    "CORE_API_KEY",
  ];

  it.each(required)("%s가 .env.example에 있다", (name) => {
    expect(envExample).toMatch(new RegExp(`^${name}=`, "m"));
  });
});

// ======================================================== 시크릿 하드코딩 금지

describe("시크릿 하드코딩 금지 (CLAUDE.md)", () => {
  const configFiles = [
    ["docker-compose.yml", composeYml],
    ["docker-compose.prod.yml", composeProdYml],
    ["nginx/snippets/routes.conf", routesConf],
    ["nginx/available/prod.conf", prodConf],
    ["docker/Dockerfile.node", dockerfileNode],
  ] as const;

  it.each(configFiles)("%s에 리터럴 시크릿이 없다", (_name, content) => {
    // 시크릿 계열 키는 반드시 `${VAR...}` 참조여야 한다.
    const assignments = [
      ...content.matchAll(/^\s*(API_KEYS|[A-Z_]*API_KEY|SENTINEL_KB_KEY|MONGODB_URI):\s*(.+)$/gm),
    ];
    for (const assignment of assignments) {
      expect(
        assignment[2],
        `${assignment[1] ?? ""}에 리터럴 값이 박혀 있다: ${assignment[2] ?? ""}`,
      ).toMatch(/^\$\{/);
    }
  });

  it("compose가 `.env`를 이미지 빌드 컨텍스트로 흘리지 않는다", () => {
    expect(read(".dockerignore")).toMatch(/^\.env$/m);
  });
});

// =================================================== tsx 버전 드리프트 (F-4)

describe("런타임 이미지의 tsx 버전이 lockfile과 같다 (T-026)", () => {
  /**
   * tsx는 루트 devDependency라 `--prod` 설치에 딸려 오지 않아 이미지가 따로 설치한다.
   * 그 버전이 lockfile과 갈라지면 **컨테이너만 다른 트랜스파일러로 도는** 상태가 되고,
   * 그건 "로컬은 되는데 배포는 안 된다"의 가장 찾기 어려운 형태다.
   */
  it("Dockerfile.node의 TSX_VERSION 기본값이 pnpm-lock.yaml의 해소 버전과 같다", () => {
    const pinned = /^ARG TSX_VERSION=(\S+)$/m.exec(dockerfileNode)?.[1];
    const resolved = /^\s{2}tsx@(\d+\.\d+\.\d+):$/m.exec(lockfile)?.[1];
    expect(pinned, "Dockerfile.node에 ARG TSX_VERSION이 없다").toBeDefined();
    expect(resolved, "pnpm-lock.yaml에서 tsx 버전을 읽지 못했다").toBeDefined();
    expect(pinned).toBe(resolved);
  });
});

// ======================================================= web 표면 인증 (T-042)

/**
 * **이 절은 docker 없이도 죽어야 한다.**
 *
 * `nginx-streaming.int.spec.ts`와 `compose-contract.int.spec.ts`는 docker가 없으면 skip된다
 * (감사 B §7: 72건 skip 중 27건이 이 둘). 인증 단언을 거기에만 두면 docker 없는 머신의
 * `pnpm verify`는 **아무것도 재지 않고 초록**이 된다 — 그건 통과가 아니라 침묵이다.
 * 그래서 판정의 본체를 설정 파일 파싱으로 여기 둔다. 실물 401 왕복은 int가 덧붙이는 증거지,
 * 유일한 증거가 아니다.
 */

const authBasicConf = read("nginx/snippets/auth-basic.conf");
const dockerfileNginx = read("docker/Dockerfile.nginx");
const gitignore = read(".gitignore");
const rtm = read("docs/analysis/RTM.md");

/** location 본문의 스니펫 include를 실제 파일 내용으로 펼친다. 없는 스니펫이면 던진다. */
function expandIncludes(body: string): string {
  return stripComments(body).replace(
    /include\s+\/etc\/nginx\/snippets\/([\w.-]+)\s*;/g,
    (_match, name: string) => stripComments(read(`nginx/snippets/${name}`)),
  );
}

/**
 * nginx의 매치 규칙을 흉내 낸다: exact(`=`)가 먼저, 그다음 **최장 접두** 매치.
 * `/records`·`/articles`처럼 자기 location이 없는 경로가 어디로 떨어지는지가 이 태스크의
 * 쟁점이라, 경로 목록을 손으로 적는 대신 매칭을 실제로 돌린다.
 */
function locationFor(path: string): LocationBlock {
  const exact = locations.find((block) => block.match === `= ${path}`);
  if (exact !== undefined) return exact;
  const prefixes = locations
    .filter((block) => !/^[=~^]/.test(block.match) && path.startsWith(block.match))
    .sort((a, b) => b.match.length - a.match.length);
  const best = prefixes[0];
  if (best === undefined) throw new Error(`${path}에 매치되는 location이 없다`);
  return best;
}

/** 해당 location이 basic 인증을 **실제로** 요구하는가 (include를 펼친 뒤 판정). */
function requiresBasicAuth(block: LocationBlock): boolean {
  const body = expandIncludes(block.body);
  const realm = /auth_basic\s+("[^"]*"|off)\s*;/.exec(body)?.[1];
  const userFile = /auth_basic_user_file\s+(\S+)\s*;/.exec(body)?.[1];
  return realm !== undefined && realm !== "off" && userFile !== undefined;
}

describe("web 표면이 인증 뒤에 있다 (T-042, specs/00 NFR-04)", () => {
  /**
   * 감사 B-1이 실측한 구멍이다: `packages/web/src`에 인증 문자열 0건 + `location /`
   * 무조건 통과. 도메인에 도달하는 누구나 아티클을 **발행**할 수 있었다.
   */
  it.each(["/", "/records", "/articles", "/articles/some-id/edit", "/_next/static/chunk.js"])(
    "%s는 basic 인증을 요구한다",
    (path) => {
      const block = locationFor(path);
      expect(
        requiresBasicAuth(block),
        `${path}가 location ${block.match}로 떨어지는데 거기에 인증이 없다`,
      ).toBe(true);
    },
  );

  it("`/records`·`/articles`는 `/`로 떨어진다 — 전용 location은 인증 밖으로 새는 길이다", () => {
    // 누군가 `location /articles { ... }`를 새로 만들면서 auth include를 빠뜨리면
    // 위 단언은 그 location을 보게 되고 여기서 갈림이 드러난다.
    for (const path of ["/records", "/articles"]) {
      expect(locationFor(path).match, `${path}에 전용 location이 생겼다`).toBe("/");
    }
  });

  it("`/health`는 인증 **밖**이다 — 모니터는 자격증명을 들고 있지 않다", () => {
    const health = locationFor("/health");
    expect(health.match).toBe("= /health");
    expect(requiresBasicAuth(health), "`/health`에 인증이 걸렸다 — 모니터가 401을 받는다").toBe(
      false,
    );
  });

  it("compose의 nginx 헬스체크가 그 면제 경로를 **무자격으로** 두드린다", () => {
    // 면제의 근거를 문장이 아니라 설정으로 묶어 둔다. 헬스체크에 자격증명을 넣어야 하는
    // 상황이 오면 그건 인증 경계를 잘못 그었다는 신호다.
    const healthcheck = /wget[^\n]*\/health/.exec(composeYml)?.[0] ?? "";
    expect(healthcheck, "nginx 헬스체크가 `/health`를 두드리지 않는다").not.toBe("");
    expect(healthcheck).not.toMatch(/--user|--password|Authorization/i);
  });

  it("`/mcp`·`/v1`에는 basic 인증을 걸지 않는다 — 그 둘은 앱 계층 Bearer다", () => {
    // 여기에 basic을 걸면 MCP 클라이언트와 core-api 호출자가 전부 끊긴다.
    // 인증이 없다는 뜻이 아니다 — T-007·T-014가 프로세스 안에서 Bearer를 검사한다.
    for (const path of ["/mcp", "/v1"]) {
      expect(requiresBasicAuth(locationFor(path)), `${path}에 basic 인증이 걸렸다`).toBe(false);
    }
  });

  it("server 블록에 auth_basic을 걸지 않는다 — 걸면 `/health`가 상속받아 401이 된다", () => {
    for (const [name, conf] of [
      ["dev.conf", devConf],
      ["prod.conf", prodConf],
      ["proxy-common.conf", read("nginx/snippets/proxy-common.conf")],
    ] as const) {
      expect(stripComments(conf), `${name}이 auth_basic을 상속시킨다`).not.toMatch(/auth_basic/);
    }
  });

  it("자격증명 파일은 **런타임 마운트 경로**다 (이미지 안이 아니다)", () => {
    const userFile = /auth_basic_user_file\s+(\S+)\s*;/.exec(stripComments(authBasicConf))?.[1];
    expect(userFile).toBe("/etc/nginx/secrets/htpasswd");
    // 이미지에 구우면 ECR에 시크릿이 올라간다. Dockerfile이 그 경로를 만들지 않는지 본다.
    expect(dockerfileNginx, "nginx 이미지가 자격증명을 굽는다").not.toMatch(/secrets/);
  });

  it("compose가 호스트 경로를 env 참조로 받고 **읽기 전용**으로 건다", () => {
    expect(composeYml).toMatch(
      /\$\{WEB_BASIC_AUTH_FILE:\?[^}]*\}:\/etc\/nginx\/secrets\/htpasswd:ro/,
    );
    // `:?`가 요점이다. 기본값을 주면 오설정이 조용히 통과하고, docker가 없는 경로에
    // 빈 디렉터리를 만들어 `/`가 난해한 500으로 죽는다.
    expect(composeYml, "WEB_BASIC_AUTH_FILE에 조용한 기본값이 생겼다").not.toMatch(
      /\$\{WEB_BASIC_AUTH_FILE:-/,
    );
  });
});

describe("htpasswd 실값이 레포에 없다 (T-042, CLAUDE.md 시크릿 금지)", () => {
  it(".env.example은 **경로**만 준다 — 자격증명이 아니다", () => {
    const value = /^WEB_BASIC_AUTH_FILE=(.*)$/m.exec(envExample)?.[1] ?? "";
    expect(value, ".env.example에 WEB_BASIC_AUTH_FILE이 없다").not.toBe("");
    // htpasswd 한 줄은 `user:hash` 모양이다. 콜론이 있으면 경로가 아니라 자격증명이다.
    expect(value, `WEB_BASIC_AUTH_FILE에 자격증명이 들어갔다: ${value}`).not.toContain(":");
    expect(value).toMatch(/^[\w./-]+$/);
  });

  it.each([
    [".env.example", envExample],
    ["docker-compose.yml", composeYml],
    ["docker-compose.prod.yml", composeProdYml],
    ["nginx/snippets/auth-basic.conf", authBasicConf],
    ["nginx/snippets/routes.conf", routesConf],
    ["specs/06-deployment.md", deploymentSpec],
  ])("%s에 htpasswd 해시가 없다", (_name, content) => {
    // htpasswd가 내는 네 가지 형식 전부: apr1 / bcrypt / {PLAIN} / {SHA}.
    expect(content).not.toMatch(/\$apr1\$|\$2[aby]\$|\{PLAIN\}|\{SHA\}/);
  });

  it("`secrets/`가 .gitignore돼 있다 — 실값이 실수로 커밋되지 않는다", () => {
    expect(gitignore).toMatch(/^secrets\/$/m);
  });
});

describe("specs/06이 NFR-04 **부분 충족**을 명시한다 (T-042 Acceptance 4)", () => {
  /**
   * 이 단언이 지키는 것은 설정이 아니라 **문면**이다. basic 인증은 프로젝트별 키를
   * 구분하지 못하고 감사 B-2(아티클 project 스코프 부재)를 닫지 못한다. 그 한계가
   * 문서에서 사라지면 다음 사람이 NFR-04를 "충족"으로 읽고 B-2를 영영 놓친다.
   * **이 테스트를 통과시키려고 문면을 지우지 마라 — 지워야 할 것은 한계 자체다.**
   */
  const section = /## web 표면 인증[\s\S]*$/.exec(deploymentSpec)?.[0] ?? "";

  it("`## web 표면 인증` 절이 있다", () => {
    expect(section, "specs/06에 web 표면 인증 절이 없다").not.toBe("");
  });

  it("프로젝트별 키를 구분하지 못한다고 적혀 있다", () => {
    expect(section).toContain("프로젝트별 키");
    expect(section).toContain("미충족");
  });

  it("감사 B-2(아티클 project 스코프)가 닫히지 않았다고 적혀 있다", () => {
    expect(section).toContain("B-2");
    expect(section).toMatch(/닫히지 않는다|열린 채/);
  });

  it("RTM이 web 표면을 NFR-04 검증 대상으로 잡는다 (T-042 배경)", () => {
    // 감사: RTM의 NFR-04 검증란이 T-007·T-014뿐이라 web 표면이 통째로 빠져 있었다.
    expect(rtm).toContain("NFR-04 (web 표면)");
    expect(rtm).toContain("T-042");
  });
});

// ============================================================ certbot 챌린지

describe("certbot 챌린지 방식 (T-025 F-3)", () => {
  /**
   * specs/06은 "SG 443만 인바운드"와 "Let's Encrypt(certbot)"를 동시에 요구한다.
   * **HTTP-01은 80번 인바운드를 요구해 양립하지 않는다.** Route53이 이미 있어 DNS-01로
   * 해소했다. 누군가 HTTP-01(`--webroot`/`--standalone`)로 되돌리면 발급이 조용히
   * 실패하고, 그건 인증서 만료일에야 드러난다.
   */
  it("DNS-01(route53)을 쓴다", () => {
    expect(composeProdYml).toContain("--dns-route53");
    expect(composeProdYml).toContain("certbot/dns-route53");
  });

  it("HTTP-01 계열 플래그가 없다 — SG가 80을 열지 않는다", () => {
    expect(composeProdYml).not.toContain("--webroot");
    expect(composeProdYml).not.toContain("--standalone");
    expect(composeProdYml).not.toContain("--preferred-challenges http");
  });
});
