/**
 * MCP 프롬프트 등록. 계약: specs/07-mcp.md `## Prompts` — **`postmortem-interview` 1개만.**
 *
 * ---
 * ## 왜 본문이 `.md` 파일인가 (T-038 Scope)
 *
 * 프롬프트 텍스트는 도구 description과 같은 **계약물**이다. 문자열 리터럴로 코드에 인라인하면
 * diff가 이스케이프와 뒤섞여 "질문 순서가 바뀌었다"가 리뷰에서 보이지 않는다.
 * T-018이 생성기 프롬프트를 `prompts/answer.md`로 분리하는 것과 같은 규약이다.
 * 여기서는 파일을 **읽어서 그대로** 내보낸다 — 문자열을 조립하지 않는다.
 *
 * ## 왜 인자가 없는가 (T-038 D-1)
 *
 * 1. **NFR-05.** 인자를 받으면 `prompts/get` 응답에 호출자 문자열을 끼워 넣는 경로가 생기고,
 *    그 순간 프롬프트는 `get_record`처럼 data 래핑이 필요한 표면이 된다. 인자가 0개면
 *    응답은 파일 내용 그대로인 상수라, 래핑할 외부 텍스트가 **존재하지 않는다.**
 * 2. 인자로 받을 만한 값은 `type` 하나인데, **그것을 미리 묻는 것이 이 프롬프트가 막으려는
 *    바로 그 실수다.** 종류 판별은 인터뷰 2단계에 있고 1단계 관측에서 데이터로 갈라져야 한다.
 *
 * 나중에 인자를 붙인다면 열거형만 허용하고 자유 텍스트는 금지한다.
 *
 * ## `tools`와 달리 스캐폴딩이 필요 없다 (T-038 D-2)
 *
 * T-014 F-7의 `ensureToolListing`(등록→삭제)은 **도구가 0개**여서 존재했다. SDK는
 * `registerPrompt` → `setPromptRequestHandlers()` → `registerCapabilities({prompts:…})` 순으로
 * 첫 등록 시점에 capability를 단다. 여기서는 프롬프트를 실제로 1개 등록하므로 정상 경로로 선다.
 */
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";

export const POSTMORTEM_INTERVIEW_PROMPT_NAME = "postmortem-interview";

/**
 * 프롬프트 개수 상한. 출처: specs/07-mcp.md("`postmortem-interview` 1개만").
 * 도구 상한(`MAX_TOOLS`)과 같은 이유로 **부팅에서** 강제한다 — 테스트에서만 세면
 * 프로덕션 경로는 2개째 프롬프트를 그대로 통과시킨다.
 */
export const MAX_PROMPTS = 1;

/**
 * 프롬프트 토큰 예산. NFR-03(~800)은 `search_knowledge` 응답의 예산이라 여기 적용되지 않는다 —
 * 검색 결과는 디버깅 루프마다 반복해서 들어오지만 이 프롬프트는 기록 한 건당 한 번 들어온다.
 * 그래도 상한이 없으면 프롬프트는 조용히 자란다.
 *
 * **판정은 실 토크나이저로 한다**(`postmortem-interview.int.spec.ts`, cl100k·o200k 중 비싼 쪽).
 * `format.ts`의 `estimateTokens`를 쓰지 않는 이유: 그 근사의 `high`는 **적대적 입력**
 * (남이 쓴 레코드 본문)을 겨냥한 보정값이라 한글 코드포인트당 2.70을 매기고,
 * 리뷰를 거쳐 레포에 체크인된 이 파일에는 3배 가까이 비관적이다(7,346 대 실측 3,332).
 *
 * 현재 본문은 실측 3,332토큰이다. 예산은 한 절을 더 쓸 여유는 주고 두 배로 늘릴 여유는 주지 않는다.
 */
export const PROMPT_TOKEN_BUDGET = 4000;

export const POSTMORTEM_INTERVIEW_PROMPT_PATH = fileURLToPath(
  new URL("./postmortem-interview.md", import.meta.url),
);

/**
 * 프롬프트 본문. **모듈 로드 시점에 한 번 읽는다** — 요청마다 읽으면 HTTP 모드가
 * 요청당 서버를 새로 만드는 구조(T-014 D-6)에서 디스크 I/O가 요청마다 붙는다.
 * BOM은 지운다(파일이 다른 편집기를 거쳐도 응답 바이트가 흔들리지 않게).
 */
export const POSTMORTEM_INTERVIEW_PROMPT = readFileSync(
  POSTMORTEM_INTERVIEW_PROMPT_PATH,
  "utf8",
).replace(/^\uFEFF/, "");

/**
 * `prompts/list`에 나가는 설명. 도구 description과 같은 규칙으로 쓴다:
 * **무엇을 + 언제 부르는지 + 경계**(`mcp-tool-conventions` 스킬).
 */
export const POSTMORTEM_INTERVIEW_DESCRIPTION =
  "방금 해결한 장애나 AI 에이전트 이격 사건을 검색 가능한 기록으로 바꾸는 인터뷰 진행 지침이다. " +
  "**문제를 해결한 직후, record_knowledge를 부르기 전에** 이 프롬프트를 불러 순서대로 질문한다. " +
  "관측 → 종류 판별 → 원인 → 조치 → 재발 방지 → 제목 순서와 각 섹션의 합격 기준을 담고 있다. " +
  "저장 자체는 하지 않는다(저장은 record_knowledge, 찾기는 search_knowledge).";

function registerPostmortemInterview(server: McpServer): void {
  server.registerPrompt(
    POSTMORTEM_INTERVIEW_PROMPT_NAME,
    {
      title: "포스트모템 인터뷰",
      description: POSTMORTEM_INTERVIEW_DESCRIPTION,
      // argsSchema 없음 — T-038 D-1. 붙이는 순간 NFR-05 검토가 다시 필요하다.
    },
    () => ({
      messages: [
        {
          role: "user",
          // 파일 내용 **그대로**. 조립하거나 잘라내지 않는다.
          content: { type: "text", text: POSTMORTEM_INTERVIEW_PROMPT },
        },
      ],
    }),
  );
}

/** 등록기 목록. 늘리는 것은 스펙 개정 + 인간 승인 사항이다(specs/07). */
const REGISTRARS = [registerPostmortemInterview] as const;

/**
 * **서버에 실제로 등록된 프롬프트 수**를 센다. `REGISTRARS.length`가 아니다 —
 * 등록기 하나가 프롬프트 둘을 등록해도 배열 길이는 1을 보고한다(`tools/index.ts`와 같은 논거).
 * SDK가 프롬프트를 담는 곳은 `McpServer._registeredPrompts` 하나뿐이라 거기를 세고,
 * **못 세면 던진다** — 세지 못하는 상태로 통과시키면 상한이 조용히 사라진다.
 */
function countRegisteredPrompts(server: McpServer): number {
  const registry = (server as unknown as { readonly _registeredPrompts?: unknown })
    ._registeredPrompts;
  if (typeof registry !== "object" || registry === null) {
    throw new Error(
      "MCP SDK의 프롬프트 레지스트리(_registeredPrompts)를 찾지 못했다. SDK 업그레이드로 형상이 바뀌었을 수 있다 — " +
        "프롬프트 개수 상한(specs/07 'postmortem-interview 1개만')을 강제할 수 없는 상태로 부팅하지 않는다.",
    );
  }
  return Object.keys(registry).length;
}

/** 등록을 마친 뒤 **실제 등록 프롬프트 수**를 돌려준다 — `createMcpServer`의 상한 가드가 이 값을 본다. */
export function registerAllPrompts(server: McpServer): number {
  for (const register of REGISTRARS) register(server);
  return countRegisteredPrompts(server);
}

/**
 * 본문이 비었거나 잘린 채로 서버가 뜨지 않게 한다. 파일 로드는 조용히 실패하지 않지만
 * **잘못된 파일을 성공적으로 읽는 것**은 조용히 실패한다(예: 빌드 산출물 옆의 빈 자리표시자).
 */
export function assertPromptBodyLoaded(): void {
  if (POSTMORTEM_INTERVIEW_PROMPT.trim().length === 0) {
    throw new Error(
      `${POSTMORTEM_INTERVIEW_PROMPT_PATH}가 비어 있다. 프롬프트 본문 없이 부팅하지 않는다(specs/07 §Prompts).`,
    );
  }
}
