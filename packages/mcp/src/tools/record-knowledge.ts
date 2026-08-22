/**
 * `record_knowledge` — specs/07 §3. **핵심 루프를 닫는 칸이다**(specs/00 "해결 → record_knowledge").
 *
 * ---
 * ## 쓰기 경로 (T-015 결정 4)
 *
 * `write()`로만 나간다. `read()`는 재시도하는 경로라 `POST /v1/records`를
 * `CoreApiUnsafeReadError`로 **거절**한다 — 타임아웃은 "도달하지 않았다"가 아니라
 * "결과를 모른다"이고, 재전송하면 같은 사건이 레코드 두 벌로 남는다(T-014 D-2).
 * 지식보관소에서 중복 레코드는 조용한 손상이다: 검색 결과가 같은 사건으로 두 번 차고
 * 나중에 어느 쪽이 정본인지 아무도 모른다.
 *
 * ## project (Acceptance 4)
 *
 * **도구 인자에 `project`가 아예 없다.** 있어야 할 이유가 없다 — core-api가 Bearer 키에서
 * 주입하고 바디에 `project`가 오면 400으로 거부한다(specs/04: 조용한 무시는 confused deputy를
 * 만든다). MCP는 호출자의 키를 그대로 패스스루하므로(T-014 D-5) 같은 project로 귀결된다.
 * 응답에 `McpContext.project`를 적어 **주입된 값이 무엇인지 보이게** 한다.
 */
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import {
  CreateRecordInput,
  DivergenceContext,
  DivergenceInput,
  IncidentInput,
  RecordType,
  Severity,
} from "@sentinel/contracts";

import type { McpContext } from "../server.js";
import { errorResult, textResult, toToolError } from "./result.js";
import { parseRecord, readSanitizeWarning } from "./wire.js";

const inputSchema = {
  type: RecordType.describe(
    "incident=장애·버그를 겪고 고친 사례. divergence=AI 에이전트 산출물이 의도와 벌어진 사례. 이 값에 따라 아래 섹션 필드 중 어느 쪽이 필수인지가 갈린다.",
  ),
  title: IncidentInput.shape.title.describe(
    "나중에 검색으로 이 기록을 찾을 사람이 읽을 한 줄. 증상을 구체적으로 쓴다(예: 'nginx가 SSE를 버퍼링해 MCP 세션이 30초에 끊김').",
  ),
  severity: Severity.optional().describe(
    "장애 심각도. 비우면 NOTE. 서비스 영향이 있었을 때만 SEV1–SEV3을 쓴다.",
  ),
  tags: IncidentInput.shape.tags
    .removeDefault()
    .optional()
    .describe("검색 필터용 짧은 키워드(예: nginx, sse, mongodb). 최대 20개."),

  symptom: IncidentInput.shape.symptom.optional().describe(
    "[incident 필수] 무엇이 어떻게 잘못 보였는지. 에러 메시지 원문을 포함하면 다음 사람의 검색에 걸린다.",
  ),
  rootCause: IncidentInput.shape.rootCause.describe(
    "[incident 선택] 실제 원인. 추측이면 추측이라고 쓰고, 모르면 비운다 — 지어내지 마라.",
  ),
  resolution: IncidentInput.shape.resolution
    .optional()
    .describe("[incident 필수] 실제로 해결한 절차. 따라 할 수 있게 명령·설정 값을 그대로 적는다."),
  prevention: IncidentInput.shape.prevention.describe(
    "[incident 선택] 재발을 막기 위해 바꾼 것(테스트, 린트 규칙, 알람 등).",
  ),

  expected: DivergenceInput.shape.expected
    .optional()
    .describe("[divergence 필수] 에이전트에게 기대했던 산출물·동작."),
  actual: DivergenceInput.shape.actual
    .optional()
    .describe("[divergence 필수] 실제로 나온 것. 환각한 API 이름·버전 가정을 그대로 적는다."),
  context: DivergenceContext.optional().describe(
    "[divergence 선택] 재현 조건 `{model, tool, framework}`. 모델·도구가 바뀌면 재발 여부가 갈리므로 아는 만큼 채운다.",
  ),
  correction: DivergenceInput.shape.correction
    .optional()
    .describe("[divergence 필수] 어떻게 바로잡았는지, 그리고 다음 프로젝트에 무엇을 환류할지."),
};

export const RECORD_KNOWLEDGE_DESCRIPTION =
  "새 트러블슈팅 기록을 지식보관소에 저장한다. " +
  "**문제를 해결한 직후에** 부른다 — 해결이 끝났는데 기록하지 않으면 다음 프로젝트가 같은 자리를 다시 판다. " +
  "AI 에이전트 산출물이 의도와 벌어졌을 때도(환각한 API, 잘못된 버전 가정) type='divergence'로 부른다. " +
  "기존 기록을 고치거나 지우는 도구가 아니고, 검색 도구도 아니다(찾기는 search_knowledge). " +
  "project는 인증 키에서 정해지므로 인자로 받지 않는다. " +
  "저장 전에 서버가 시크릿 마스킹·인젝션 검사를 하며, 내용이 바뀌었으면 무엇이 바뀌었는지 응답에 알려준다.";

/** zod 오류를 에이전트가 고칠 수 있는 한 줄로 만든다. 스택이나 원본 값은 싣지 않는다. */
function issueLines(error: { issues: readonly { path: PropertyKey[]; message: string }[] }): string {
  return error.issues
    .map((issue) => `- ${issue.path.map(String).join(".") || "(root)"}: ${issue.message}`)
    .join("\n");
}

export function registerRecordKnowledge(server: McpServer, context: McpContext): void {
  server.registerTool(
    "record_knowledge",
    { title: "트러블슈팅 기록 저장", description: RECORD_KNOWLEDGE_DESCRIPTION, inputSchema },
    async (args) => {
      // 미지정 필드를 **키 자체로 넣지 않는다.** `CreateRecordInput`은 `.strict()`라
      // `symptom: undefined`가 divergence 갈래에서 "미승인 키"로 거부된다.
      const candidate: Record<string, unknown> = {};
      for (const [key, value] of Object.entries(args)) {
        if (value !== undefined) candidate[key] = value;
      }

      const parsed = CreateRecordInput.safeParse(candidate);
      if (!parsed.success) {
        return errorResult(
          `record_knowledge: 인자가 ${args.type} 스키마와 맞지 않는다. 아래를 고쳐서 다시 부른다.`,
          issueLines(parsed.error),
        );
      }

      try {
        // **`write()`다.** 재시도하지 않는다 — 위 주석의 중복 레코드 논거 참조.
        const raw = await context.coreApi.write({
          method: "POST",
          path: "/v1/records",
          // `.strict()`를 통과한 값만 나간다 = `project`가 실릴 자리가 없다.
          body: parsed.data,
        });
        const record = parseRecord(raw);
        const warning = readSanitizeWarning(raw);

        const flags =
          record.sanitizeFlags.length === 0 ? "없음" : record.sanitizeFlags.join(", ");
        const lines = [
          `기록됨. recordId: ${record._id}`,
          `project: ${context.project} (인증 키에서 주입됨 — 인자로 받지 않는다)`,
          `sanitizeFlags: ${flags}`,
        ];
        if (record.project !== context.project) {
          // 일어나면 안 되는 일이다(키 패스스루가 깨졌다는 뜻). 조용히 넘기지 않는다.
          lines.push(
            `⚠ 서버가 저장한 project(${record.project})가 이 세션의 project(${context.project})와 다르다. 운영자에게 알려라.`,
          );
        }
        if (warning !== undefined) {
          // specs/07 §3: "무엇이 마스킹됐는지 알려준다(조용히 삼키지 않음)".
          lines.push(`⚠ 저장 전에 내용이 변경됐다: ${warning.message}`);
          if (warning.masked.length > 0) {
            lines.push(`마스킹된 패턴: ${warning.masked.join(", ")} — 원문 값은 저장되지 않았다.`);
          }
          if (warning.injectionRules.length > 0) {
            lines.push(
              `인젝션 의심 규칙: ${warning.injectionRules.join(", ")} — 이 기록은 검색 목록에 경고와 함께 노출되고 답변 생성 컨텍스트에서는 제외된다.`,
            );
          }
        }
        return textResult(...lines);
      } catch (error: unknown) {
        return toToolError("record_knowledge", error);
      }
    },
  );
}
