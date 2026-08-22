/**
 * `toToolError`의 **유출 차단**을 갈래별로 관측한다.
 *
 * T-015 검증에서 이 모듈의 방어선 두 개가 **아무 테스트에도 관측되지 않는다**고 지적됐다:
 * - G26: 미지 예외 갈래를 `String(error)`로 되돌려도 통합 테스트가 전부 통과했다.
 *   `result.ts`가 "원인 객체를 펼치지 않는다 — 스택·내부 경로가 새는 자리다"라고 적어 둔
 *   방어가 **완전한 죽은 코드**였다는 뜻이다.
 * - G33: `CoreApiError` 갈래 뒤에 `JSON.stringify(error)`를 덧붙여도 통과했다.
 *   통합 테스트의 유출 단언이 `KEY_A` 문자열과 `"bearer"` 부재만 봤기 때문이다.
 *
 * 부분 문자열 부재로는 이 둘을 못 잡는다 — 무엇이 샐지 미리 알아야 하기 때문이다.
 * 그래서 여기서는 **응답 전문을 정확히 일치**로 단언한다. 오류 문구에 무엇이든 덧붙으면 죽는다.
 */
import { describe, expect, it } from "vitest";

import { CoreApiError, CoreApiTransportError, CoreApiUnsafeReadError } from "../core-api-client.js";
import { toToolError } from "./result.js";

function textOf(result: ReturnType<typeof toToolError>): string {
  return result.content
    .filter((part): part is { type: "text"; text: string } => part.type === "text")
    .map((part) => part.text)
    .join("\n");
}

/** 실제로 샐 수 있는 것들. 오류 객체에 심어 두고 응답에 나타나지 않는지 본다. */
const SECRET = "int-tools-key-a";
const STACK_PATH = "/Users/somebody/sentinel-kb/packages/mcp/src/core-api-client.ts:188";

describe("toToolError — 미지 예외 (G26)", () => {
  /**
   * `String(error)`나 `error.message` 전달로 되돌리면 여기서 죽는다.
   * 문면 일치라 "스택은 안 붙였지만 메시지는 붙였다" 같은 절반짜리 회귀도 잡힌다.
   */
  it("원인 객체를 한 글자도 펼치지 않는다", () => {
    const error = new Error(`connect ECONNREFUSED ${SECRET} at ${STACK_PATH}`);
    expect(textOf(toToolError("search_knowledge", error))).toBe(
      "search_knowledge 실패: 예상치 못한 내부 오류가 발생했다.",
    );
  });

  it("Error가 아닌 값이 던져져도 마찬가지다", () => {
    for (const thrown of [
      { authorization: `Bearer ${SECRET}` },
      [SECRET],
      SECRET,
      Symbol(SECRET),
      undefined,
      null,
    ]) {
      const text = textOf(toToolError("get_record", thrown));
      expect(text).toBe("get_record 실패: 예상치 못한 내부 오류가 발생했다.");
    }
  });

  it("isError로 표시한다 — 조용히 성공처럼 보이지 않는다", () => {
    expect(toToolError("get_record", new Error("무엇이든")).isError).toBe(true);
  });
});

describe("toToolError — CoreApiError (G33)", () => {
  /**
   * 이 갈래는 `error.message`를 **의도적으로** 싣는다(에이전트가 고칠 수 있는 정보다).
   * 그래서 "무엇을 싣는가"가 아니라 **"그것만 싣는가"**가 단언 대상이다.
   * `JSON.stringify(error)`나 `error.stack`을 덧붙이면 여기서 죽는다.
   */
  it("코드·상태·메시지만 싣고 그 밖의 어떤 것도 붙이지 않는다", () => {
    const error = new CoreApiError(500, "INTERNAL_ERROR", "내부 오류", 3);
    // 오류 객체에 진단 필드가 붙어 있어도(실제 undici 오류가 그렇다) 응답 형상은 그대로다.
    Object.assign(error, { requestHeaders: { authorization: `Bearer ${SECRET}` } });
    error.stack = `Error: 내부 오류\n    at ${STACK_PATH}`;

    expect(textOf(toToolError("search_knowledge", error))).toBe(
      "search_knowledge 실패 (INTERNAL_ERROR, HTTP 500): 내부 오류",
    );
  });

  it("전송 실패는 다음 행동을 알려주되 원인 객체는 펼치지 않는다", () => {
    const error = new CoreApiTransportError("core-api POST /v1/search 요청이 실패했다(TimeoutError, 상한 10000ms).", 3);
    Object.assign(error, { cause: new Error(`${SECRET} at ${STACK_PATH}`) });

    const text = textOf(toToolError("search_knowledge", error));
    expect(text).toBe(
      "search_knowledge 실패 (CORE_API_UNREACHABLE): core-api POST /v1/search 요청이 실패했다(TimeoutError, 상한 10000ms). " +
        "지식보관소에 닿지 못했으니 이번 디버깅은 검색 없이 진행하고, 해결한 뒤 record_knowledge를 다시 시도하라.",
    );
  });

  it("read()에 쓰기가 들어온 프로그래밍 오류는 진단만 남긴다", () => {
    const error = new CoreApiUnsafeReadError("read()는 재시도하는 경로라 쓰기 요청을 받지 않는다: POST /v1/records.");
    expect(textOf(toToolError("record_knowledge", error))).toBe(
      "record_knowledge: 내부 오류 — 쓰기 요청이 읽기 경로로 갔다. read()는 재시도하는 경로라 쓰기 요청을 받지 않는다: POST /v1/records.",
    );
  });
});
