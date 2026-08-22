/**
 * stdio 모드 컴포지션 루트. 로컬 개발용 — `.mcp.json`의 `"type": "stdio"` 항목이 이걸 spawn한다.
 *
 * **stdout에는 JSON-RPC 프레임 외에 아무것도 쓰지 않는다.** 배너 한 줄이 섞이면
 * 클라이언트의 파서가 깨지고 initialize가 실패한다. 진단 출력은 전부 stderr다.
 */
import { readMcpConfig } from "./config.js";
import { startStdioServer } from "./stdio.js";

export async function start(): Promise<void> {
  const config = readMcpConfig(process.env);

  // 인증 실패는 여기서 던진다 → 서버가 뜨지 않는다(stdio.ts의 결정 근거 참조).
  await startStdioServer({
    apiKeys: config.apiKeys,
    bearerKey: config.bearerKey,
    coreApiBaseUrl: config.coreApiBaseUrl,
    coreApiTimeoutMs: config.coreApiTimeoutMs,
    coreApiMaxAttempts: config.coreApiMaxAttempts,
  });

  console.error(
    JSON.stringify({
      level: "info",
      msg: "mcp.stdio.ready",
      coreApiBaseUrl: config.coreApiBaseUrl,
    }),
  );
}

if (process.argv[1]?.endsWith("stdio.cli.ts") === true) {
  start().catch((error: unknown) => {
    // 메시지만 낸다. 토큰은 McpAuthError·ApiKeyConfigError 어디에도 들어 있지 않다.
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  });
}
