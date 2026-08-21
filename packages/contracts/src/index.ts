/**
 * @sentinel/contracts — API·MCP 계약의 단일 소스.
 * 여기서 export하는 스키마 외의 타입을 다른 패키지에서 재정의하지 않는다. (CLAUDE.md 규칙)
 * 전체 스펙: specs/02-data-model.md, specs/04-api.md
 *
 * 이 파일은 배럴일 뿐이다 — 정의는 각 모듈에 있다.
 *
 * `./openapi`는 여기서 re-export하지 않는다. 그 모듈은 최상위에서
 * `extendZodWithOpenApi(z)`로 zod를 전역 패치하므로, 배럴에 걸어두면
 * `import { Severity } from "@sentinel/contracts"` 한 줄이 mcp·api·web 전부에
 * 문서 생성기를 끌고 온다. 문서가 필요한 쪽만 `@sentinel/contracts/openapi`를 쓴다.
 */
export * from "./common.js";
export * from "./record.js";
export * from "./chunk.js";
export * from "./feedback.js";
export * from "./eval-case.js";
export * from "./api.js";
