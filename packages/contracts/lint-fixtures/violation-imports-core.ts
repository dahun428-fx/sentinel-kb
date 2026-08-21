/**
 * 의도적 위반 픽스처 — contracts → core import는 의존 역행이다 (specs/01).
 * 일반 `pnpm lint`에서는 eslint.config.js ignores로 제외되고,
 * tools/dependency-boundaries.spec.ts가 ESLint Node API로 직접 lint 해서
 * import/no-restricted-paths가 실제로 실패하는지 검증한다.
 */
import { PACKAGE_NAME } from "../../core/src/index.js";

export const violation = PACKAGE_NAME;
