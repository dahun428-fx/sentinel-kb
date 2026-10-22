/**
 * 테스트용 MongoMemoryServer 기동 (T-062).
 *
 * 고병렬 실행에서 `Port "50232" already in use`로 파일 전체가 `beforeAll`에서 죽었다(T-045 결과 절, 실측 로그).
 * mongodb-memory-server가 빈 포트를 고른 뒤 mongod가 바인드하기 전에 다른 테스트 프로세스가 같은 포트를 잡는 경합이다.
 * **포트 충돌일 때만** 새 포트로 다시 띄운다. 다른 기동 실패는 그대로 던진다 — 재시도로 진짜 문제를 덮지 않는다.
 */
import { MongoMemoryServer } from "mongodb-memory-server";

const MAX_ATTEMPTS = 5;

export async function startMemoryServer(): Promise<MongoMemoryServer> {
  for (let attempt = 1; ; attempt += 1) {
    try {
      return await MongoMemoryServer.create();
    } catch (error) {
      const portTaken = error instanceof Error && /already in use/i.test(error.message);
      if (!portTaken || attempt >= MAX_ATTEMPTS) throw error;
    }
  }
}
