# T-008: jobs 큐 + 임베딩 워커
refs: specs/03-rag-pipeline.md §1, specs/01 (큐 결정)
M: M1 | deps: T-005, T-006

## Scope
- `jobs` 컬렉션 폴링 워커: `findOneAndUpdate`로 원자적 클레임(status: pending→running)
- record 로드 → chunker → embedder → chunks upsert(유니크 키로 멱등)
- 실패 시 attempts++ / 3회 초과 시 `dead`, record는 그대로 둔다
- graceful shutdown (SIGTERM 시 진행 중 잡 완료 후 종료)

## Out of scope
- 벡터 인덱스 정의 (T-010)

## Acceptance
- [ ] 통합 테스트: job 처리 후 chunks 개수와 섹션이 chunker 출력과 일치
- [ ] 같은 job 2회 처리해도 chunks 중복 생성 안 됨(멱등)
- [ ] 임베더 실패 주입 → attempts 증가, 3회 후 dead
- [ ] 동시 워커 2개 기동 시 같은 job 중복 처리 없음
- [ ] `pnpm verify` 그린

## Context budget
- 읽기: specs/03 §1, packages/worker/**, packages/core/src/{chunker,embedder}/**

## Findings (T-005·T-006에서 미리 넘김)

- **embedder를 부팅 시 1회 생성하라. 잡마다 만들면 안 된다.**
  설정 오류(`API_KEY_MISSING` 등)가 **생성 시점**에 던져지므로, 잡마다 생성하면 오설정이
  **모든 잡을 `attempts++ → dead`로 태워 큐를 조용히 소각한다.** 부팅 시 생성하면 fail-fast가 된다.
- **에러 코드로 재시도 여부를 가른다.** `REQUEST_FAILED`(영구 → 즉시 failed) /
  `RETRY_EXHAUSTED`(일시 → 재큐잉 여지) / 설정 계열(영구). 추가 정보는 필요 없다.
- **`chunk.embeddingVersion`의 소스는 `embedder.version`이다**(T-006에서 확정, 근거는 specs/02:84 유니크 인덱스).
  `record.embeddingVersion`이 아니다. **`record.embeddingVersion != chunk.embeddingVersion`을
  에러로 취급하지 마라** — 재임베딩 창에서는 정상이다.
- **`record.embeddingVersion`은 "마지막으로 온전히 임베딩된 세대" 워터마크로 쓴다.**
  세대 N 청크가 **전부 커밋된 뒤에만** 올려라. contracts가 `0`을 허용하므로 미임베딩 센티널로 쓸 수 있고
  스키마 변경이 필요 없다. **다만 이 필드에 쓰기 주체를 배정한 스펙이 없다(T-006 F-1b) — 먼저 결정할 것.**
- **재청킹 시 고아 청크를 지워야 한다**(T-005 F-2). greedy packing이라 본문이 바뀌면 조각 경계가 밀린다.
  upsert는 같은 키를 덮어써 중복은 안 생기지만, **청크 수가 줄어드는 수정에서는 꼬리 청크가
  구 본문·구 임베딩을 단 채 검색에 계속 잡힌다.** 어느 스펙에도 이 삭제 단계가 없다.
- **배치 부분 성공 처리가 없다**(T-006 F-2). 100개 중 4번째 배치만 죽으면 앞 96개 벡터를 버린다.
  record 1건의 청크 상한이 28이라 실제 비용은 최대 1배치 재실행이지만,
  **전체 재임베딩 백필에서는 같은 코드가 record 단위로 반복되므로** 체크포인트 판단이 필요하다.
