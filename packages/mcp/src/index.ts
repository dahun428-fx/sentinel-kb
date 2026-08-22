/**
 * `@sentinel/mcp` 배럴. MCP 서버(Streamable HTTP + stdio)는 T-014에서 골격이 섰고
 * 도구 5개는 T-015가 채운다. 계약: specs/07-mcp.md
 *
 * CLI 진입점(`http.cli.ts` / `stdio.cli.ts`)은 여기서 re-export하지 않는다 —
 * 배럴 import 한 줄이 포트를 잡거나 stdin을 물면 안 된다.
 */
import { PACKAGE_NAME as CORE_PACKAGE } from "@sentinel/core";

export const PACKAGE_NAME = "@sentinel/mcp";
export const DEPENDS_ON = [CORE_PACKAGE] as const;

export * from "./auth.js";
export * from "./config.js";
export * from "./core-api-client.js";
export * from "./http.js";
export * from "./prompts/index.js";
export * from "./server.js";
export * from "./stdio.js";
export * from "./tools/index.js";
