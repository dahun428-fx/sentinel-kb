/**
 * T-001 스캐폴드 placeholder.
 * 도메인 로직(chunker, embedder, retriever, generator, sanitizer, llm/)은
 * 후속 태스크(T-004~)에서 채운다. specs/01-architecture.md 참조.
 */
import { Severity } from "@sentinel/contracts";

export const PACKAGE_NAME = "@sentinel/core";

/** contracts 의존 방향(core → contracts)이 살아 있는지 확인하는 최소 사용처. */
export const DEFAULT_SEVERITY = Severity.parse("NOTE");

export { VERSION } from "./version.js";
export * from "./chunker/index.js";
