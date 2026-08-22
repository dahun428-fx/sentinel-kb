/**
 * 도구 5종 등록. **이 목록이 늘어나는 것은 스펙 개정 + 인간 승인 사항이다**
 * (specs/07 "도구 5개 — 이 이상 늘리지 않는다", CLAUDE.md 금지 사항).
 * 도구 수는 곧 에이전트의 인지 부하다.
 */
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";

import type { McpContext } from "../server.js";
import { registerGetRecord } from "./get-record.js";
import { registerGiveFeedback } from "./give-feedback.js";
import { registerRecordKnowledge } from "./record-knowledge.js";
import { registerSearchKnowledge } from "./search-knowledge.js";
import { registerSuggestResolution } from "./suggest-resolution.js";

/**
 * 등록기 목록. 순서는 `tools/list`에 그대로 나가므로 **핵심 루프 순서**로 둔다
 * (검색 → 전문 → 기록 → 상위 제안 → 피드백). 에이전트가 목록을 위에서부터 읽는다.
 */
const REGISTRARS = [
  registerSearchKnowledge,
  registerGetRecord,
  registerRecordKnowledge,
  registerSuggestResolution,
  registerGiveFeedback,
] as const;

/**
 * **서버에 실제로 등록된 도구 수**를 센다. `REGISTRARS.length`가 아니다 —
 * 그건 **배열 리터럴 길이**라 등록기 하나가 도구 둘을 등록해도 5를 보고하고,
 * 그러면 `createMcpServer`의 상한 가드가 6개째 도구를 그대로 통과시킨다(T-015 검증 지적).
 *
 * SDK가 도구를 담는 곳은 `McpServer._registeredTools` 하나뿐이라 거기를 센다. 이름이
 * `_`로 시작하지만 공개 API가 이 수를 노출하지 않으므로 대안이 없고, **못 세면 던진다** —
 * 세지 못하는 상태로 통과시키면 상한이 조용히 사라진다.
 */
function countRegisteredTools(server: McpServer): number {
  const registry = (server as unknown as { readonly _registeredTools?: unknown })._registeredTools;
  if (typeof registry !== "object" || registry === null) {
    throw new Error(
      "MCP SDK의 도구 레지스트리(_registeredTools)를 찾지 못했다. SDK 업그레이드로 형상이 바뀌었을 수 있다 — " +
        "도구 개수 상한(specs/07 '도구 5개')을 강제할 수 없는 상태로 부팅하지 않는다.",
    );
  }
  return Object.keys(registry).length;
}

/** 등록을 마친 뒤 **실제 등록 도구 수**를 돌려준다 — `createMcpServer`의 상한 가드가 이 값을 본다. */
export function registerAllTools(server: McpServer, context: McpContext): number {
  for (const register of REGISTRARS) register(server, context);
  return countRegisteredTools(server);
}

export { MCP_SEARCH_LIMIT_DEFAULT, MCP_SEARCH_LIMIT_MAX } from "./search-knowledge.js";
export {
  estimateTokens,
  MCP_SEARCH_TOKEN_BUDGET,
  RECORD_DATA_NOTICE,
  RECORD_TAG,
  type TokenEstimate,
} from "./format.js";
