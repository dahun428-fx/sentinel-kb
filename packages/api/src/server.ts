/**
 * 컴포지션 루트. env를 읽는 **유일한** 지점이다.
 *
 * 오설정은 첫 요청이 아니라 **부팅에서** 드러나야 한다(T-006 인계 패턴). `API_KEYS`가 비었거나
 * 형식이 깨졌으면 `parseApiKeys`가 여기서 던지고 프로세스가 죽는다 — 빈 맵으로 부팅해
 * 모든 요청을 401로 돌려주는 서버는 원인을 어디에도 남기지 않는다.
 */
import {
  createEmbedder,
  createRetriever,
  parseApiKeys,
  readSanitizeOptions,
  VERSION,
} from "@sentinel/core";
import { closeDb, getDb } from "@sentinel/core/db";

import { createApp } from "./app.js";

/** `.env.example`의 `CORE_API_PORT`. 스펙에 있는 값이라 코드에 기본값을 박지 않고 여기서만 폴백한다. */
const DEFAULT_PORT = 3001;

function readPort(raw: string | undefined): number {
  const parsed = Number(raw?.trim());
  return Number.isSafeInteger(parsed) && parsed > 0 ? parsed : DEFAULT_PORT;
}

/**
 * `/health`가 보고할 임베딩 세대. `readEmbedderConfig()`를 부르지 않는 이유는
 * 그쪽이 `EMBEDDING_DIM`·`EMBEDDING_PROVIDER`까지 요구하며 던지기 때문이다 —
 * API는 임베딩을 하지 않으므로 그 설정이 없다고 헬스체크가 죽으면 안 된다.
 * 값이 없으면 0(미설정)으로 보고한다. `HealthResponse`가 `nonnegative()`라 계약을 만족한다.
 */
function readEmbeddingVersion(env: NodeJS.ProcessEnv): number {
  const parsed = Number(env["EMBEDDING_VERSION"]?.trim());
  return Number.isSafeInteger(parsed) && parsed >= 0 ? parsed : 0;
}

export async function start(): Promise<void> {
  const apiKeys = parseApiKeys(process.env["API_KEYS"]);
  const sanitizeOptions = readSanitizeOptions();
  const db = await getDb();

  /**
   * **검색은 임베딩을 필요로 한다** — `/v1/search`가 질의를 벡터로 바꿔야 하기 때문이다.
   * 그래서 `createEmbedder()`가 여기서 불리고, `EMBEDDING_*` 설정이 없으면 **부팅이 죽는다.**
   * 위 `readEmbeddingVersion`이 헬스체크를 위해 관대하게 읽는 것과 대비되는데, 그쪽은
   * "값을 보고만 한다"이고 이쪽은 "없으면 라우트가 동작하지 않는다"라 판단이 갈린다.
   * 늦게 죽으면 첫 검색 요청이 500을 받고 원인은 로그 한 줄로만 남는다(T-006 인계 패턴).
   */
  const retriever = createRetriever({ db, embedder: createEmbedder() });

  /*
   * **`chatModel`을 아직 넘기지 못한다 — 그래서 `/v1/answer`는 프로덕션에서 뜨지 않는다.**
   *
   * `packages/core/src/llm/`에는 `ChatModel` 인터페이스와 fake만 있고 실 provider가 없다
   * (T-018 D-2). T-019가 그걸 채우지 않은 이유는 셋이다:
   *  (1) 실 provider는 `packages/core/src/llm/`에 있어야 하는데(CLAUDE.md: LLM 호출은 그
   *      디렉터리 경유만 허용) 그건 T-019의 Context budget(`packages/api/**`·`packages/mcp/**`)
   *      **밖**이다. budget 밖 파일을 고치는 것은 태스크 루프의 중단 사유다.
   *  (2) `@anthropic-ai/sdk`는 새 의존성이고 lockfile 변경은 인간 승인 사항이다(T-018 F-1).
   *  (3) T-019 Acceptance 어디에도 실제 모델 호출이 필요하지 않다 — specs/05가 unit·integration은
   *      fixture 목, 실 호출은 eval 계층으로 갈라 두었다.
   *
   * 여기서 임의의 스텁을 넘겨 라우트를 띄우지 **않는다**. 그러면 근거가 있는데도 지어낸 답이
   * 나가거나, "모델이 없다"가 `found:false`("유사 사례 없음")로 둔갑한다 — 둘 다 NFR-02가
   * 막으려는 것이고 후자는 거짓말이다. 라우트가 없으면 404가 나가고 원인이 분명하다.
   *
   * provider가 붙는 태스크가 할 일: `createChatModel()`을 core에 만들고(모델 ID는 env에서 —
   * `embeddingVersion`과 같은 규약으로 **하드코딩 금지**) 아래 `createApp`에 `chatModel`을
   * 한 줄 더하면 된다. 그때 `retriever`처럼 **설정이 없으면 부팅이 죽는** 쪽으로 둘 것.
   */
  const app = createApp({
    db,
    apiKeys,
    sanitizeOptions,
    retriever,
    embeddingVersion: readEmbeddingVersion(process.env),
    version: VERSION,
    logger: true,
  });

  const shutdown = async (): Promise<void> => {
    await app.close();
    await closeDb();
  };
  process.once("SIGTERM", () => void shutdown());
  process.once("SIGINT", () => void shutdown());

  await app.listen({ port: readPort(process.env["CORE_API_PORT"]), host: "0.0.0.0" });
}

// `tsx src/server.ts`로 직접 실행될 때만 뜬다. import만으로는 포트를 잡지 않는다.
if (process.argv[1]?.endsWith("server.ts") === true) {
  start().catch((error: unknown) => {
    // Error 객체를 통째로 찍으면 스택·부가 프로퍼티가 로그 수집기로 흘러간다.
    // `packages/mcp`의 두 CLI가 같은 이유로 message만 찍는다(T-014).
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  });
}
