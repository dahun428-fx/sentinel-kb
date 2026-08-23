/**
 * `publisher` — 작문 파이프라인 + 문체 린터 (specs/08-publishing.md §4, T-031).
 *
 * `facts`(T-030)와 달리 **순수하지 않다**: 프롬프트·스타일 표본을 파일 시스템에서 읽고
 * 주입된 `ChatModel`을 부른다. 그래도 mongodb를 끌고 오지 않고 HTTP·MCP를 모르므로
 * `generator`와 같은 자격으로 core 배럴에 실린다.
 *
 * **저장은 하지 않는다.** 산출물은 `ArticleDraftPatch` 하나이고, 그것을 `articles`
 * 문서에 쓰는 것은 컴포지션 루트(worker)의 몫이다 — core는 DB 쓰기 경로를 갖지 않는다.
 */
export * from "./config.js";
export * from "./narrative.js";
export * from "./templates.js";
export * from "./style.js";
export * from "./prompt.js";
export * from "./lint.js";
export * from "./factcheck.js";
export * from "./draft.js";
