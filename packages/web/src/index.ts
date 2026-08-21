/**
 * T-001 스캐폴드 placeholder.
 * Next.js 읽기 UI는 T-023에서 세운다 — 여기서는 최소 TS 패키지만 스캐폴드한다.
 */
import { PACKAGE_NAME as CORE_PACKAGE } from "@sentinel/core";

export const PACKAGE_NAME = "@sentinel/web";
export const DEPENDS_ON = [CORE_PACKAGE] as const;
