/**
 * Streamable HTTP 모드 컴포지션 루트. `pnpm --filter @sentinel/mcp dev`가 이걸 띄운다.
 */
import { readMcpConfig } from "./config.js";
import { createMcpHttpServer, MCP_PATH } from "./http.js";

export async function start(): Promise<void> {
  const config = readMcpConfig(process.env);

  const server = createMcpHttpServer({
    apiKeys: config.apiKeys,
    coreApiBaseUrl: config.coreApiBaseUrl,
    coreApiTimeoutMs: config.coreApiTimeoutMs,
    coreApiMaxAttempts: config.coreApiMaxAttempts,
    // 토큰이 들어갈 자리가 없는 구조화 로그다(McpHttpLogEntry 참조).
    log: (entry) => {
      console.log(JSON.stringify({ level: "info", msg: "mcp.request", ...entry }));
    },
  });

  const shutdown = (): void => {
    server.close();
  };
  process.once("SIGTERM", shutdown);
  process.once("SIGINT", shutdown);

  await new Promise<void>((resolve) => {
    server.listen(config.port, "0.0.0.0", resolve);
  });
  console.log(
    JSON.stringify({
      level: "info",
      msg: "mcp.listening",
      port: config.port,
      path: MCP_PATH,
      coreApiBaseUrl: config.coreApiBaseUrl,
    }),
  );
}

// `tsx src/http.cli.ts`로 직접 실행될 때만 뜬다. import만으로는 포트를 잡지 않는다.
if (process.argv[1]?.endsWith("http.cli.ts") === true) {
  start().catch((error: unknown) => {
    // **메시지만 낸다 — Error 객체를 그대로 덤프하지 않는다.**
    // `console.error(error)`는 스택 프레임과 부가 프로퍼티(`code` 등)까지 찍는다.
    // 부팅 실패는 대부분 `API_KEYS`·`SENTINEL_KB_KEY` 같은 **시크릿을 다루는 코드 경로**에서
    // 나고, 그 스택은 컨테이너 stderr → CI 로그·로그 수집기로 그대로 흘러간다.
    // 운영자에게 필요한 것은 한 줄짜리 원인이지 프레임 목록이 아니다.
    // `stdio.cli.ts`와 같은 처리다.
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  });
}
