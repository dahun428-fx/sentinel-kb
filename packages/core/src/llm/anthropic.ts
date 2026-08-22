/**
 * 실 LLM provider. 출처: specs/03-rag-pipeline.md §4, specs/05 Eval 3, NFR-01·NFR-02, T-039.
 *
 * ## 왜 공식 SDK인가 — `embedder/voyage.ts`의 raw-fetch 선례를 복사하지 않는다 (T-018 D-2)
 *
 * voyage가 `fetch`를 직접 쓰는 근거는 "provider 교체(NFR-06)가 SDK 버전에 막히지 않게"이고
 * 임베딩에는 타당하다 — 임베딩 요청은 `{model, input}` 두 필드가 전부라 계약이 거의 움직이지
 * 않는다. Messages API는 다르다. 파라미터 계약이 세대마다 움직였고(샘플링 파라미터 제거,
 * thinking의 형태 변경, effort 도입, 비스트리밍 max_tokens 가드) 손으로 만든 클라이언트는
 * 그 변화를 **조용히** 놓친다. 그래서 여기는 `@anthropic-ai/sdk`다.
 *
 * ## 요청 표면을 최소로 유지한다 (T-039 D-3·D-8)
 *
 * 보내는 것은 `model`·`max_tokens`·`system`·`messages`(+도구 선택 경로의 `tools`)뿐이다.
 *
 *  - **샘플링 파라미터(`temperature`류)를 보내지 않는다.** 현행 Claude 모델은 그것을 400으로
 *    거절한다(T-018 D-3). 생성의 결정론은 온도가 아니라 fake 주입으로 얻는다(specs/05).
 *  - **`thinking`·`output_config`를 보내지 않는다.** 모델 ID가 env로 교체 가능해야 하는데
 *    (D-2) 그 둘은 모델마다 수용 여부가 다르다. 교체 가능성을 요구하는 설계에서 요청 표면은
 *    **모든 세대가 받는 최소 집합**이어야 한다. 최신 모델은 `thinking`을 생략하면 적응형으로
 *    돌므로 품질 손실도 없다.
 *
 * ## 비스트리밍인 이유 (T-039 D-6 정정)
 *
 * SDK는 `max_tokens`가 크고 **타임아웃이 미지정일 때만** "스트리밍이 필요하다"고 던진다
 * (`client.js` `calculateNonstreamingTimeout`, 호출 조건이 `!body.stream && timeout == null`).
 * 우리는 타임아웃을 **명시**하므로(config.ts D-5) 그 가드를 타지 않고, 그렇다면 스트리밍으로
 * 얻을 것이 없다 — `complete()`의 계약은 완성된 텍스트 1건이고, 실제 구속 조건은 전송 방식이
 * 아니라 **벽시계 상한**이다. 전송 모양이 하나면 요청 바디를 만드는 자리도 하나이고,
 * 가드 테스트가 볼 표면도 하나다.
 *
 * 토큰 스트리밍(T-019 F-4)은 이 파일이 아니라 `answer.ts`·`generate.ts`의 재설계가 필요하다 —
 * 근거는 T-039 D-6.
 *
 * ## 시크릿은 이 레이어를 나가지 않는다 (T-039 D-10)
 *
 * 아래 `toLlmError`는 SDK 에러의 `message`도 응답 본문도 **옮기지 않는다.** 옮기는 것은
 * `status`·`type`·`requestId`뿐이고, SDK 에러를 `cause`로 달지도 않는다 — `cause` 체인이
 * `JSON.stringify`나 `console.error(error)`에 걸려 통째로 덤프되는 것이 실제로 있었던 사고다.
 *
 * 그 위에 `redactSecret()`을 한 겹 더 씌운다. **이 겹이 실제로 일하는 자리가 있다**:
 * 200인데 본문이 JSON이 아니면 `JSON.parse`가 던지고 그 메시지에 본문 스니펫이 실리는데,
 * 그 갈래는 `APIError`가 아니라 아래 fallback으로 떨어져 `detail`을 옮긴다. 유출 프로브로
 * 실측해 키 앞 10자가 새는 것을 확인했고(V8이 스니펫을 자른다), 그래서 마스킹이 전체 일치가
 * 아니라 **조각 단위**다 — `redactSecret` 주석 참조.
 */
import Anthropic from "@anthropic-ai/sdk";

import type { AnthropicConfig } from "./config.js";
import type {
  ToolChoiceModel,
  ToolSelectionRequest,
  ToolSelectionResponse,
  ToolSpec,
  ToolUse,
} from "./tools.js";
import { LLM_ERROR_CODES, LlmError, type ChatModel, type ChatRequest, type ChatResponse } from "./types.js";

/** SDK가 쓰는 `fetch` 시그니처. 테스트가 HTTP를 대체하는 지점(specs/05 결정론 원칙). */
export type SdkFetch = (input: string | URL | Request, init?: RequestInit) => Promise<Response>;

/**
 * 너무 짧은 문자열을 마스킹하면 메시지가 통째로 지워진다. 실제 API 키는 세 자릿수 길이라
 * 이 하한에 걸릴 일이 없고, 하한 아래의 값은 애초에 유효한 키가 아니다.
 */
const MIN_REDACTABLE_SECRET_CHARS = 8;

/** 마스킹 표식. 이 문자열이 로그에 보이면 "가릴 것이 실제로 있었다"는 뜻이다. */
export const REDACTED = "<redacted>";

/**
 * `text`에서 `secret`을 지운다 — **전체 일치뿐 아니라 길이 8 이상의 조각까지** 지운다.
 *
 * 정규식을 만들지 않는다: 키에 정규식 메타문자가 있으면 패턴이 깨지거나 엉뚱한 곳을 지운다.
 *
 * ## 왜 조각까지 지우는가 (실측으로 나온 요구사항)
 *
 * 실패를 실제로 유발해 에러 표면 전체를 덤프하고 grep해 봤더니(T-039 유출 프로브),
 * 한 갈래에서 **키의 앞 10자가 샜다**: 200인데 본문이 JSON이 아니면 `JSON.parse`가 던지고
 * 그 `SyntaxError` 메시지에 본문 스니펫이 실리는데, V8이 그것을 10자 안팎으로 **자른다**.
 * 잘린 조각은 키 전체와 일치하지 않으므로 전체 일치 마스킹은 그것을 놓친다.
 *
 * 그 10자가 `sk-ant-api` 같은 공개 접두라 엔트로피는 없다. 그래도 지운다 — 유출 여부를
 * "지금 새는 조각이 마침 무해한가"로 판단하기 시작하면, 자르는 길이나 본문 배치가 조금만
 * 달라져도 판단이 뒤집힌다. 방어선은 **조각이 새지 않는다**여야 한다.
 *
 * 긴 조각부터 지운다 — 짧은 조각을 먼저 지우면 긴 조각이 쪼개져 마스킹 표식 사이에 잔여물이
 * 남는다. 비용은 키 길이의 제곱에 비례하지만 **에러 경로에서만** 돈다.
 */
export function redactSecret(text: string, secret: string): string {
  if (secret.length < MIN_REDACTABLE_SECRET_CHARS) return text;
  let out = text;
  for (let length = secret.length; length >= MIN_REDACTABLE_SECRET_CHARS; length -= 1) {
    for (let start = 0; start + length <= secret.length; start += 1) {
      const fragment = secret.slice(start, start + length);
      if (out.includes(fragment)) out = out.split(fragment).join(REDACTED);
    }
  }
  return out;
}

export interface AnthropicModelOptions extends AnthropicConfig {
  /** 테스트가 HTTP를 대체하는 지점. 기본은 SDK의 전역 `fetch`. */
  readonly fetch?: SdkFetch;
}

/**
 * `ChatModel`과 `ToolChoiceModel`을 **한 구현이 둘 다** 만족한다.
 *
 * 나누지 않은 이유: 자격증명·재시도 정책·HTTP 클라이언트가 완전히 같다. 나뉘어야 하는 것은
 * **호출 표면**이지 구현이 아니다(T-039 D-7). 소비자는 필요한 인터페이스로만 받으면 된다 —
 * `generateAnswer`는 `ChatModel`만 알고, 그 덕분에 T-018의 스파이 단언이 그대로 유효하다.
 */
export function createAnthropicModel(options: AnthropicModelOptions): ChatModel & ToolChoiceModel {
  const { model, apiKey, timeoutMs, maxRetries } = options;

  if (!apiKey) {
    throw new LlmError(
      LLM_ERROR_CODES.API_KEY_MISSING,
      "ANTHROPIC_API_KEY가 비어 있다 — 모델을 만들 수 없다.",
    );
  }
  if (!model) {
    throw new LlmError(
      LLM_ERROR_CODES.MODEL_MISSING,
      "ANTHROPIC_MODEL이 비어 있다 — 모델을 만들 수 없다.",
    );
  }

  /*
   * `timeout`·`maxRetries`를 **명시**한다. SDK 기본(10분 / 2회)을 그대로 두면 최악 30분이고
   * MCP 클라이언트의 3회 시도와 곱해져 요청 1건에 모델 호출 9회가 된다(T-019 F-7).
   * 값의 근거는 `config.ts`의 역산에 있다.
   */
  const client = new Anthropic({
    apiKey,
    timeout: timeoutMs,
    maxRetries,
    ...(options.fetch === undefined ? {} : { fetch: options.fetch }),
  });

  return {
    model,

    async complete(request: ChatRequest): Promise<ChatResponse> {
      const message = await send(client, apiKey, {
        model,
        max_tokens: request.maxTokens,
        system: request.system,
        messages: request.messages.map((m) => ({ role: m.role, content: m.content })),
      });

      return {
        text: textOf(message.content),
        // 응답이 알려 준 모델을 그대로 싣는다. 요청한 별칭과 다를 수 있고, 로그·eval 리포트가
        // 세대를 구분하는 근거는 **실제로 답한 모델**이다(`ChatResponse.model` 주석).
        model: message.model,
        stopReason: message.stop_reason,
      };
    },

    async selectTool(request: ToolSelectionRequest): Promise<ToolSelectionResponse> {
      /*
       * **`tool_choice`를 보내지 않는다.** 강제하면 모델이 언제나 도구를 고르므로 Eval 3이
       * 재려는 "올바른 도구를 골랐는가"가 무의미해지고, "아무것도 고르지 않는 것이 정답"인
       * 시나리오를 표현할 수 없다.
       *
       * **`strict: true`도 붙이지 않는다.** Eval 3은 **필수 인자를 모델이 채웠는지**를 재는데,
       * 스키마 강제는 그 실패를 서버 측에서 가려 버려 채점기가 볼 수 없게 만든다.
       */
      const message = await send(client, apiKey, {
        model,
        max_tokens: request.maxTokens,
        ...(request.system === undefined ? {} : { system: request.system }),
        messages: request.messages.map((m) => ({ role: m.role, content: m.content })),
        tools: request.tools.map(toSdkTool),
      });

      return {
        toolUses: toolUsesOf(message.content),
        text: textOf(message.content),
        model: message.model,
        stopReason: message.stop_reason,
      };
    },
  };
}

/** 우리 `ToolSpec` → SDK `Tool`. 경계가 여기 하나라 provider 교체 시 바뀌는 곳도 여기뿐이다. */
function toSdkTool(spec: ToolSpec): Anthropic.Tool {
  return {
    name: spec.name,
    description: spec.description,
    // 스키마의 내부 형상은 `packages/mcp`가 소스다. 이 계층은 옮기기만 하므로 좁히지 않는다.
    input_schema: spec.inputSchema as Anthropic.Tool.InputSchema,
  };
}

/** 요청 1건. 실패는 전부 `toLlmError`를 거쳐 나간다 — 시크릿 비유출의 단일 관문이다. */
async function send(
  client: Anthropic,
  apiKey: string,
  body: Anthropic.MessageCreateParamsNonStreaming,
): Promise<Anthropic.Message> {
  try {
    return await client.messages.create(body);
  } catch (error) {
    throw toLlmError(error, apiKey);
  }
}

function textOf(content: readonly Anthropic.ContentBlock[]): string {
  return content
    .filter((block): block is Anthropic.TextBlock => block.type === "text")
    .map((block) => block.text)
    .join("");
}

/**
 * `tool_use` 블록만 뽑는다. **아무것도 없으면 빈 배열이고 그것이 정상 응답이다** —
 * "고르지 않음"을 에러로 접으면 Eval 3의 채점기가 그 케이스를 볼 수 없다(`tools.ts` 주석).
 */
function toolUsesOf(content: readonly Anthropic.ContentBlock[]): ToolUse[] {
  return content
    .filter((block): block is Anthropic.ToolUseBlock => block.type === "tool_use")
    .map((block) => ({ name: block.name, input: block.input }));
}

/**
 * SDK 에러 → `LlmError`. **응답 본문도 SDK 메시지도 옮기지 않는다**(T-039 D-10).
 *
 * 진단에 필요한 것은 셋이다: 상태 코드, 에러 타입, `requestId`. 마지막 것이 provider 지원에
 * 문의할 때 쓰는 실제 손잡이이고, 셋 중 어느 것도 자격증명을 담을 수 없다.
 * SDK 에러를 `cause`로 달지 않는 이유도 같다 — 그 객체를 통째로 찍는 코드가 어딘가에 생기면
 * 그 순간 방어선이 무너진다. 방어는 "찍지 마라"가 아니라 "찍을 것이 없다"여야 한다.
 */
function toLlmError(error: unknown, apiKey: string): LlmError {
  if (error instanceof Anthropic.APIError) {
    const parts = [
      `status=${String(error.status ?? "none")}`,
      `type=${error.type ?? "none"}`,
      `requestId=${error.requestID ?? "none"}`,
    ];
    return new LlmError(
      LLM_ERROR_CODES.REQUEST_FAILED,
      redactSecret(`Anthropic 요청이 실패했다(${parts.join(", ")}).`, apiKey),
    );
  }

  // SDK 밖의 실패(주입 fetch의 버그, AbortError 등). 여기서도 원본 객체는 달지 않는다.
  const detail = error instanceof Error ? error.message : String(error);
  return new LlmError(
    LLM_ERROR_CODES.REQUEST_FAILED,
    redactSecret(`Anthropic 호출이 실패했다: ${detail}`, apiKey),
  );
}
