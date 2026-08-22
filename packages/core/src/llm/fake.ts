/**
 * 테스트·eval-스모크용 결정론적 `ChatModel`. 출처: specs/05 "결정론 원칙 — LLM·임베딩
 * 호출은 인터페이스로 격리하고 unit/integration에서는 fixture 목을 쓴다".
 *
 * `calls`를 노출하는 이유: T-018 Acceptance 1이 "임계값 미달 입력 → 생성 호출이 **아예
 * 발생하지 않음**(스파이 검증)"을 요구한다. "호출하고 결과를 버렸다"와 "부르지 않았다"는
 * 비용이 다르고, 후자만이 스펙이 요구하는 동작이다. 호출 기록이 없으면 그 둘을 구별할 수 없다.
 */
import type { ChatModel, ChatRequest, ChatResponse } from "./types.js";

/** 호출을 기록하는 fake. `calls.length === 0`이 "부르지 않았다"의 증거다. */
export interface FakeChatModel extends ChatModel {
  readonly calls: ChatRequest[];
}

export interface FakeChatModelOptions {
  readonly model?: string;
  /**
   * 요청 → 응답 텍스트. 기본은 요청을 그대로 되비추는 결정론적 문자열이다.
   * 랜덤·시간을 쓰지 않는다 — 그러면 같은 입력이 실행마다 다른 답을 내고 테스트가 흔들린다.
   */
  readonly reply?: (request: ChatRequest) => string;
  readonly stopReason?: string | null;
}

const DEFAULT_FAKE_MODEL = "fake-chat-model";

export function createFakeChatModel(options: FakeChatModelOptions = {}): FakeChatModel {
  const model = options.model ?? DEFAULT_FAKE_MODEL;
  const calls: ChatRequest[] = [];
  const reply =
    options.reply ??
    ((request: ChatRequest): string =>
      `[fake] messages=${String(request.messages.length)} ` +
      `systemChars=${String(request.system.length)}`);

  return {
    model,
    calls,
    complete(request: ChatRequest): Promise<ChatResponse> {
      calls.push(request);
      return Promise.resolve({
        text: reply(request),
        model,
        stopReason: options.stopReason ?? "end_turn",
      });
    },
  };
}
