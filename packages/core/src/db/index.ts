/**
 * `@sentinel/core/db` — DB 경계 서브패스.
 *
 * 메인 배럴(`@sentinel/core`)에서 re-export하지 않는다. contracts의 `./openapi`와 같은 이유로,
 * `import { ... } from "@sentinel/core"` 한 줄이 mongodb 드라이버를 web 번들까지 끌고 오면 안 된다.
 * DB가 필요한 쪽(api·worker·스크립트)만 이 서브패스를 쓴다.
 */
export * from "./client.js";
export * from "./indexes.js";
export * from "./records.js";
