/**
 * T-027 롤백 경로 **행동** 검증.
 *
 * `deploy-contract.spec.ts` 는 "롤백 코드가 적혀 있는가"를 본다. 그것만으로는
 * **문장은 있는데 동작하지 않는 롤백**을 잡지 못한다 — 그리고 롤백은 정의상
 * 배포가 이미 실패한 순간에만 도는 코드라, 안 돌려보면 영원히 검증되지 않는다.
 *
 * 그래서 진짜 `infra/deploy/deploy.sh` 를 샌드박스에서 그대로 실행한다.
 * AWS 도 docker 도 없으므로 `aws`·`docker`·`curl` 을 PATH 앞쪽의 스텁으로 가린다.
 * 스텁은 호출을 기록만 하고, **어떤 태그에서 실패할지는 테스트가 정한다.**
 *
 * 즉 이 파일이 검증하는 것은 AWS 동작이 아니라 **deploy.sh 의 제어 흐름**이다:
 *   - 성공하면 last-good 을 갱신하는가
 *   - 실패하면 직전 태그로 되돌리는가
 *   - 되돌린 뒤에도 **배포는 실패로 보고**하는가 (초록을 내면 깨진 커밋이 숨는다)
 *   - 되돌아갈 곳이 없을 때 성공으로 포장하지 않는가
 *   - 롤백마저 실패했을 때 무한히 되감지 않는가
 */
import { execFileSync } from "node:child_process";
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

const repoRoot = fileURLToPath(new URL("..", import.meta.url));

/**
 * `aws` 스텁. deploy.sh 가 쓰는 두 호출만 안다.
 * SSM 값은 가짜지만 **형식은 진짜와 같다** — `API_KEYS` 는 `key:project` 여야
 * smoke.sh 의 키 추출이 실제와 같은 경로를 탄다.
 */
const AWS_STUB = `#!/usr/bin/env bash
set -euo pipefail
echo "aws $*" >> "$STUB_LOG"
case "$1 $2" in
  "ssm get-parameter")
    for arg in "$@"; do
      case "$arg" in
        */MONGODB_URI)      echo "mongodb+srv://u:p@c/sentinel"; exit 0;;
        */ANTHROPIC_API_KEY) echo "sk-fake"; exit 0;;
        */VOYAGE_API_KEY)   echo "vk-fake"; exit 0;;
        */API_KEYS)         echo "smokekey:sentinel-kb,other:bizcare"; exit 0;;
        */CORE_API_KEY)     echo "smokekey"; exit 0;;
        # T-042: web basic 인증 자격증명(htpasswd를 base64한 값). 실제 시크릿이 아니라
        # \`fixture:{SHA}not-a-real-hash\` 한 줄을 감싼 더미다. **base64인 것이 핵심이다** —
        # 이 렌더 경로는 개행을 담지 못하므로 감싸지 않으면 .env가 깨진다.
        */WEB_HTPASSWD_B64) echo "Zml4dHVyZTp7U0hBfW5vdC1hLXJlYWwtaGFzaAo="; exit 0;;
      esac
    done
    exit 1;;
  "ecr get-login-password") echo "fake-password"; exit 0;;
esac
exit 0
`;

/**
 * `docker` 스텁.
 *
 * 실패 여부는 **렌더된 .env 의 IMAGE_TAG** 로 정한다 — deploy.sh 가 태그를 어떻게
 * 넘기든(환경변수든 .env든) 실제로 그 태그로 배포하고 있는지가 여기서 드러난다.
 */
const DOCKER_STUB = `#!/usr/bin/env bash
set -euo pipefail
echo "docker $*" >> "$STUB_LOG"

tag=""
if [ -f "$STATE_DIR/.env" ]; then
  tag="$(sed -n 's/^IMAGE_TAG=//p' "$STATE_DIR/.env" | head -n1)"
fi

is_bad() {
  case ",\${FAIL_TAGS:-}," in *",$1,"*) return 0;; esac
  return 1
}

# compose 하위 명령 찾기 (전역 플래그가 앞에 잔뜩 붙는다)
sub=""
for arg in "$@"; do
  case "$arg" in
    pull|up|run|login) sub="$arg"; break;;
  esac
done

case "$sub" in
  login)
    # **stdin 을 끝까지 읽고 끝낸다.** deploy.sh 의 ecr_login 은
    # \`aws ecr get-login-password | docker login --password-stdin\` 파이프라인이다.
    # 뒷단이 stdin 을 안 읽고 먼저 exit 하면 앞단 aws 가 SIGPIPE(141)로 죽고,
    # deploy.sh 의 \`set -o pipefail\` 이 그것을 **배포 실패**로 읽는다.
    # 누가 먼저 끝나느냐의 경합이라 한가할 땐 거의 안 나고 부하에서 터진다 —
    # 실측: 무부하 0/300, 버너 12개 부하에서 **108/300(36%)**. stdin 을 소비하면 0/300.
    # 진짜 docker 는 stdin 을 읽으므로 이건 스텁이 실물보다 게을러서 생긴 거짓 실패다.
    cat >/dev/null
    exit 0;;
  pull)  exit 0;;
  run)
    # ensure_certificate 의 존재 확인 probe. CERT_PRESENT 로 제어한다.
    if [ "\${CERT_PRESENT:-1}" = "1" ]; then exit 0; fi
    exit 1;;
  up)
    # FAIL_UP_ALWAYS 는 "새 컨테이너는 못 떴는데 **옛 컨테이너가 계속 서비스 중**"을
    # 만든다 — 이때 스모크는 옛 스택을 보고 통과한다. \`|| true\` 의 진짜 위험이 그것이다.
    if [ "\${FAIL_UP_ALWAYS:-0}" = "1" ] || is_bad "$tag"; then
      echo "compose up 실패 (태그 $tag)" >&2
      exit 1
    fi
    exit 0;;
esac

# smoke.sh 의 \`docker run ... tsx mcp-ping\` — MCP 스모크
if is_bad "\${IMAGE_TAG:-}"; then exit 69; fi
exit 0
`;

/** `curl` 스텁 — smoke.sh 의 `/health`. */
const CURL_STUB = `#!/usr/bin/env bash
set -euo pipefail
echo "curl $*" >> "$STUB_LOG"
case ",\${FAIL_TAGS:-}," in *",\${IMAGE_TAG:-},"*) exit 22;; esac
exit 0
`;

/**
 * 자식 프로세스 타임아웃 (T-045).
 *
 * `execFileSync`는 **동기**라 vitest의 `testTimeout`이 이걸 끊지 못한다 — 타이머 콜백은
 * 동기 블록이 끝난 뒤에야 돌기 때문에, deploy.sh가 매달리면 워커째로 매달린다.
 * 그러니 실질적인 매달림 가드는 이 인자뿐이고, 없으면 vitest는 "이미 끝난 테스트가
 * 5초를 넘었다"고 **사후 보고**만 한다(감사 실측에서 본 실패가 그 모양이었다).
 *
 * 20초는 프로젝트 타임아웃(30초)보다 낮게 둔다. 그래야 매달림이 vitest의 뭉뚱그린
 * 타임아웃이 아니라 **"deploy.sh가 SIGTERM으로 죽었다"**는 구체적 신호로 나온다.
 * 정상 실행은 단독 0.4초급이라 50배 여유다.
 */
const DEPLOY_TIMEOUT_MS = 20_000;

interface RunResult {
  readonly code: number;
  readonly output: string;
  readonly lastGood: string | null;
  readonly log: string;
}

let sandbox: string;

beforeEach(() => {
  sandbox = mkdtempSync(join(tmpdir(), "t027-rollback-"));
  const bin = join(sandbox, "bin");
  const state = join(sandbox, "state");
  mkdirSync(bin);
  mkdirSync(state);

  for (const [name, body] of [
    ["aws", AWS_STUB],
    ["docker", DOCKER_STUB],
    ["curl", CURL_STUB],
  ] as const) {
    const path = join(bin, name);
    writeFileSync(path, body);
    chmodSync(path, 0o755);
  }

  // 진짜 배포 스크립트를 그대로 복사한다. 사본을 손으로 고치면 검증이 무의미해진다.
  for (const file of ["deploy.sh", "smoke.sh"]) {
    const path = join(state, file);
    writeFileSync(path, readFileSync(join(repoRoot, "infra/deploy", file), "utf8"));
    chmodSync(path, 0o755);
  }
  // 스모크가 마운트하는 파일. 스텁 docker 는 읽지 않지만 경로는 존재해야 한다.
  for (const file of ["mcp-ping.ts", "mcp-ping.cli.ts"]) {
    writeFileSync(join(state, file), readFileSync(join(repoRoot, "scripts", file), "utf8"));
  }
});

afterEach(() => {
  rmSync(sandbox, { recursive: true, force: true });
});

function deploy(
  tag: string,
  options: { failTags?: string[]; lastGood?: string; failUpAlways?: boolean } = {},
): RunResult {
  const state = join(sandbox, "state");
  const log = join(sandbox, "stub.log");
  writeFileSync(log, "");
  if (options.lastGood !== undefined) {
    writeFileSync(join(state, "last-good-tag"), `${options.lastGood}\n`);
  }

  let code = 0;
  let output = "";
  try {
    output = execFileSync("bash", [join(state, "deploy.sh")], {
      encoding: "utf8",
      stdio: ["ignore", "pipe", "pipe"],
      timeout: DEPLOY_TIMEOUT_MS,
      env: {
        ...process.env,
        PATH: `${join(sandbox, "bin")}:${process.env["PATH"] ?? ""}`,
        STATE_DIR: state,
        STUB_LOG: log,
        FAIL_TAGS: (options.failTags ?? []).join(","),
        FAIL_UP_ALWAYS: options.failUpAlways === true ? "1" : "0",
        IMAGE_TAG: tag,
        ECR_REGISTRY: "1111.dkr.ecr.ap-northeast-2.amazonaws.com",
        AWS_REGION: "ap-northeast-2",
        SSM_PREFIX: "/sentinel-kb/prod",
        LOG_GROUP_NAME: "/sentinel-kb/prod/app",
        DOMAIN_NAME: "kb.example.com",
        CERTBOT_EMAIL: "ops@example.com",
        EMBEDDING_MODEL: "voyage-3",
        ANTHROPIC_MODEL: "claude-opus-5",
      },
    });
  } catch (error: unknown) {
    const failure = error as {
      status?: number;
      stdout?: string;
      stderr?: string;
      // 정상 종료(0이 아닌 코드)에서는 **null**이다. 시그널로 죽었을 때만 문자열이 온다 —
      // `undefined` 검사로 가르면 모든 실패에 아래 문구가 붙어 진단이 오염된다.
      signal?: string | null;
    };
    code = failure.status ?? -1;
    // 시그널 종료는 deploy.sh의 판정이 아니라 **하네스가 죽인 것**이다. 구분해 두지 않으면
    // 타임아웃이 "롤백이 안 됐다"는 가짜 진단으로 둔갑한다.
    const killed =
      typeof failure.signal === "string"
        ? `\n[하네스] deploy.sh가 ${failure.signal}로 종료됐다 — ${DEPLOY_TIMEOUT_MS}ms 타임아웃 의심`
        : "";
    output = `${failure.stdout ?? ""}${failure.stderr ?? ""}${killed}`;
  }

  let lastGood: string | null = null;
  try {
    lastGood = readFileSync(join(state, "last-good-tag"), "utf8").trim();
  } catch {
    lastGood = null;
  }
  return { code, output, lastGood, log: readFileSync(log, "utf8") };
}

describe("배포 성공 경로 (T-027)", () => {
  it("성공하면 exit 0 이고 last-good 이 그 태그로 갱신된다", () => {
    const result = deploy("sha-good");
    expect(result.code, result.output).toBe(0);
    expect(result.lastGood).toBe("sha-good");
  });

  it("compose 를 `pull` → `up -d` 순서로 부른다", () => {
    const result = deploy("sha-good");
    const pullAt = result.log.indexOf("pull");
    const upAt = result.log.indexOf("up -d");
    expect(pullAt).toBeGreaterThanOrEqual(0);
    expect(upAt).toBeGreaterThan(pullAt);
  });

  it(".env 를 SSM 값으로 렌더하고 0600 으로 둔다", () => {
    deploy("sha-good");
    const env = readFileSync(join(sandbox, "state", ".env"), "utf8");
    // compose 가 `:?` 로 요구하는 것이 전부 들어 있어야 한다.
    for (const name of [
      "MONGODB_URI",
      "ANTHROPIC_API_KEY",
      "API_KEYS",
      "CORE_API_KEY",
      "WEB_HTPASSWD_B64",
      "IMAGE_TAG",
      "ECR_REGISTRY",
      "DOMAIN_NAME",
      "EMBEDDING_MODEL",
      "ANTHROPIC_MODEL",
    ]) {
      expect(env, `.env 에 ${name} 이 없다`).toMatch(new RegExp(`^${name}=.+$`, "m"));
    }
  });

  /**
   * **base64로 감싼 이유를 재는 단언이다** (T-042).
   *
   * 이 렌더 경로는 `aws ssm get-parameter --output text` 스칼라 전용이라 값에 개행이
   * 있으면 `.env` 가 깨진다 — 스크립트 자신이 그렇게 적어 뒀다. htpasswd 는 사용자가
   * 둘 이상이면 여러 줄이다. 누군가 "읽기 쉽게" 배포 쪽에서 디코딩하면 여기서 죽는다.
   */
  it("web 자격증명이 **한 줄로** 렌더된다 (감싸지 않으면 .env 가 깨진다)", () => {
    deploy("sha-good");
    const env = readFileSync(join(sandbox, "state", ".env"), "utf8");
    const matches = [...env.matchAll(/^WEB_HTPASSWD_B64=(.*)$/gm)];
    expect(matches, "WEB_HTPASSWD_B64 줄이 하나가 아니다").toHaveLength(1);
    // base64 알파벳 밖의 문자(공백·개행 포함)가 있으면 감싸이지 않은 것이다.
    expect(matches[0]?.[1] ?? "").toMatch(/^[A-Za-z0-9+/=]+$/);
  });

  it("값이 주입되지 않은 SSM 파라미터면 **컨테이너를 띄우기 전에** 거절한다", () => {
    // sentinel 을 그대로 배포하면 앱이 뜬 뒤에 죽고, 그때는 이전 스택이 이미 내려가 있다.
    const state = join(sandbox, "state");
    const bin = join(sandbox, "bin");
    writeFileSync(
      join(bin, "aws"),
      `#!/usr/bin/env bash\necho "aws $*" >> "$STUB_LOG"\ncase "$1 $2" in "ssm get-parameter") echo "__SET_ME_VIA_AWS_CLI__";; *) echo x;; esac\nexit 0\n`,
    );
    chmodSync(join(bin, "aws"), 0o755);

    let code = 0;
    let output = "";
    try {
      output = execFileSync("bash", [join(state, "deploy.sh")], {
        encoding: "utf8",
        timeout: DEPLOY_TIMEOUT_MS,
        env: {
          ...process.env,
          PATH: `${bin}:${process.env["PATH"] ?? ""}`,
          STATE_DIR: state,
          STUB_LOG: join(sandbox, "stub.log"),
          IMAGE_TAG: "sha-x",
          ECR_REGISTRY: "r",
          AWS_REGION: "ap-northeast-2",
          SSM_PREFIX: "/sentinel-kb/prod",
          LOG_GROUP_NAME: "lg",
          DOMAIN_NAME: "kb.example.com",
          CERTBOT_EMAIL: "o@e.com",
          EMBEDDING_MODEL: "voyage-3",
          ANTHROPIC_MODEL: "claude-opus-5",
        },
      });
    } catch (error: unknown) {
      const failure = error as { status?: number; stdout?: string; stderr?: string };
      code = failure.status ?? -1;
      output = `${failure.stdout ?? ""}${failure.stderr ?? ""}`;
    }
    expect(code).not.toBe(0);
    expect(output).toContain("__SET_ME_VIA_AWS_CLI__");
    expect(output).not.toContain("up -d");
  });
});

describe("롤백 경로 (specs/06 런북, T-027)", () => {
  it("`up -d` 가 실패하면 직전 태그로 되돌린다", () => {
    const result = deploy("sha-bad", { failTags: ["sha-bad"], lastGood: "sha-prev" });

    expect(result.output).toContain("롤백 시작");
    expect(result.output).toContain("롤백 성공");
    // 되돌린 태그로 실제 .env 가 다시 렌더됐는가 — 말만 하는 롤백이 아닌지 본다.
    const env = readFileSync(join(sandbox, "state", ".env"), "utf8");
    expect(env).toMatch(/^IMAGE_TAG=sha-prev$/m);
  });

  it("롤백에 성공해도 **배포는 실패로 보고한다**", () => {
    // 초록이 뜨면 깨진 커밋이 main 에 남은 것을 아무도 모른다.
    const result = deploy("sha-bad", { failTags: ["sha-bad"], lastGood: "sha-prev" });
    expect(result.code).toBe(1);
  });

  it("롤백해도 last-good 은 직전 태그 그대로다", () => {
    const result = deploy("sha-bad", { failTags: ["sha-bad"], lastGood: "sha-prev" });
    expect(result.lastGood).toBe("sha-prev");
  });

  it("스모크만 실패해도 롤백한다 (`up -d` 는 성공했어도)", () => {
    // 컨테이너가 떴다는 것과 서비스가 산다는 것은 다르다.
    const state = join(sandbox, "state");
    writeFileSync(join(state, "last-good-tag"), "sha-prev\n");
    const bin = join(sandbox, "bin");
    // curl 만 실패시킨다 — up 은 통과한다.
    writeFileSync(
      join(bin, "curl"),
      `#!/usr/bin/env bash\necho "curl $*" >> "$STUB_LOG"\n[ "\${IMAGE_TAG:-}" = "sha-bad" ] && exit 22\nexit 0\n`,
    );
    chmodSync(join(bin, "curl"), 0o755);

    const result = deploy("sha-bad", { failTags: [] });
    expect(result.code).toBe(1);
    expect(result.output).toContain("롤백");
    expect(result.lastGood).toBe("sha-prev");
  });

  /**
   * **`|| true` 뮤테이션을 죽이는 테스트.**
   *
   * `up -d` 가 실패했는데 옛 컨테이너가 아직 서비스 중이면 **스모크는 통과한다** —
   * 옛 스택을 재고 있기 때문이다. 그 조합에서 `up -d` 의 실패를 삼키면:
   *   배포가 성공으로 보고되고 → last-good 이 **뜨지도 않은 태그**로 갱신되고
   *   → 다음 롤백이 그 깨진 태그를 목적지로 삼는다.
   * 즉 `|| true` 한 줄이 롤백 체계 전체를 조용히 무력화한다.
   */
  it("`up -d` 만 실패하고 스모크가 통과해도 배포를 성공으로 보지 않는다", () => {
    const result = deploy("sha-bad", { failUpAlways: true, lastGood: "sha-prev" });
    expect(result.code, "up -d 실패가 삼켜졌다").not.toBe(0);
    expect(result.lastGood, "뜨지도 않은 태그가 last-good 이 됐다").toBe("sha-prev");
  });

  it("되돌아갈 곳이 없으면(첫 배포) 성공으로 포장하지 않는다", () => {
    const result = deploy("sha-bad", { failTags: ["sha-bad"] });
    expect(result.code).not.toBe(0);
    expect(result.output).toContain("롤백 대상이 없다");
    expect(result.lastGood).toBeNull();
  });

  it("롤백마저 실패하면 무한히 되감지 않고 사람을 부른다", () => {
    const result = deploy("sha-bad", {
      failTags: ["sha-bad", "sha-prev"],
      lastGood: "sha-prev",
    });
    expect(result.code).not.toBe(0);
    expect(result.output).toContain("수동 개입");
    // 되감기 횟수는 정확히 1회여야 한다.
    const attempts = [...result.output.matchAll(/롤백 시작/g)].length;
    expect(attempts).toBe(1);
  });

  it("직전 성공 태그가 방금 실패한 태그와 같으면 되돌리지 않는다", () => {
    const result = deploy("sha-same", { failTags: ["sha-same"], lastGood: "sha-same" });
    expect(result.code).not.toBe(0);
    expect(result.output).toContain("되돌릴 곳이 없다");
  });
});

describe("인증서 확보 순서 (T-026 F-2 / T-027)", () => {
  it("인증서가 없으면 `up -d` **전에** certbot-init 을 돌린다", () => {
    const bin = join(sandbox, "bin");
    // probe 를 실패시켜 "인증서 없음"을 만든다. 그 다음 발급 run 은 성공한다.
    writeFileSync(
      join(bin, "docker"),
      `#!/usr/bin/env bash
echo "docker $*" >> "$STUB_LOG"
# 위 DOCKER_STUB 과 같은 이유로 login 은 stdin 을 소비해야 한다(SIGPIPE 경합).
if [ "\${1:-}" = "login" ]; then cat >/dev/null; exit 0; fi
case "$*" in
  *"--entrypoint sh certbot-init"*) exit 1;;
  *"run --rm certbot-init"*) echo "certbot 발급" >&2; exit 0;;
esac
exit 0
`,
    );
    chmodSync(join(bin, "docker"), 0o755);

    const result = deploy("sha-good");
    expect(result.code, result.output).toBe(0);
    const issueAt = result.log.indexOf("run --rm certbot-init");
    const upAt = result.log.indexOf("up -d");
    expect(issueAt, "certbot-init 발급이 호출되지 않았다").toBeGreaterThanOrEqual(0);
    expect(upAt).toBeGreaterThan(issueAt);
  });

  it("인증서가 이미 있으면 재발급하지 않는다 (rate limit)", () => {
    const result = deploy("sha-good");
    expect(result.log).not.toContain("run --rm certbot-init");
  });
});
