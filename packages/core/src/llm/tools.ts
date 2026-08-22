/**
 * 도구 선택 호출 계층. 출처: specs/05-test-strategy.md Eval 3, specs/07-mcp.md:44(G6), T-039 D-7.
 *
 * ## 왜 `ChatRequest`에 `tools`를 붙이지 않았나 (T-039 D-7)
 *
 * specs/05 Eval 3의 판정 방식은 "**도구 목록만 주고 Claude에게 제시** → 올바른 도구 + 필수
 * 인자 선택률"이다. `ChatRequest`는 `{system, messages, maxTokens}`뿐이라 도구를 실을 자리가
 * 없었고, 그래서 T-016 Acceptance 1이 원리적으로 판정 불가였다. specs/07:44가
 * "description 변경은 계약 변경 → tool-selection eval 재실행 필수(G6)"를 못박는데 그 eval이
 * 돌 수 없으니 **G6는 이행 수단이 없는 조항**이었다. 끊긴 고리가 여기다.
 *
 * 그 고리를 `ChatRequest`에 `tools?`를 더해서 잇지 **않은** 이유 셋:
 *
 *  1. **T-018 Acceptance 1의 스파이 단언이 흐려진다.** `generateAnswer`의 계약은 "임계값 미달이면
 *     `complete()` 호출이 **0회**"이고 `FakeChatModel.calls`가 그 증거다. 같은 메서드가 두 용도를
 *     지면 그 기록이 무엇의 증거인지 흐려지고, 생성 테스트마다 언제나 비어 있는 `tools` 필드를
 *     지고 다니게 된다.
 *  2. **응답 형상이 다르다.** 생성의 본체는 `text`, 도구 선택의 본체는 `{name, input}[]`이다.
 *     한 응답 타입으로 합치면 모든 소비자가 자기 경로에서 **올 수 없는 갈래**를 좁혀야 한다.
 *  3. **specs/05가 층으로 갈라 뒀다.** 생성은 제품 경로(Eval 2), 도구 선택은 eval 전용(Eval 3)이다.
 *     제품 인터페이스에 eval 전용 파라미터를 심으면 그 경계가 코드에서 사라진다.
 *
 * 구현은 나누지 않는다 — `createAnthropicModel()` 하나가 두 인터페이스를 모두 만족한다.
 * 자격증명·재시도 정책·HTTP 클라이언트가 같기 때문이다. 나뉘는 것은 **호출 표면**이다.
 */

/**
 * 모델에 제시하는 도구 1개. **SDK 타입을 그대로 노출하지 않는다** — provider 교체 시
 * `packages/mcp`와 eval 러너가 SDK 타입에 결합돼 있으면 교체가 그 파일들까지 번진다
 * (`Embedder`가 provider HTTP 형상을 감추는 것과 같은 경계).
 */
export interface ToolSpec {
  readonly name: string;
  readonly description: string;
  /**
   * JSON Schema. `{"type":"object", properties, required}` 형태를 기대하지만 형상을 여기서
   * 좁히지 않는다 — 소스는 `packages/mcp`의 도구 스키마이고, 이 계층은 그것을 **옮기기만** 한다.
   */
  readonly inputSchema: Record<string, unknown>;
}

/** 모델이 고른 도구 1건. `input`은 모델이 만든 값이므로 신뢰하지 않고 그대로 넘긴다. */
export interface ToolUse {
  readonly name: string;
  readonly input: unknown;
}

export interface ToolSelectionRequest {
  /** 시스템 프롬프트. Eval 3은 도구 설명만으로 고르게 하는 것이 목적이라 대개 비운다. */
  readonly system?: string;
  readonly messages: readonly { readonly role: "user" | "assistant"; readonly content: string }[];
  readonly tools: readonly ToolSpec[];
  readonly maxTokens: number;
}

export interface ToolSelectionResponse {
  /**
   * 모델이 고른 도구들. **아무것도 고르지 않으면 빈 배열이다.**
   * "고르지 않음"을 오답이나 에러로 접지 않는다 — Eval 3에는 그것이 정답인 시나리오가
   * 있을 수 있고, 접어 버리면 채점기가 그 케이스를 볼 수 없다.
   */
  readonly toolUses: readonly ToolUse[];
  /** 도구와 함께 나온 산문(있으면). 오답 분석에 쓰인다 — T-016 Acceptance 2. */
  readonly text: string;
  readonly model: string;
  readonly stopReason: string | null;
}

/**
 * 도구 선택의 유일한 통로. `ChatModel`과 **형제**이지 상하 관계가 아니다.
 * 실제 모델 호출은 여전히 eval 계층에서만 일어난다(specs/05 결정론 원칙) —
 * unit/integration은 `createFakeToolChoiceModel()`을 쓴다.
 */
export interface ToolChoiceModel {
  selectTool(request: ToolSelectionRequest): Promise<ToolSelectionResponse>;
  readonly model: string;
}
