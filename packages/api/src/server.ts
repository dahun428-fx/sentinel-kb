/**
 * 컴포지션 루트. env를 읽는 **유일한** 지점이다.
 *
 * 오설정은 첫 요청이 아니라 **부팅에서** 드러나야 한다(T-006 인계 패턴). `API_KEYS`가 비었거나
 * 형식이 깨졌으면 `parseApiKeys`가 여기서 던지고 프로세스가 죽는다 — 빈 맵으로 부팅해
 * 모든 요청을 401로 돌려주는 서버는 원인을 어디에도 남기지 않는다.
 */
import {
  createChatModel,
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
   * **`/v1/answer`가 프로덕션에서 뜬다 — T-019 F-8이 남긴 간극을 여기서 닫는다.**
   *
   * T-019는 실 provider가 없어 이 값을 만들지 못했고, 임의의 스텁을 넘겨 라우트를 띄우지
   * 않기로 했다. 그 판단은 옳았다: "모델이 없다"가 `found:false`("유사 사례 없음")로 둔갑하면
   * 거짓말이고, 그건 NFR-02가 막으려는 것이다. 그 대가로 **드리프트 가드는 초록인데
   * 프로덕션엔 라우트가 없는** 상태가 남았다(T-019 F-8). T-039가 provider를 붙여 그것을 닫았다.
   *
   * **설정이 없으면 부팅이 죽는다** — 위 `createEmbedder()`와 같은 규약이고, 그렇게 정한
   * 근거는 셋이다(T-039 D-4):
   *  (1) 같은 파일에 이미 선례가 있다. 오설정이 라우트 404가 아니라 부팅 실패로 드러나는 것이
   *      T-006 인계 패턴이고 MCP stdio CLI도 같다(T-014).
   *  (2) 명시적 503을 택하면 요청이 인증·검증·**검색**을 다 지나 생성 직전에 죽는다.
   *      임베딩 호출과 Atlas 왕복이 이미 나간 뒤다 — 오설정 1건이 요청마다 돈을 쓴다.
   *  (3) 부팅 거부는 `compose up -d`가 즉시 실패해 롤백이 자동이다(specs/06). 503은
   *      헬스체크가 초록인 채로 뜨고 `/v1/answer`만 죽는다 — F-8의 재현이다.
   *
   * `createApp`의 `chatModel?`이 여전히 **선택** 의존인 것은 모순이 아니다. 시드 스크립트와
   * records 통합 테스트처럼 모델 없이 앱을 만드는 정당한 소비자가 있기 때문이고(`app.ts`의
   * `retriever` 주석과 같은 근거), 운영에서 조용히 빠질 위험은 **이 줄**이 닫는다.
   */
  const app = createApp({
    db,
    apiKeys,
    sanitizeOptions,
    retriever,
    chatModel: createChatModel(),
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
