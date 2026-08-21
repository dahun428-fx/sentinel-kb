/**
 * T-001 스캐폴드 placeholder.
 * MCP 서버(Streamable HTTP)는 T-014부터 구현한다. specs/07-mcp.md 참조.
 */
import { PACKAGE_NAME as CORE_PACKAGE } from "@sentinel/core";

export const PACKAGE_NAME = "@sentinel/mcp";
export const DEPENDS_ON = [CORE_PACKAGE] as const;
