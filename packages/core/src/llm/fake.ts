/**
 * 테스트·eval-스모크용 결정론적 `ChatModel`. 출처: specs/05 "결정론 원칙 — LLM·임베딩
 * 호출은 인터페이스로 격리하고 unit/integration에서는 fixture 목을 쓴다".
 *
 * `calls`를 노출하는 이유: T-018 Acceptance 1이 "임계값 미달 입력 → 생성 호출이 **아예
 * 발생하지 않음**(스파이 검증)"을 요구한다. "호출하고 결과를 버렸다"와 "부르지 않았다"는
 * 비용이 다르고, 후자만이 스펙이 요구하는 동작이다. 호출 기록이 없으면 그 둘을 구별할 수 없다.
 */
import type {
  ToolChoiceModel,
  ToolSelectionRequest,
  ToolSelectionResponse,
  ToolUse,
} from "./tools.js";
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

/** 컨텍스트 블록의 `citation="[REC-...]"` 속성. `generator/context.ts`가 만든 그 문자열이다. */
const CONTEXT_CITATION_RE = /citation="(\[REC-[^"]+\])"/g;

/**
 * 기본 응답. **인용을 붙인다 — 이것이 픽스처의 정확성 요건이다(T-020).**
 *
 * specs/03 §5의 인용 후처리 검증이 붙은 뒤로는, 인용 없는 답을 내는 fake는 "무해한
 * 플레이스홀더"가 아니라 **언제나 위반 경로를 타는 모델**이다. 그런 fake를 기본값으로 두면
 * 게이트·컨텍스트를 재는 테스트가 전부 재생성·문장 제거 경로를 지나게 되고, 무엇을 재는
 * 테스트인지가 흐려진다. 그래서 요청에 실린 인용을 그대로 복사해 붙인다 —
 * 시스템 프롬프트 조항 2를 지키는 최소한의 답변이다.
 *
 * 위반 경로를 재는 테스트는 `reply`를 **명시적으로** 넘긴다. 기본값이 우연히 위반을 만드는
 * 것과, 테스트가 위반을 의도적으로 만드는 것은 다르다.
 */
function defaultReply(request: ChatRequest): string {
  const body =
    `[fake] messages=${String(request.messages.length)} ` +
    `systemChars=${String(request.system.length)}`;
  const citations = [...request.messages.map((message) => message.content).join("\n").matchAll(CONTEXT_CITATION_RE)]
    .map((match) => match[1])
    .filter((citation, index, all) => all.indexOf(citation) === index);
  return citations.length === 0 ? body : `${body} ${citations.join("")}`;
}

export function createFakeChatModel(options: FakeChatModelOptions = {}): FakeChatModel {
  const model = options.model ?? DEFAULT_FAKE_MODEL;
  const calls: ChatRequest[] = [];
  const reply = options.reply ?? defaultReply;

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

/**
 * 도구 선택용 fake. `FakeChatModel`과 **별개 객체**다 — 두 호출 표면을 나눈 근거(T-039 D-7)를
 * 테스트 도구에서 다시 합치면 그 경계가 테스트에서만 사라진다.
 *
 * `calls`를 노출하는 이유는 같다: "무엇을 물어봤는가"가 채점기 검증의 근거이고,
 * 특히 **도구 목록을 실제로 실어 보냈는지**는 기록이 없으면 확인할 수 없다.
 */
export interface FakeToolChoiceModel extends ToolChoiceModel {
  readonly calls: ToolSelectionRequest[];
}

export interface FakeToolChoiceModelOptions {
  readonly model?: string;
  /**
   * 요청 → 고른 도구들. **기본은 빈 배열(=아무것도 고르지 않음)이다.**
   * "첫 번째 도구를 고른다" 같은 기본값을 두면 채점기 테스트가 자기충족적이 된다 —
   * 시나리오가 무엇이든 정답 도구가 첫 자리에 오도록 픽스처를 짜면 통과하기 때문이다.
   */
  readonly pick?: (request: ToolSelectionRequest) => ToolUse[];
  readonly text?: (request: ToolSelectionRequest) => string;
  readonly stopReason?: string | null;
}

const DEFAULT_FAKE_TOOL_MODEL = "fake-tool-choice-model";

export function createFakeToolChoiceModel(
  options: FakeToolChoiceModelOptions = {},
): FakeToolChoiceModel {
  const model = options.model ?? DEFAULT_FAKE_TOOL_MODEL;
  const calls: ToolSelectionRequest[] = [];
  const pick = options.pick ?? ((): ToolUse[] => []);
  const text = options.text ?? ((): string => "");

  return {
    model,
    calls,
    selectTool(request: ToolSelectionRequest): Promise<ToolSelectionResponse> {
      calls.push(request);
      const toolUses = pick(request);
      return Promise.resolve({
        toolUses,
        text: text(request),
        model,
        stopReason: options.stopReason ?? (toolUses.length > 0 ? "tool_use" : "end_turn"),
      });
    },
  };
}
