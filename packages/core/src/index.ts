/**
 * `@sentinel/core` 배럴.
 * 도메인 로직(chunker, embedder, retriever, generator, llm/)은 후속 태스크에서 채운다.
 * specs/01-architecture.md 참조. `sanitizer`는 T-004에서 들어왔다 —
 * 외부 의존이 없는 순수 정규식 모듈이라 `./db`와 달리 배럴에 실어도 안전하다.
 */
import { Severity } from "@sentinel/contracts";

export const PACKAGE_NAME = "@sentinel/core";

/** contracts 의존 방향(core → contracts)이 살아 있는지 확인하는 최소 사용처. */
export const DEFAULT_SEVERITY = Severity.parse("NOTE");

export { VERSION } from "./version.js";
export * from "./sanitizer/index.js";
