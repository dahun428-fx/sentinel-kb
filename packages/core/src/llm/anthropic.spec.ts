/**
 * Anthropic provider 단위 테스트. 출처: T-039 Acceptance A4·A7·A8·A9, specs/05 결정론 원칙.
 *
 * **네트워크를 타지 않는다.** SDK 클라이언트에 `fetch`를 주입해 fixture 응답을 돌려준다 —
 * specs/05가 "실제 모델 호출은 eval 계층에서만"으로 갈라 두었고, `pnpm verify` 경로의 테스트가
 * 네트워크를 타면 CI가 자격증명과 provider 가용성에 결합된다. `no-hardcoded-model.spec.ts`의
 * A10 가드가 이 규칙을 파일 단위로 잠근다.
 */
import { describe, expect, it } from "vitest";

import { createAnthropicModel, REDACTED, redactSecret, type SdkFetch } from "./anthropic.js";
import type { ToolSpec } from "./tools.js";
import { LLM_ERROR_CODES, LlmError } from "./types.js";

/** 실제 키와 같은 자릿수의 센티널. 짧으면 마스킹 하한(8자)에 걸려 테스트가 무의미해진다. */
const SECRET = "sk-ant-api03-SENTINEL-DO-NOT-LEAK-0123456789abcdef";

const MODEL = "model-under-test";

const BASE = { model: MODEL, apiKey: SECRET, timeoutMs: 5000, maxRetries: 0 } as const;

interface Capture {
  readonly urls: string[];
  readonly bodies: Record<string, unknown>[];
}

/** 요청을 기록하면서 지정한 응답들을 순서대로 돌려주는 fetch. */
function stubFetch(responses: (() => Response)[]): { fetch: SdkFetch; capture: Capture } {
  const capture: Capture = { urls: [], bodies: [] };
  let index = 0;
  const fetch: SdkFetch = (input, init) => {
    capture.urls.push(typeof input === "string" ? input : input.toString());
    const raw = init?.body;
    capture.bodies.push(typeof raw === "string" ? (JSON.parse(raw) as Record<string, unknown>) : {});
    // 응답이 모자라면 마지막 것을 반복한다 — 재시도 횟수 실측이 목적이라 그게 자연스럽다.
    const make = responses[Math.min(index, responses.length - 1)];
    index += 1;
    if (make === undefined) throw new Error("fixture 응답이 없다");
    return Promise.resolve(make());
  };
  return { fetch, capture };
}

function jsonResponse(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json", "request-id": "req_fixture" },
  });
}

function messageFixture(content: unknown[], stopReason = "end_turn"): Response {
  return jsonResponse(200, {
    id: "msg_fixture",
    type: "message",
    role: "assistant",
    model: `${MODEL}-resolved`,
    content,
    stop_reason: stopReason,
    stop_sequence: null,
    usage: { input_tokens: 1, output_tokens: 1 },
  });
}

const TOOLS: readonly ToolSpec[] = [
  {
    name: "search_knowledge",
    description: "과거 사례를 검색한다.",
    inputSchema: { type: "object", properties: { query: { type: "string" } }, required: ["query"] },
  },
  {
    name: "record_knowledge",
    description: "새 사례를 기록한다.",
    inputSchema: { type: "object", properties: { title: { type: "string" } }, required: ["title"] },
  },
];

describe("redactSecret", () => {
  it("키의 모든 출현을 지운다", () => {
    expect(redactSecret(`a ${SECRET} b ${SECRET}`, SECRET)).toBe(`a ${REDACTED} b ${REDACTED}`);
  });

  it("정규식 메타문자가 든 키도 안전하게 지운다", () => {
    const nasty = "sk-a.*+?[]()|^$";
    expect(redactSecret(`x ${nasty} y`, nasty)).toBe(`x ${REDACTED} y`);
  });

  it("너무 짧은 문자열은 지우지 않는다 — 메시지가 통째로 사라지는 것을 막는다", () => {
    expect(redactSecret("a b a", "a")).toBe("a b a");
  });

  /*
   * 유출 프로브가 실측한 요구사항: V8이 JSON 파싱 에러의 본문 스니펫을 10자 안팎으로 자르므로
   * **키 전체가 아니라 조각**이 샌다. 전체 일치만 지우면 그 조각을 놓친다.
   */
  it("잘린 조각(앞 10자)도 지운다", () => {
    const fragment = SECRET.slice(0, 10);
    expect(redactSecret(`Unexpected token 's', "${fragment}"... is not valid JSON`, SECRET)).not.toContain(
      fragment,
    );
  });

  it("가운데에서 잘린 조각도 지운다", () => {
    const fragment = SECRET.slice(7, 20);
    expect(redactSecret(`body=${fragment}`, SECRET)).toBe(`body=${REDACTED}`);
  });

  it("하한(8자) 미만 조각은 건드리지 않는다 — 과잉 마스킹으로 메시지를 못 읽게 만들지 않는다", () => {
    expect(redactSecret(`x${SECRET.slice(0, 7)}y`, SECRET)).toBe(`x${SECRET.slice(0, 7)}y`);
  });
});

describe("complete()", () => {
  it("text 블록을 이어 붙여 돌려주고, 응답이 알려 준 모델을 싣는다", async () => {
    const { fetch } = stubFetch([
      () =>
        messageFixture([
          { type: "text", text: "앞부분 " },
          { type: "text", text: "뒷부분" },
        ]),
    ]);
    const model = createAnthropicModel({ ...BASE, fetch });

    const response = await model.complete({
      system: "시스템 프롬프트",
      messages: [{ role: "user", content: "질문" }],
      maxTokens: 128,
    });

    expect(response.text).toBe("앞부분 뒷부분");
    expect(response.model).toBe(`${MODEL}-resolved`);
    expect(response.stopReason).toBe("end_turn");
  });

  // A3의 행동 짝: 가드가 "쓸 자리가 없다"를 잠근다면 이건 "실제로 나가지 않는다"를 잠근다.
  it("샘플링 파라미터·thinking·output_config를 요청에 싣지 않는다", async () => {
    const { fetch, capture } = stubFetch([() => messageFixture([{ type: "text", text: "ok" }])]);
    const model = createAnthropicModel({ ...BASE, fetch });

    await model.complete({ system: "s", messages: [{ role: "user", content: "q" }], maxTokens: 7 });

    const body = capture.bodies[0] ?? {};
    for (const key of ["temperature", "top_p", "top_k", "thinking", "output_config"]) {
      expect(Object.hasOwn(body, key), `요청에 ${key}가 실렸다`).toBe(false);
    }
    expect(body["model"]).toBe(MODEL);
    expect(body["max_tokens"]).toBe(7);
    expect(body["system"]).toBe("s");
  });
});

describe("selectTool() — specs/05 Eval 3의 인터페이스", () => {
  // A8
  it("tool_use 블록을 {name, input}로 돌려준다", async () => {
    const { fetch } = stubFetch([
      () =>
        messageFixture(
          [
            { type: "text", text: "이걸 쓰면 되겠다." },
            {
              type: "tool_use",
              id: "toolu_1",
              name: "search_knowledge",
              input: { query: "nginx 502" },
            },
          ],
          "tool_use",
        ),
    ]);
    const model = createAnthropicModel({ ...BASE, fetch });

    const response = await model.selectTool({
      messages: [{ role: "user", content: "이 에러 처음 봐" }],
      tools: TOOLS,
      maxTokens: 256,
    });

    expect(response.toolUses).toEqual([
      { name: "search_knowledge", input: { query: "nginx 502" } },
    ]);
    expect(response.text).toBe("이걸 쓰면 되겠다.");
    expect(response.stopReason).toBe("tool_use");
  });

  // A8 — "고르지 않음"이 에러나 오답으로 접히면 채점기가 그 케이스를 볼 수 없다.
  it("아무 도구도 고르지 않으면 빈 배열이다 (에러가 아니다)", async () => {
    const { fetch } = stubFetch([
      () => messageFixture([{ type: "text", text: "적절한 도구가 없다." }]),
    ]);
    const model = createAnthropicModel({ ...BASE, fetch });

    const response = await model.selectTool({
      messages: [{ role: "user", content: "오늘 날씨" }],
      tools: TOOLS,
      maxTokens: 256,
    });

    expect(response.toolUses).toEqual([]);
    expect(response.text).toBe("적절한 도구가 없다.");
  });

  it("도구 목록을 SDK 형상으로 그대로 실어 보낸다", async () => {
    const { fetch, capture } = stubFetch([() => messageFixture([{ type: "text", text: "" }])]);
    const model = createAnthropicModel({ ...BASE, fetch });

    await model.selectTool({
      messages: [{ role: "user", content: "q" }],
      tools: TOOLS,
      maxTokens: 32,
    });

    expect(capture.bodies[0]?.["tools"]).toEqual([
      {
        name: "search_knowledge",
        description: "과거 사례를 검색한다.",
        input_schema: TOOLS[0]?.inputSchema,
      },
      {
        name: "record_knowledge",
        description: "새 사례를 기록한다.",
        input_schema: TOOLS[1]?.inputSchema,
      },
    ]);
  });

  /*
   * A9. `tool_choice`로 강제하면 모델이 언제나 도구를 고르므로 Eval 3의 정확도가 무의미해진다.
   * `strict`도 마찬가지로, 필수 인자 누락을 서버가 가려 버려 채점기가 볼 수 없게 만든다.
   */
  it("tool_choice로 도구를 강제하지 않고, strict도 붙이지 않는다", async () => {
    const { fetch, capture } = stubFetch([() => messageFixture([{ type: "text", text: "" }])]);
    const model = createAnthropicModel({ ...BASE, fetch });

    await model.selectTool({
      messages: [{ role: "user", content: "q" }],
      tools: TOOLS,
      maxTokens: 32,
    });

    const body = capture.bodies[0] ?? {};
    expect(Object.hasOwn(body, "tool_choice"), "tool_choice가 실렸다").toBe(false);
    const tools = body["tools"] as Record<string, unknown>[];
    for (const tool of tools) {
      expect(Object.hasOwn(tool, "strict"), "도구에 strict가 붙었다").toBe(false);
    }
  });
});

describe("재시도·타임아웃은 SDK 기본값이 아니라 명시값이다 (A7)", () => {
  /*
   * SDK 기본은 `maxRetries: 2`(=3회 시도)다. 아래 실측이 그 기본을 타면 숫자가 어긋난다.
   * 429는 SDK의 재시도 대상이므로 시도 횟수가 그대로 관측된다.
   */
  it("maxRetries=0이면 1회만 시도한다", async () => {
    const { fetch, capture } = stubFetch([
      () => jsonResponse(429, { type: "error", error: { type: "rate_limit_error", message: "x" } }),
    ]);
    const model = createAnthropicModel({ ...BASE, maxRetries: 0, fetch });

    await expect(
      model.complete({ system: "s", messages: [{ role: "user", content: "q" }], maxTokens: 8 }),
    ).rejects.toBeInstanceOf(LlmError);

    expect(capture.urls).toHaveLength(1);
  });

  it("maxRetries=1이면 2회 시도한다", async () => {
    const { fetch, capture } = stubFetch([
      () => jsonResponse(429, { type: "error", error: { type: "rate_limit_error", message: "x" } }),
    ]);
    const model = createAnthropicModel({ ...BASE, maxRetries: 1, fetch });

    await expect(
      model.complete({ system: "s", messages: [{ role: "user", content: "q" }], maxTokens: 8 }),
    ).rejects.toBeInstanceOf(LlmError);

    expect(capture.urls).toHaveLength(2);
  });

  it("재시도가 성공하면 그 결과를 돌려준다", async () => {
    const { fetch, capture } = stubFetch([
      () => jsonResponse(429, { type: "error", error: { type: "rate_limit_error", message: "x" } }),
      () => messageFixture([{ type: "text", text: "두 번째에 성공" }]),
    ]);
    const model = createAnthropicModel({ ...BASE, maxRetries: 1, fetch });

    const response = await model.complete({
      system: "s",
      messages: [{ role: "user", content: "q" }],
      maxTokens: 8,
    });

    expect(response.text).toBe("두 번째에 성공");
    expect(capture.urls).toHaveLength(2);
  });
});

describe("시크릿이 이 레이어를 나가지 않는다 (A4)", () => {
  /**
   * 에러에서 **모든 열거 가능한 표면**을 긁어모은다. `message` 하나만 보면
   * `cause` 체인이나 부가 프로퍼티에 실려 나가는 경로를 놓친다 — `console.error(error)`가
   * 키를 통째로 덤프한 사고가 정확히 그 형태였다.
   */
  function surfacesOf(error: unknown): string {
    const parts: string[] = [String(error)];
    if (error instanceof Error) {
      parts.push(error.message, error.stack ?? "");
      let cause: unknown = (error as { cause?: unknown }).cause;
      let depth = 0;
      while (cause !== undefined && cause !== null && depth < 5) {
        parts.push(String(cause));
        try {
          parts.push(JSON.stringify(cause, Object.getOwnPropertyNames(cause)));
        } catch {
          parts.push("<직렬화 실패>");
        }
        cause = (cause as { cause?: unknown }).cause;
        depth += 1;
      }
      try {
        parts.push(JSON.stringify(error, Object.getOwnPropertyNames(error)));
      } catch {
        parts.push("<직렬화 실패>");
      }
    }
    return parts.join("\n");
  }

  async function failWith(make: () => Response): Promise<unknown> {
    const { fetch } = stubFetch([make]);
    const model = createAnthropicModel({ ...BASE, maxRetries: 0, fetch });
    try {
      await model.complete({
        system: "s",
        messages: [{ role: "user", content: "q" }],
        maxTokens: 8,
      });
    } catch (error) {
      return error;
    }
    throw new Error("실패하지 않았다 — 이 테스트는 실패 경로를 봐야 한다");
  }

  it("401 인증 실패에서 키가 새지 않는다", async () => {
    const error = await failWith(() =>
      jsonResponse(401, {
        type: "error",
        error: { type: "authentication_error", message: "invalid x-api-key" },
      }),
    );
    expect(error).toBeInstanceOf(LlmError);
    expect((error as LlmError).code).toBe(LLM_ERROR_CODES.REQUEST_FAILED);
    expect(surfacesOf(error)).not.toContain(SECRET);
  });

  it("429 레이트리밋에서 키가 새지 않는다", async () => {
    const error = await failWith(() =>
      jsonResponse(429, { type: "error", error: { type: "rate_limit_error", message: "slow" } }),
    );
    expect(surfacesOf(error)).not.toContain(SECRET);
  });

  it("연결 자체가 실패해도 키가 새지 않는다", async () => {
    const model = createAnthropicModel({
      ...BASE,
      maxRetries: 0,
      // 전송 계층 실패를 흉내 낸다. undici가 `cause`에 요청 컨텍스트를 실어 던지는 형태다.
      fetch: () => Promise.reject(new Error(`fetch failed for key ${SECRET}`)),
    });

    let caught: unknown;
    try {
      await model.complete({
        system: "s",
        messages: [{ role: "user", content: "q" }],
        maxTokens: 8,
      });
    } catch (error) {
      caught = error;
    }

    expect(caught).toBeInstanceOf(LlmError);
    expect(surfacesOf(caught)).not.toContain(SECRET);
  });

  /*
   * 최악의 경우: 앞단 프록시가 요청 헤더를 응답 본문에 되비춘다. SDK 에러 메시지에는 본문이
   * 통째로 들어가므로, provider가 그 메시지를 옮기기만 해도 키가 그대로 새어 나간다.
   * 이 케이스가 "메시지를 옮기지 않는다"(D-10)와 `redactSecret`을 **둘 다** 요구하는 근거다.
   */
  it("응답 본문이 키를 되비추어도 키가 새지 않는다", async () => {
    const error = await failWith(() =>
      jsonResponse(400, {
        type: "error",
        error: {
          type: "invalid_request_error",
          message: `upstream rejected request with x-api-key: ${SECRET}`,
        },
      }),
    );
    expect(surfacesOf(error)).not.toContain(SECRET);
  });

  /*
   * **유출 프로브가 실제로 잡아낸 갈래다.** 200인데 본문이 JSON이 아니면 `JSON.parse`가
   * 던지고, 그 `SyntaxError`는 `APIError`가 아니라 fallback으로 떨어져 메시지를 옮긴다.
   * V8이 본문 스니펫을 10자 안팎으로 자르므로 **키 전체가 아니라 조각**이 샜다.
   *
   * 그래서 단언 대상이 `SECRET`이 아니라 **조각**이다. 전체 키로만 단언하면 이 테스트는
   * 통과하면서 실제 유출을 놓친다 — 프로브 이전의 상태가 정확히 그랬다.
   */
  it("200인데 본문이 깨졌고 그 본문이 키로 시작해도, 잘린 조각조차 새지 않는다", async () => {
    const { fetch } = stubFetch([
      () =>
        new Response(`${SECRET} <<upstream garbage>>`, {
          status: 200,
          headers: { "content-type": "application/json" },
        }),
    ]);
    const model = createAnthropicModel({ ...BASE, maxRetries: 0, fetch });

    let caught: unknown;
    try {
      await model.complete({
        system: "s",
        messages: [{ role: "user", content: "q" }],
        maxTokens: 8,
      });
    } catch (error) {
      caught = error;
    }

    expect(caught).toBeInstanceOf(LlmError);
    const surfaces = surfacesOf(caught);
    // 실측으로 새던 조각(앞 10자)과 마스킹 하한(8자) 둘 다 확인한다.
    expect(surfaces).not.toContain(SECRET.slice(0, 10));
    expect(surfaces).not.toContain(SECRET.slice(0, 8));
    expect(surfaces).not.toContain(SECRET);
    // 마스킹이 일어났다는 증거 — 메시지를 통째로 지워 진단을 불가능하게 만든 것이 아니다.
    expect((caught as LlmError).message).toContain(REDACTED);
  });

  it("그래도 진단에 필요한 것은 남는다 — status·type·requestId", async () => {
    const error = await failWith(() =>
      jsonResponse(401, {
        type: "error",
        error: { type: "authentication_error", message: "invalid x-api-key" },
      }),
    );
    const message = (error as LlmError).message;
    expect(message).toContain("status=401");
    expect(message).toContain("type=authentication_error");
    expect(message).toContain("requestId=req_fixture");
  });
});

describe("생성 시점 검증", () => {
  it("키가 비어 있으면 만들지 못한다", () => {
    expect(() => createAnthropicModel({ ...BASE, apiKey: "" })).toThrow(LlmError);
  });

  it("모델이 비어 있으면 만들지 못한다", () => {
    expect(() => createAnthropicModel({ ...BASE, model: "" })).toThrow(LlmError);
  });
});
