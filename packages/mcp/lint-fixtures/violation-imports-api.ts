/**
 * 의도적 위반 픽스처 — `mcp → api`는 **형제 간선**이라 의존 방향 위반이다 (specs/01).
 *
 * T-014 D-3이 "복제할 수밖에 없다"의 근거로 든 `tsc -b` 프로젝트 참조는 실제로는 이 간선을
 * 막지 못한다(검증에서 반증됨). 그래서 eslint zone이 그 자리를 대신하고, 이 픽스처가
 * **그 zone이 실제로 발화하는지**를 잠근다.
 *
 * 일반 `pnpm lint`에서는 eslint.config.js ignores로 제외되고,
 * tools/dependency-boundaries.spec.ts가 ESLint Node API로 직접 lint 한다.
 */
import { PACKAGE_NAME } from "../../api/src/index.js";

export const violation = PACKAGE_NAME;
