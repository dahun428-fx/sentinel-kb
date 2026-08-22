/**
 * 컴포지션 루트 배선 가드. 출처: T-039 Acceptance A6, T-019 F-8, T-012 G5 지적.
 *
 * ## 왜 이 테스트가 필요한가 — 가드가 초록인데 표면이 없던 자리
 *
 * `openapi.spec.ts`의 드리프트 가드는 자기가 만든 앱(`makeApp()`)을 본다. 그 앱은
 * `chatModel`을 주입하므로 `/v1/answer`가 뜬다. 그런데 `server.ts`는 그 값을 만들지 못했고,
 * 그래서 **가드는 초록인데 프로덕션엔 그 라우트가 없었다**(T-019 F-8). "`server.ts` 배선을
 * 검증하는 테스트가 없다"는 T-012 G5 지적이 실제 간극으로 나타난 자리다.
 *
 * ## 왜 `start()`를 부르지 않고 소스를 읽는가
 *
 * `start()`는 Mongo에 붙고 포트를 잡는다. 단위 테스트가 그것을 하면 CI가 DB와 네트워크에
 * 결합되고, 잡히지 않는 포트 때문에 흔들린다. 여기서 잠그려는 것은 런타임 동작이 아니라
 * **배선의 존재**다 — "컴포지션 루트가 chatModel을 만들어 넘기는가". 그건 소스에서 판정 가능하고,
 * 판정 가능한 가장 싼 방법이 이것이다(`no-hardcoded-model.spec.ts`와 같은 fs 기반 규약).
 *
 * ⚠️ 한계를 숨기지 않는다: 이 테스트는 `createChatModel()`이 **실제로 던지는지**를 재지 않는다.
 * 그 동작은 `llm/config.spec.ts`가 잠근다. 여기가 잠그는 것은 그 둘을 잇는 한 줄이다.
 */
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";

const SERVER_SOURCE = readFileSync(fileURLToPath(new URL("./server.ts", import.meta.url)), "utf8");

/** 주석을 걷어낸다. 산문에는 `createChatModel`이 근거 설명으로 등장한다 — 검사 대상은 코드다. */
const SERVER_CODE = SERVER_SOURCE.replace(/\/\*[\s\S]*?\*\//g, " ").replace(/\/\/.*$/gm, " ");

describe("server.ts 컴포지션 루트 배선 (T-019 F-8 간극)", () => {
  it("검사 대상 소스를 실제로 읽었다", () => {
    // 경로가 틀려 빈 문자열을 검사하면 아래 단언들이 공허하게 통과한다.
    expect(SERVER_CODE.length).toBeGreaterThan(0);
    expect(SERVER_CODE).toContain("createApp");
  });

  // A6
  it("createChatModel을 core에서 import한다", () => {
    expect(SERVER_CODE).toContain("createChatModel");
    expect(/import\s*\{[^}]*createChatModel[^}]*\}\s*from\s*"@sentinel\/core"/s.test(SERVER_CODE)).toBe(
      true,
    );
  });

  // A6
  it("createApp 호출에 chatModel을 넘긴다 — /v1/answer가 프로덕션에서 뜬다", () => {
    const call = /createApp\(\{([\s\S]*?)\}\)/.exec(SERVER_CODE);
    expect(call, "createApp 호출을 찾지 못했다").not.toBeNull();
    expect(call?.[1] ?? "").toContain("chatModel: createChatModel()");
  });

  /*
   * T-039 D-4. 부팅 거부가 이 배선의 요점이다 — `createChatModel()`이 `start()` 안에서
   * 무조건 불려야 오설정이 **부팅에서** 드러난다. try/catch로 감싸 옵셔널하게 만들면
   * 라우트가 조용히 사라지는 F-8 상태로 되돌아간다.
   */
  it("createChatModel 호출을 try/catch로 삼키지 않는다", () => {
    const guarded = /try\s*\{[^}]*createChatModel/s.test(SERVER_CODE);
    expect(guarded, "createChatModel이 try 블록 안에 있다 — 오설정이 조용히 넘어간다").toBe(false);
  });

  it("retriever도 여전히 배선돼 있다 — answer는 검색 없이는 뜨지 않는다", () => {
    const call = /createApp\(\{([\s\S]*?)\}\)/.exec(SERVER_CODE);
    expect(call?.[1] ?? "").toContain("retriever");
  });
});
