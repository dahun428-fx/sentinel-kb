/**
 * T-001 스캐폴드 placeholder.
 * 임베딩 잡 소비자는 T-008부터 구현한다. specs/01-architecture.md 참조.
 */
import { PACKAGE_NAME as CORE_PACKAGE } from "@sentinel/core";

export const PACKAGE_NAME = "@sentinel/worker";
export const DEPENDS_ON = [CORE_PACKAGE] as const;
