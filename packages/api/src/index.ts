/**
 * T-001 스캐폴드 placeholder.
 * Fastify HTTP 서버는 T-007(records API)부터 구현한다. specs/04-api.md 참조.
 */
import { PACKAGE_NAME as CORE_PACKAGE } from "@sentinel/core";

export const PACKAGE_NAME = "@sentinel/api";
export const DEPENDS_ON = [CORE_PACKAGE] as const;
