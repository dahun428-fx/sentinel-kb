/**
 * OpenAPI 3.1 문서를 생성한다.
 *
 *   pnpm --filter contracts openapi            # dist/openapi.json 으로 출력
 *   pnpm --filter contracts openapi ./api.json # 지정한 경로로 출력
 *   pnpm --filter contracts openapi -          # stdout 으로 출력
 *
 * 기본값이 파일인 이유: pnpm이 스크립트 배너를 stdout에 찍기 때문에
 * `pnpm ... > file` 리다이렉트는 JSON을 오염시킨다. 파일 출력은 그 영향을 받지 않는다.
 * stdout이 필요하면 `-`를 주고 `pnpm -s`로 배너를 끈다.
 *
 * 문서 내용은 src/openapi.ts가 전적으로 소유한다 — 이 파일은 진입점일 뿐이다.
 */
import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { OPENAPI_VERSION, buildOpenApiDocument } from "../src/openapi.js";

const packageRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const json = `${JSON.stringify(buildOpenApiDocument(), null, 2)}\n`;
const arg = process.argv[2];

if (arg === "-") {
  process.stdout.write(json);
} else {
  const target = arg
    ? resolve(process.cwd(), arg)
    : resolve(packageRoot, "dist/openapi.json");
  mkdirSync(dirname(target), { recursive: true });
  writeFileSync(target, json, "utf8");
  process.stderr.write(`OpenAPI ${OPENAPI_VERSION} → ${target}\n`);
}
