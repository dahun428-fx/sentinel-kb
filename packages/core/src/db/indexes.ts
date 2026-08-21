/**
 * 일반(B-tree) 인덱스 부트스트랩. 출처: specs/02-data-model.md §인덱스,
 * docs/design/DB-DESIGN.md §3.
 *
 * **Atlas Search/Vector 인덱스(`vec_idx`, `text_idx`)는 여기서 만들지 않는다 — T-010의 몫이다.**
 * 그 둘은 `createSearchIndex` 경로이고 로컬/메모리 서버에서는 생성 자체가 불가능하다.
 *
 * 멱등성: `createIndex`는 같은 이름·같은 스펙이면 no-op이라 몇 번 돌려도 안전하다.
 * 다만 같은 이름에 **다른 키**면 `IndexKeySpecsConflict`, 같은 키에 **다른 이름·옵션**이면
 * `IndexOptionsConflict`가 난다(실 mongod 7.0에서 확인). 즉 이름을 명시해도 옵션 변경은 여전히 깨진다 —
 * 인덱스 정의를 바꾸려면 drop 후 재생성하는 마이그레이션 경로가 따로 필요하다. (T-003 F-9)
 * 그래서 이름을 전부 명시한다 — 드라이버 자동 생성 이름에 기대면 스펙을 바꿨을 때
 * 어떤 인덱스가 충돌했는지 추적할 수 없다.
 */
import type { Db } from "mongodb";

export interface DbIndexSpec {
  readonly collection: string;
  /** 명시적 인덱스 이름. 자동 생성 이름에 의존하지 않는다. */
  readonly name: string;
  readonly key: Readonly<Record<string, 1 | -1>>;
  readonly unique: boolean;
}

/**
 * 생성 대상. 두 인덱스 카탈로그(specs/02 §인덱스, DB-DESIGN §3)에 실재하는 것만 담는다.
 *
 * `feedbacks`는 의도적으로 비어 있다 — T-003 Scope 산문은 언급하지만 두 카탈로그 어디에도
 * 없다. 근거 없는 인덱스는 쓰기 비용만 늘리므로 스펙이 정해질 때까지 만들지 않는다. (Findings)
 */
export const DB_INDEX_SPECS: readonly DbIndexSpec[] = [
  // records: 목록 조회 (project 경계 + 종류 필터 + 최신순)
  {
    collection: "records",
    name: "records_project_type_createdAt",
    key: { project: 1, type: 1, createdAt: -1 },
    unique: false,
  },
  // records: 태그 필터 (multikey)
  {
    collection: "records",
    name: "records_tags",
    key: { tags: 1 },
    unique: false,
  },
  // jobs: 워커 폴링 — 오래된 pending부터 집어간다
  {
    collection: "jobs",
    name: "jobs_status_createdAt",
    key: { status: 1, createdAt: 1 },
    unique: false,
  },
  /**
   * chunks: 인제스트 멱등성 보장 (DB-DESIGN §3, specs/03 §1-3).
   * Atlas 전용이 아닌 평범한 unique 복합 인덱스라 여기서 만든다.
   * T-008의 멱등 upsert가 이 인덱스의 유일성에 의존한다 — 없으면 재시도 한 번에
   * 같은 청크가 중복 삽입되어 검색 결과가 한 레코드로 도배된다.
   */
  {
    collection: "chunks",
    name: "chunks_recordId_section_seq_embeddingVersion",
    key: { recordId: 1, section: 1, seq: 1, embeddingVersion: 1 },
    unique: true,
  },
];

/**
 * 모든 일반 인덱스를 생성한다. 멱등 — 2회 이상 실행해도 에러 없이 같은 결과를 낸다.
 * @returns 생성(또는 이미 존재)된 인덱스 이름 배열. `DB_INDEX_SPECS` 순서와 같다.
 */
export async function ensureIndexes(db: Db): Promise<string[]> {
  const created: string[] = [];
  for (const spec of DB_INDEX_SPECS) {
    // key를 그대로 넘기면 readonly 타입이 드라이버 시그니처와 안 맞는다 — 얕은 복사.
    const name = await db
      .collection(spec.collection)
      .createIndex({ ...spec.key }, { name: spec.name, unique: spec.unique });
    created.push(name);
  }
  return created;
}
