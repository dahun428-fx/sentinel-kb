/**
 * T-027 배포 파이프라인 가드.
 *
 * 워크플로는 **코드보다도 조용히 썩는다.** nginx 설정은 그래도 배포되면 증상이 나오지만,
 * 배포 워크플로가 참조하는 이미지 이름·스크립트 경로·env 이름·compose 서비스명은
 * **실제로 배포를 돌려야만** 틀린 것이 드러난다. 그리고 이 레포에는 AWS 자격증명이 없어
 * 아무도 그걸 돌리지 않는다. 즉 판정처가 없다.
 *
 * 그래서 "배포가 참조하는 것"과 "실제로 존재하는 것"을 정적으로 대조한다.
 * T-026 의 `nginx-contract.spec.ts` 가 nginx 설정에 대해 한 일을 배포 경로에 대해 한다.
 *
 * **이 파일이 잡은 실제 결함**(만들면서 발견한 것이지 가정이 아니다):
 *   - `infra/ecr.tf` 가 `sentinel-kb/core-api` 를 만드는데 `docker-compose.prod.yml` 은
 *     `sentinel-kb-core-api` 를 당긴다 → 배포 마지막 단계에서 pull 404 (T-027 F-3)
 *   - compose 가 `CORE_API_KEY:?` 를 요구하는데 SSM 파라미터 목록에 없다 → `up -d` 실패 (F-4)
 *
 * docker 가 필요 없다. 자격증명도 필요 없다. **판정처가 하나라도 있게 만드는 것이 요점이다.**
 */
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";

const repoRoot = fileURLToPath(new URL("..", import.meta.url));

function read(relativePath: string): string {
  return readFileSync(join(repoRoot, relativePath), "utf8");
}

const deployWorkflow = read(".github/workflows/deploy.yml");
const deployScript = read("infra/deploy/deploy.sh");
const smokeScript = read("infra/deploy/smoke.sh");
const composeYml = read("docker-compose.yml");
const composeProdYml = read("docker-compose.prod.yml");
const ecrTf = read("infra/ecr.tf");
const variablesTf = read("infra/variables.tf");
const iamTf = read("infra/iam.tf");
const userDataSh = read("infra/user-data.sh");

/** `variable "<name>" { ... }` 블록의 `default` 리스트에서 문자열만 뽑는다. */
function terraformListDefault(tf: string, variableName: string): string[] {
  const block = new RegExp(`variable\\s+"${variableName}"\\s*\\{([\\s\\S]*?)\\n\\}`).exec(tf)?.[1];
  if (block === undefined) return [];
  const list = /default\s*=\s*\[([\s\S]*?)\]/.exec(block)?.[1] ?? "";
  return [...list.matchAll(/"([^"]+)"/g)].map((m) => m[1] ?? "");
}

/** bash 배열 `NAME=( a b c )` 의 원소. */
function bashArray(script: string, name: string): string[] {
  const body = new RegExp(`^${name}=\\(([\\s\\S]*?)^\\)`, "m").exec(script)?.[1] ?? "";
  return body
    .split("\n")
    .map((line) => line.replace(/#.*$/, "").trim())
    .filter((line) => line.length > 0);
}

/**
 * 셸 스크립트에서 주석 줄을 걷어낸다.
 *
 * 주석에는 "이 스크립트가 **하지 않는** 일"의 근거가 적혀 있다 — 예를 들어 deploy.sh 는
 * `db:search-indexes` 를 왜 부르지 않는지를 주석으로 남긴다. 그 문장 때문에 "부르지
 * 않는다" 검사가 빨개지면, 가드를 통과시키려고 **근거를 지우게 된다.** 그건 정확히
 * 반대 방향이다.
 */
function stripShellComments(script: string): string {
  return script
    .split("\n")
    .filter((line) => !/^\s*#/.test(line))
    .join("\n");
}

/** compose 파일의 최상위 서비스 이름. */
function composeServices(yml: string): string[] {
  const section = /^services:$/m.exec(yml);
  if (section === null) return [];
  return [...yml.slice(section.index).matchAll(/^ {2}([a-z][a-z0-9-]*):$/gm)].map((m) => m[1] ?? "");
}

const services = new Set([...composeServices(composeYml), ...composeServices(composeProdYml)]);

// ===================================================== 이미지 이름 3자 대조

/**
 * ECR 리포지토리 이름은 **세 곳에 따로 적혀 있다**: terraform 이 만들고, 워크플로가
 * 그 이름으로 푸시하고, compose 가 그 이름으로 당긴다. 셋 중 하나만 어긋나도
 * 앞의 두 단계는 성공하고 **마지막 pull 에서만** 죽는다 — 가장 늦게, 가장 비싸게.
 */
describe("ECR 리포지토리 이름: terraform ↔ 워크플로 ↔ compose (T-027 F-3)", () => {
  const repositories = terraformListDefault(variablesTf, "ecr_repositories");

  it("terraform 이 리포지토리 5개를 선언한다 (파싱 회귀 방지)", () => {
    expect(repositories.sort()).toEqual(["core-api", "mcp", "nginx", "web", "worker"]);
  });

  it("`infra/ecr.tf` 가 `<project>-<repo>` 규칙으로 만든다 — `/` 가 아니다", () => {
    // `sentinel-kb/core-api` 로 만들면 compose 의 `sentinel-kb-core-api` pull 이 404 다.
    expect(ecrTf).toContain('name                 = "${var.project}-${each.value}"');
    expect(ecrTf).not.toContain('"${var.project}/${each.value}"');
  });

  it("워크플로 매트릭스가 terraform 의 리포지토리 목록과 같다", () => {
    const matrixRepos = [...deployWorkflow.matchAll(/^\s*- repo:\s*(\S+)$/gm)].map(
      (m) => m[1] ?? "",
    );
    expect(matrixRepos.sort()).toEqual(repositories.sort());
  });

  it("compose 가 당기는 이미지가 전부 실재하는 리포지토리다", () => {
    const pulled = new Set(
      [...composeProdYml.matchAll(/\$\{ECR_REGISTRY[^}]*\}\/([a-z0-9-]+):/g)].map(
        (m) => m[1] ?? "",
      ),
    );
    expect(pulled.size).toBeGreaterThan(0);
    for (const image of pulled) {
      expect(repositories, `compose 가 없는 리포지토리 ${image} 를 당긴다`).toContain(
        image.replace(/^sentinel-kb-/, ""),
      );
      expect(image).toMatch(/^sentinel-kb-/);
    }
  });

  it("워크플로가 푸시하는 태그도 같은 접두사를 쓴다", () => {
    expect(deployWorkflow).toContain("sentinel-kb-${{ matrix.repo }}:${{ env.IMAGE_TAG }}");
  });

  it("스모크가 쓰는 mcp 이미지 이름도 같다", () => {
    expect(smokeScript).toContain("${ECR_REGISTRY}/sentinel-kb-mcp:${IMAGE_TAG}");
  });
});

// ============================================== compose 가 요구하는 env 전량 렌더

/** `${NAME:?...}` — 기본값이 없어 **반드시** 주어져야 하는 변수. */
function requiredComposeVars(yml: string): string[] {
  return [...yml.matchAll(/\$\{([A-Z][A-Z0-9_]*):\?[^}]*\}/g)].map((m) => m[1] ?? "");
}

describe("compose 가 `:?` 로 요구하는 env 를 deploy.sh 가 전부 렌더한다 (T-027 F-4)", () => {
  const required = new Set([
    ...requiredComposeVars(composeYml),
    ...requiredComposeVars(composeProdYml),
  ]);

  const secureParameters = bashArray(deployScript, "SECURE_PARAMETERS");
  const printed = [...deployScript.matchAll(/printf\s+'([A-Z][A-Z0-9_]*)=%s\\n'/g)].map(
    (m) => m[1] ?? "",
  );
  const rendered = new Set([...secureParameters, ...printed]);

  it("요구 목록을 실제로 읽어낸다 (파싱 회귀 방지)", () => {
    expect(required.size).toBeGreaterThanOrEqual(10);
    expect([...required]).toContain("CORE_API_KEY");
    expect([...required]).toContain("IMAGE_TAG");
  });

  /**
   * 이게 빨간 채로 머지되면 배포는 이미지 푸시까지 성공한 뒤 `up -d` 에서 죽는다.
   * T-025 의 SSM 파라미터 목록에 `CORE_API_KEY` 가 없어서 실제로 그 상태였다.
   */
  it.each([...required].sort())("`%s` 가 .env 로 렌더된다", (name) => {
    expect(rendered.has(name), `${name} 을 deploy.sh 가 렌더하지 않는다`).toBe(true);
  });

  it("deploy.sh 의 SecureString 목록이 terraform 의 목록과 글자 그대로 같다", () => {
    // 갈라지면 한쪽은 "만들었는데 아무도 안 읽는 파라미터", 다른 쪽은 "없는 파라미터를 읽어 실패"다.
    expect(secureParameters.sort()).toEqual(
      terraformListDefault(variablesTf, "secure_parameter_names").sort(),
    );
  });

  it("모델명을 스크립트에 박지 않는다 (CLAUDE.md: 모델명 하드코딩 금지)", () => {
    expect(deployScript).not.toMatch(/EMBEDDING_MODEL=(?!%s)\S/);
    expect(deployScript).not.toMatch(/ANTHROPIC_MODEL=(?!%s)\S/);
  });
});

// ================================================== 워크플로가 참조하는 실체

describe("워크플로·스크립트가 참조하는 것이 실재한다 (T-027)", () => {
  // `uses:` 줄은 파일 경로가 아니라 액션 참조다(`docker/build-push-action@v6`).
  // 그걸 파일로 착각하면 가드가 영원히 빨갛고, 그러면 가드를 지우게 된다.
  const referencedPaths = new Set(
    deployWorkflow
      .split("\n")
      .filter((line) => !/^\s*-?\s*uses:/.test(line))
      .flatMap((line) => [...line.matchAll(/\b((?:docker|infra|scripts)\/[A-Za-z0-9._/-]+)/g)])
      .map((m) => m[1] ?? ""),
  );

  it("경로를 실제로 몇 개 읽어냈다 (정규식이 죽으면 이 테스트가 무의미해진다)", () => {
    expect(referencedPaths.size).toBeGreaterThanOrEqual(5);
  });

  it.each([...referencedPaths].sort())("워크플로가 참조하는 `%s` 가 존재한다", (path) => {
    expect(existsSync(join(repoRoot, path)), `${path} 가 없다`).toBe(true);
  });

  it("compose 파일 두 개를 번들에 넣는다", () => {
    expect(deployWorkflow).toContain("cp docker-compose.yml docker-compose.prod.yml bundle/");
  });

  it("deploy.sh 가 부르는 compose 서비스가 실재한다", () => {
    const referenced = [...deployScript.matchAll(/run --rm(?:\s+--\S+(?:\s+\S+)?)*\s+([a-z][a-z0-9-]*)/g)]
      .map((m) => m[1] ?? "")
      .filter((name) => name !== "sh");
    expect(referenced.length).toBeGreaterThan(0);
    for (const name of referenced) {
      expect(services.has(name), `compose 에 ${name} 서비스가 없다`).toBe(true);
    }
  });

  it("스모크가 mcp-ping 두 파일을 번들에서 마운트하고, 그 파일이 실재한다", () => {
    for (const file of ["scripts/mcp-ping.ts", "scripts/mcp-ping.cli.ts"]) {
      expect(existsSync(join(repoRoot, file))).toBe(true);
    }
    expect(smokeScript).toContain("/smoke/mcp-ping.cli.ts");
    expect(deployWorkflow).toContain("cp scripts/mcp-ping.ts scripts/mcp-ping.cli.ts bundle/");
  });

  it("번들이 SSM 파라미터 한도 안에 있다", () => {
    // SSM 의 문서 파라미터 총량은 100KB 급이다. gzip+base64 를 거치므로 원본 예산을
    // 넉넉히 64KB 로 잡는다. 넘으면 배포가 아니라 **API 호출**이 실패하고, 그 에러는
    // compose 와 아무 상관없이 보여 원인을 찾기 어렵다. 커지기 전에 여기서 막는다.
    const bundled = [
      "docker-compose.yml",
      "docker-compose.prod.yml",
      "infra/deploy/deploy.sh",
      "infra/deploy/smoke.sh",
      "scripts/mcp-ping.ts",
      "scripts/mcp-ping.cli.ts",
    ];
    const bytes = bundled.reduce((sum, file) => sum + Buffer.byteLength(read(file), "utf8"), 0);
    expect(bytes, `번들 원본이 ${String(bytes)} bytes 다`).toBeLessThan(64 * 1024);
  });
});

// ======================================================= OIDC / 시크릿 금지

describe("자격증명은 OIDC 뿐이다 (CLAUDE.md: 시크릿 하드코딩 금지)", () => {
  it("OIDC 토큰 권한과 역할 가정을 쓴다", () => {
    expect(deployWorkflow).toContain("id-token: write");
    expect(deployWorkflow).toContain("role-to-assume: ${{ vars.AWS_DEPLOY_ROLE_ARN }}");
  });

  it("장기 액세스 키 입력이 없다", () => {
    for (const forbidden of [
      "aws-access-key-id",
      "aws-secret-access-key",
      "AWS_ACCESS_KEY_ID",
      "AWS_SECRET_ACCESS_KEY",
      "AWS_SESSION_TOKEN",
    ]) {
      expect(deployWorkflow, `워크플로에 ${forbidden} 가 있다`).not.toContain(forbidden);
    }
  });

  it("시크릿이 러너를 통과하지 않는다 — 호스트가 SSM 에서 직접 읽는다", () => {
    // `secrets.` 참조가 하나라도 생기면 시크릿이 러너 메모리와 로그 위험에 노출된다.
    // 지금 설계는 호스트의 인스턴스 롤이 Parameter Store 를 직접 읽는다.
    expect(deployWorkflow).not.toMatch(/\$\{\{\s*secrets\./);
    expect(deployScript).toContain("aws ssm get-parameter");
  });

  it("배포 스크립트가 `set -x` 로 시크릿을 로그에 흘리지 않는다", () => {
    // SSM 이 stdout/stderr 를 그대로 GH Actions 로그로 돌려준다.
    expect(deployScript).not.toMatch(/^\s*set\s+-[a-z]*x/m);
    expect(smokeScript).not.toMatch(/^\s*set\s+-[a-z]*x/m);
  });
});

// ================================================ 자격증명 없이 통과 금지

describe("설정이 없으면 **실패한다** (T-025 infra.yml 규약)", () => {
  it("preflight 가 변수 부재를 exit 1 로 판정한다", () => {
    const job = /preflight:[\s\S]*?(?=\n {2}[a-z][a-z0-9-]*:\n)/.exec(deployWorkflow)?.[0] ?? "";
    expect(job).toContain("exit 1");
    expect(job).toContain("가짜 그린");
  });

  it("배포 잡을 `if:` 로 건너뛰게 만들지 않았다", () => {
    // 변수 미설정 저장소에서 조용히 스킵되면 배포한 적 없이 영원히 초록이 된다.
    expect(deployWorkflow).not.toMatch(/if:\s*[^\n]*vars\./);
    expect(deployWorkflow).not.toMatch(/if:\s*[^\n]*secrets\./);
  });

  it("build-push·deploy 가 preflight 를 거쳐야만 돈다", () => {
    expect(deployWorkflow).toContain("needs: [preflight, verify]");
    expect(deployWorkflow).toContain("needs: build-push");
  });

  it("verify 가 배포의 게이트다 (specs/06: verify → 빌드 → push)", () => {
    expect(deployWorkflow).toContain("pnpm verify");
    expect(deployWorkflow).toContain('REQUIRE_DOCKER: "1"');
  });
});

// ==================================================== 롤백 경로 (specs/06 런북)

describe("롤백 경로 (specs/06 런북 '직전 이미지 태그로 compose up -d')", () => {
  it("직전 성공 태그를 호스트에 기록한다", () => {
    expect(deployScript).toContain("last-good-tag");
  });

  it("스모크가 통과한 **뒤에만** last-good 을 갱신한다", () => {
    // 먼저 갱신하면 깨진 태그가 롤백 대상이 되어 되돌아갈 곳이 사라진다.
    const smokeAt = deployScript.indexOf('"$STATE_DIR/smoke.sh"');
    const recordAt = deployScript.indexOf('>"$LAST_GOOD_FILE"');
    expect(smokeAt).toBeGreaterThan(0);
    expect(recordAt).toBeGreaterThan(smokeAt);
  });

  it("실패하면 직전 태그로 자동 재배포한다", () => {
    expect(deployScript).toMatch(/run_deploy "\$previous"/);
  });

  it("되감기가 정확히 1회다 — 재귀 호출이 없다", () => {
    // 두 번 연속 실패는 태그 문제가 아니라 호스트·Atlas·시크릿 문제다.
    // 계속 되감으면 원인에서 멀어지기만 한다. 행동 검증은 deploy-rollback.int.spec.ts.
    const code = stripShellComments(deployScript);
    expect([...code.matchAll(/run_deploy "\$previous"/g)]).toHaveLength(1);
    // `\s` 는 개행도 먹어서 최상위의 `main "$@"` 까지 잡는다 — 들여쓰기만 본다.
    expect(code, "main 이 자기 자신을 다시 부른다").not.toMatch(/^[ \t]+main\b/m);
  });

  it("롤백에 성공해도 배포는 실패로 보고한다", () => {
    // 초록이 뜨면 깨진 커밋이 main 에 남은 것을 아무도 모른다.
    const rollbackBlock = deployScript.slice(deployScript.indexOf("롤백 시작"));
    expect(rollbackBlock).toContain("exit 1");
  });

  /**
   * T-039 가 "키가 없으면 부팅 거부"를 택한 이유가 **`up -d` 가 즉시 실패해 롤백이
   * 자동으로 걸리기 때문**이다. `|| true` 한 번이면 그 설계 전체가 무효가 된다.
   */
  it("`up -d`·`pull` 의 실패를 삼키지 않는다", () => {
    for (const line of deployScript.split("\n")) {
      if (/"\$\{COMPOSE\[@\]\}"\s+(up|pull)\b/.test(line)) {
        expect(line, `실패를 삼키는 줄: ${line}`).not.toMatch(/\|\|\s*true/);
      }
    }
  });

  it("수동 롤백 경로가 워크플로에 있다", () => {
    expect(deployWorkflow).toContain("workflow_dispatch");
    expect(deployWorkflow).toContain("image_tag");
  });

  it("태그가 SHA 하나뿐이다 — 움직이는 `latest` 는 롤백 대상을 모호하게 만든다", () => {
    expect(deployWorkflow).not.toMatch(/sentinel-kb-\$\{\{ matrix\.repo \}\}:latest/);
  });
});

// ============================== 인덱스 부트스트랩 순서 (T-010 비준 3, T-026 F-9)

describe("검색 인덱스 부트스트랩 순서 (T-026 F-9)", () => {
  /**
   * `db:search-indexes` 는 기본 300초까지 블로킹하고 Atlas·atlas-local 에서만 돈다.
   * **compose up 이전인지 이후인지가 첫 검색 성공을 가른다.** 인덱스가 PENDING 인 채
   * core-api 가 뜨면 첫 `/v1/search` 가 죽고, 그건 "배포 실패"가 아니라 "가끔 검색이
   * 안 됨"으로 보고된다 — 가장 비싼 형태의 버그다.
   */
  it("core-api·worker 가 db-init 의 **정상 종료**를 기다린다", () => {
    for (const service of ["core-api", "worker"]) {
      const block =
        new RegExp(`^ {2}${service}:$([\\s\\S]*?)(?=^ {2}[a-z])`, "m").exec(composeYml)?.[1] ?? "";
      expect(block, `${service} 에 db-init 의존이 없다`).toContain("db-init:");
      expect(block).toContain("condition: service_completed_successfully");
    }
  });

  it("deploy.sh 가 인덱스 생성을 **따로 부르지 않는다** — compose 게이트가 정본이다", () => {
    // 밖에서 또 부르면 두 번 돌거나, `up -d` 뒤에 붙어 순서가 뒤집힌다.
    // 주석은 뺀다 — deploy.sh 는 "왜 안 부르는가"를 주석으로 남긴다.
    expect(stripShellComments(deployScript)).not.toMatch(
      /db:search-indexes|ensure-search-indexes|db:indexes/,
    );
  });

  it("`pull` → `up -d` 순서다", () => {
    const pullAt = deployScript.indexOf('"${COMPOSE[@]}" pull');
    const upAt = deployScript.indexOf('"${COMPOSE[@]}" up -d');
    expect(pullAt).toBeGreaterThan(0);
    expect(upAt).toBeGreaterThan(pullAt);
  });

  it("인증서 확보가 `up -d` **앞**이다 — nginx 는 인증서 없이 뜨지 않는다", () => {
    const body = /run_deploy\(\) \{([\s\S]*?)\n\}/.exec(deployScript)?.[1] ?? "";
    const certAt = body.indexOf("ensure_certificate");
    const upAt = body.indexOf('"${COMPOSE[@]}" up -d');
    expect(certAt).toBeGreaterThan(0);
    expect(upAt).toBeGreaterThan(certAt);
  });

  it("SSM 실행 타임아웃이 db-init 대기(300초)보다 넉넉하다", () => {
    const timeout = Number(/executionTimeout:\s*\["(\d+)"\]/.exec(deployWorkflow)?.[1] ?? "0");
    expect(timeout).toBeGreaterThanOrEqual(600);
  });

  it("스모크는 `up -d` 뒤다 — 그 전에 재면 db-init 대기 중에 빨간불이 뜬다", () => {
    const body = /run_deploy\(\) \{([\s\S]*?)\n\}/.exec(deployScript)?.[1] ?? "";
    expect(body.indexOf("smoke.sh")).toBeGreaterThan(body.indexOf('"${COMPOSE[@]}" up -d'));
  });
});

// ================================ T-026 이 넘긴 미해결 2건이 되돌아가지 않게

describe("certbot DNS-01 권한 (T-026 F-2 해소분 고정)", () => {
  /**
   * 이 권한이 없으면 `certbot-init` 이 AccessDenied 로 죽고, 인증서가 없으면 nginx 가
   * 뜨지 않아 **배포가 완결되지 않는다.** T-026 이 compose 는 다 만들어 놓고 여기서
   * 막혀 있었다. 되돌아가면 같은 자리에서 다시 막힌다.
   */
  it("인스턴스 롤에 route53 DNS-01 액션 3종이 있다", () => {
    for (const action of [
      "route53:ListHostedZones",
      "route53:GetChange",
      "route53:ChangeResourceRecordSets",
    ]) {
      expect(iamTf, `iam.tf 에 ${action} 이 없다`).toContain(action);
    }
  });

  it("레코드 쓰기가 해당 존 + `_acme-challenge` TXT 로 좁혀져 있다", () => {
    // 존 전체 쓰기를 주면 호스트가 탈취당했을 때 A 레코드를 갈아끼울 수 있다.
    expect(iamTf).toContain("hostedzone/${data.aws_route53_zone.this.zone_id}");
    expect(iamTf).toContain("ChangeResourceRecordSetsNormalizedRecordNames");
    expect(iamTf).toContain("_acme-challenge.${lower(var.domain_name)}");
    expect(iamTf).toContain("ChangeResourceRecordSetsRecordTypes");
  });

  it("HTTP-01 로 되돌아가지 않았다 (SG 가 80 을 열지 않는다)", () => {
    expect(composeProdYml).toContain("--dns-route53");
    expect(deployScript).not.toContain("--webroot");
    expect(deployScript).not.toContain("--standalone");
  });
});

describe("호스트 스왑 (T-026 F-3 해소분 고정)", () => {
  /**
   * compose 의 `memswap_limit`(상한의 2배)은 호스트에 스왑이 없으면 아무 일도 하지 않는다.
   * t3.small 2GiB 에 컨테이너 상한 합계가 1,520MiB 라 남는 것이 ~320MiB 뿐이다.
   */
  it("user-data 가 2GiB 이상 스왑을 만든다", () => {
    expect(userDataSh).toContain("mkswap");
    expect(userDataSh).toContain("swapon");
    const megabytes = Number(/count=(\d+)/.exec(userDataSh)?.[1] ?? "0");
    expect(megabytes).toBeGreaterThanOrEqual(2048);
  });

  it("재부팅 후에도 붙는다", () => {
    expect(userDataSh).toContain("/etc/fstab");
  });

  it("두 번 돌아도 스왑을 중복 생성하지 않는다 (user_data 는 재실행될 수 있다)", () => {
    expect(userDataSh).toMatch(/if\s+!\s+swapon --show/);
    expect(userDataSh).toMatch(/grep -q '\^\/swapfile ' \/etc\/fstab \|\|/);
  });

  it("스왑에 상시로 눌러앉지 않게 swappiness 를 낮춘다", () => {
    // 스왑은 정상 경로가 아니라 OOM 대신 맞는 완충재다.
    expect(userDataSh).toContain("vm.swappiness");
  });
});

// ==================================================== 스모크가 재는 것

describe("배포 스모크 (T-027 Scope)", () => {
  it("`/health` 를 **도메인·TLS·nginx 를 통과해서** 잰다", () => {
    expect(smokeScript).toContain("https://${DOMAIN_NAME}/health");
    // 컨테이너 내부 주소를 직접 보면 nginx 가 깨져도 초록이 뜬다.
    // (주석에는 그 반례가 근거로 적혀 있으므로 실행되는 줄만 본다.)
    expect(stripShellComments(smokeScript)).not.toContain("core-api:3001");
  });

  it("EIP 헤어핀을 피해 도메인만 루프백으로 해소한다", () => {
    // EC2 는 자기 자신의 EIP 로 되돌아오지 못한다.
    expect(smokeScript).toContain("--resolve");
    expect(smokeScript).toContain("127.0.0.1");
  });

  it("MCP 도구 목록을 실제로 조회한다", () => {
    expect(smokeScript).toContain("mcp-ping.cli.ts");
    expect(smokeScript).toContain("SENTINEL_KB_URL");
  });

  it("키를 `docker run` 인자로 넘기지 않는다 (호스트 프로세스 목록에 보인다)", () => {
    expect(smokeScript).toMatch(/-e SENTINEL_KB_KEY(?!=)/);
  });

  it("워크플로가 바깥에서의 도달성을 따로 잰다 (DNS·SG·EIP)", () => {
    expect(deployWorkflow).toContain('curl -fsS --max-time 20 --retry 5 --retry-delay 5 \\');
    expect(deployWorkflow).toContain("https://${DOMAIN_NAME}/health");
  });
});
