/**
 * 도구 결과 헬퍼와 오류 매핑.
 *
 * 오류를 한 곳에서 만드는 이유는 **유출 차단**이다. core-api 오류 객체를 그대로 문자열화하면
 * 프록시 오류 페이지·스택·요청 헤더가 에이전트 컨텍스트로 들어간다(토큰 예산과 시크릿 양쪽 문제).
 * `CoreApiError`는 이미 헤더를 담지 않지만, 도구마다 `String(error)`를 부르기 시작하면
 * 그 보증이 첫 실수에서 끝난다.
 */
import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";

import { CoreApiError, CoreApiTransportError, CoreApiUnsafeReadError } from "../core-api-client.js";

export function textResult(...lines: string[]): CallToolResult {
  return { content: [{ type: "text", text: lines.filter((line) => line.length > 0).join("\n") }] };
}

export function errorResult(...lines: string[]): CallToolResult {
  return { ...textResult(...lines), isError: true };
}

/**
 * 도구 핸들러를 감싸 예외를 `isError` 결과로 바꾼다. 던져서 JSON-RPC 오류로 내보내면
 * 에이전트가 "도구가 고장났다"로 읽고 재시도를 포기한다 — 무엇이 왜 실패했는지 알려주는 편이
 * 루프를 살린다(핵심 루프: 검색 실패 → 직접 해결 → 기록).
 */
export function toToolError(toolName: string, error: unknown): CallToolResult {
  if (error instanceof CoreApiUnsafeReadError) {
    // 프로그래밍 오류다. 에이전트가 고칠 수 있는 것이 없으므로 진단만 남긴다.
    return errorResult(`${toolName}: 내부 오류 — 쓰기 요청이 읽기 경로로 갔다. ${error.message}`);
  }
  if (error instanceof CoreApiError) {
    return errorResult(
      `${toolName} 실패 (${error.code}, HTTP ${String(error.statusCode)}): ${error.message}`,
    );
  }
  if (error instanceof CoreApiTransportError) {
    return errorResult(
      `${toolName} 실패 (${error.code}): ${error.message} 지식보관소에 닿지 못했으니 ` +
        "이번 디버깅은 검색 없이 진행하고, 해결한 뒤 record_knowledge를 다시 시도하라.",
    );
  }
  // 알 수 없는 예외. **원인 객체를 펼치지 않는다** — 스택·내부 경로가 새는 자리다.
  return errorResult(`${toolName} 실패: 예상치 못한 내부 오류가 발생했다.`);
}
