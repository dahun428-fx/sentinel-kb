/**
 * `facts` — 팩트 추출기 (specs/08-publishing.md §3·§5.1, T-030).
 *
 * **결정론적이고 순수하다.** LLM도 DB도 부르지 않으며 외부 I/O가 없다.
 * `sanitizer`와 같은 성질이라 core 배럴에 실어도 안전하다.
 */
export * from "./types.js";
export * from "./screen.js";
export * from "./evidence.js";
export * from "./aggregate.js";
export * from "./charts.js";
export * from "./extract.js";
