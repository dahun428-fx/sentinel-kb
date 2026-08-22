/**
 * `@sentinel/core` 배럴.
 * `generator`·`llm`은 T-018에서 들어왔다 — 둘 다 mongodb를 끌고 오지 않는다.
 * `llm`에는 아직 실 provider가 없다(인터페이스 + fake). 근거는 `llm/types.ts` D-2.
 * `retriever`는 mongodb를 import하지 않아(구조적 `RetrievalDbLike`) 여기 실려도 안전하다 (T-011).
 * specs/01-architecture.md 참조. `sanitizer`는 T-004에서 들어왔다 —
 * 외부 의존이 없는 순수 정규식 모듈이라 `./db`와 달리 배럴에 실어도 안전하다.
 * `auth`는 T-037에서 들어왔다 — `API_KEYS` 문자열 파싱은 HTTP 지식이 아니라서
 * core가 가져도 "core는 HTTP·MCP를 모른다"를 어기지 않는다(T-014 F-1 회수).
 */
import { Severity } from "@sentinel/contracts";

export const PACKAGE_NAME = "@sentinel/core";

/** contracts 의존 방향(core → contracts)이 살아 있는지 확인하는 최소 사용처. */
export const DEFAULT_SEVERITY = Severity.parse("NOTE");

export { VERSION } from "./version.js";
export * from "./auth/index.js";
export * from "./sanitizer/index.js";
export * from "./chunker/index.js";
export * from "./embedder/index.js";
export * from "./retriever/index.js";
export * from "./llm/index.js";
export * from "./generator/index.js";
