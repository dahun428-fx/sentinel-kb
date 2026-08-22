/**
 * `pnpm mcp:ping` 진입점 (T-017 Acceptance 2).
 *
 * 컴포지션 루트다 — env를 읽고 종료 코드를 정하는 유일한 지점이고, 판정 로직은 전부
 * `mcp-ping.ts`가 갖는다. `seed.cli.ts`와 같은 규약이다.
 *
 * 사용법:
 *   SENTINEL_KB_URL=https://kb.example.com SENTINEL_KB_KEY=... pnpm mcp:ping
 *   pnpm --silent mcp:ping            # stdout을 파싱하려면 이쪽 (아래 §출력 참조)
 *
 * ## 출력 — 판정은 **종료 코드**로 하라
 * 도구 이름만 stdout으로 나가고 진단·요약은 전부 stderr다. 그런데 `pnpm run <script>`는
 * 자신의 실행 헤더를 **stdout으로** 낸다(T-017 F-3에서 실측). 즉 `pnpm mcp:ping`의 stdout은
 * 기계가 파싱하기에 깨끗하지 않다 — 그게 stdio 전송에서 `initialize`를 깨뜨리는 바로 그 함정이고,
 * 여기서도 같은 함정이다. 그래서 CI·런북은 **종료 코드**를 본다. 굳이 목록을 파싱해야 하면
 * `pnpm --silent mcp:ping`을 쓴다.
 *
 * ## 종료 코드
 *   0  도구 5개 확인
 *   1  붙었지만 도구 수가 5개가 아님        ← 코드 문제
 *  69  서버에 닿지 못함                     ← 배포·네트워크 문제
 *  70  ping 자신의 버그
 *  76  HTTP는 되는데 MCP로 말이 안 통함(404/5xx/깨진 프레임)
 *  77  인증 실패(401/403)
 *  78  env 오설정
 */
import {
  assertToolCount,
  EXPECTED_TOOL_COUNT,
  MCP_PING_EXIT,
  McpPingError,
  pingMcp,
  readPingConfig,
  redactSecrets,
} from "./mcp-ping.js";

const HELP = `pnpm mcp:ping — sentinel-kb MCP 서버에 붙어 도구 ${String(EXPECTED_TOOL_COUNT)}개를 확인한다.

env:
  SENTINEL_KB_URL   배포 도메인. 예: https://kb.example.com (경로 /mcp는 자동으로 붙는다)
  SENTINEL_KB_KEY   서버의 API_KEYS에 등록된 project 키

판정은 종료 코드로 한다: 0=정상, 1=도구 수 불일치, 69=서버 미도달,
70=내부 오류, 76=프로토콜 오류, 77=인증 실패, 78=env 오설정.`;

/**
 * 이 프로세스가 밖으로 내보내는 모든 문자열이 지나는 단 하나의 문. 키는 여기서 죽는다.
 * env를 직접 읽는 이유는 설정 해석이 실패한 경우에도(=`PingConfig`가 없어도) 가려야 하기 때문이다.
 */
const secrets = [process.env["SENTINEL_KB_KEY"]?.trim() ?? ""];
function say(line: string): void {
  console.error(redactSecrets(line, secrets));
}

async function main(): Promise<void> {
  if (process.argv.slice(2).some((arg) => arg === "--help" || arg === "-h")) {
    say(HELP);
    return;
  }

  const config = readPingConfig(process.env);
  say(`[mcp:ping] ${config.endpoint} 에 연결한다...`);

  const { toolNames, serverInfo } = await pingMcp(config);

  // 도구 이름만 stdout으로. 나머지는 전부 stderr다.
  for (const name of toolNames) process.stdout.write(`${name}\n`);

  assertToolCount(toolNames);
  say(
    `[mcp:ping] OK — 도구 ${String(toolNames.length)}개 확인` +
      (serverInfo?.name === undefined ? "" : ` (server: ${serverInfo.name})`),
  );
}

try {
  await main();
} catch (error) {
  if (error instanceof McpPingError) {
    say(`[mcp:ping] ${error.code}: ${error.message}`);
    process.exitCode = error.exitCode;
  } else {
    // 원본 객체를 찍지 않는다 — T-014에서 `console.error(error)`가 API 키를 통째로 덤프했다.
    say(
      `[mcp:ping] MCP_PING_INTERNAL: ${error instanceof Error ? error.message : "알 수 없는 오류"}`,
    );
    process.exitCode = MCP_PING_EXIT.SOFTWARE;
  }
}
