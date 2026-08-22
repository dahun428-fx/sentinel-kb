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

## Findings

### 스펙 수정 (인간 사후 비준 대상)
- **S-1 `specs/03` §1-4 상태 기계 정정.** 원문 "실패 시 job은 `failed`+attempts++, 3회 초과면 `dead`"에는
  **`failed`를 되살리는 주체가 없어** attempts가 1을 넘지 못하고 "3회 초과면 dead"가 **도달 불가능한
  죽은 조항**이 된다(T-003 F-4가 "T-008에서 결정"으로 넘긴 구멍).
  → 일시 실패 → `pending`+attempts++(재큐잉 주체는 워커 자신), `attempts >= 상한` → `dead`,
  영구 실패 → `failed`(attempts를 태우지 않음)로 정정했다.
  **G5가 대안도 제시했다** — 클레임 필터를 `{status: {$in: ["pending","failed"]}}`로 두면 원문 문면을
  지키면서 같은 결과를 얻는다. 위 안을 택한 이유는 `failed`를 "재시도가 무의미한 영구 실패"로 쓰면
  **설정 오류가 큐를 통째로 소각하는 사고**를 막고(T-006 인계) 운영 진단에 더 유용하기 때문이다.
- **S-2 "3회 초과"(`>3`) vs T-008 Acceptance "3회 후"(`>=3`) 문면 충돌.** 구현은 Acceptance를 따라
  `>=`를 택했고 specs/03 문면도 그에 맞췄다.
- **S-3 `specs/02` records `embeddingVersion` 주석.** T-006 F-1b가 올린 "쓰기 주체 미배정" 결함을 메웠다.
  **초안이 "쓰기 주체는 워커뿐"이었는데 G5가 T-007과의 충돌을 잡았다** — 이 필드는 `RecordSchema`에서
  필수라 T-007이 생성 시 반드시 `0`을 쓴다. "생성 시 `0` 초기화는 T-007, 이후 상승은 워커 전담"으로 고쳤고,
  **T-007의 PATCH가 이 필드를 보존해야 한다는 금지**도 함께 넣었다(전체 치환하면 워터마크가 0으로 되돌아간다).
- **S-4 `specs/03` §1-4에 백오프 조항 추가.** 아래 결함 참조.

### 검증이 잡은 실질 결함 3건 — 수정 완료
- **백오프 부재 (G5 발견).** 실패 즉시 `pending`으로 돌아가고 그 잡이 `createdAt` 최선두라 곧바로 다시
  집혔다. **10초짜리 Mongo 순단이나 임베딩 429가 밀리초 안에 attempts를 전부 태워 `dead`로 보낸다** —
  재시도의 존재 이유가 달성되지 않았다. 통합 테스트가 `runOnce()`를 연달아 3회 불러 dead를 확인하고
  있었는데, **그 테스트가 결함을 문서화하고 있었던 셈이다.**
  → 클레임 필터에 `$expr`로 `updatedAt + backoff(attempts) <= now` 조건을 넣었다.
  **구현자가 "지수 백오프는 contracts 재개방이 필요하다"고 한 것은 틀렸다**(G5 정정) —
  `JobSchema`에 이미 `attempts`와 `updatedAt`이 있어 새 필드 없이 된다.
  테스트도 시계를 직접 미는 방식으로 바꿔 백오프가 실제로 걸리는지 단언한다.
- **V13 워터마크가 `$set`이라 역행한다.** 재임베딩 창에서 구·신 세대 워커가 병존하면
  **낮은 세대 워커가 워터마크를 되돌린다** — 실측으로 세대 5까지 올라간 record가 세대 1 워커 처리 후 1이 됐다.
  그러면 백필 커서(`{embeddingVersion: {$lt: N}}`)가 이미 끝난 record를 무한히 다시 집는다.
  → `$max`로 단조 증가를 강제. 재임베딩 창을 재현하는 회귀 테스트 2개 추가.
- **V23 클레임 후 이탈 시 `running` 좀비.** 코드는 옳았지만(루프 최상단에서만 종료 플래그를 본다)
  **그 성질을 고정하는 테스트가 없어 뮤턴트가 살아남았다.** 기존 shutdown 테스트는
  "진행 중 잡이 끝났다"만 봐서 클레임 직후 이탈 경로를 잡지 못한다.
  → 종료 후 `running` 잡이 0인지 세는 단언을 추가했다. 상태 자체를 세는 것이 유일한 방어다.

뮤테이션 잠금 확인: 백오프 조건 제거 1 failed, V13 `$max`→`$set` 1 failed, V23 클레임 후 이탈 1 failed.

### 검증에서 확인된 것 (결함 없음)
- **동시성 테스트가 진짜다.** 워커 4개·잡 50개로 규모를 키우고 클레임을 비원자적으로 바꾼 뮤턴트에서
  **중복 처리가 23~36건 관측**됐다(정상 구현은 0, 워커 1개 대조군도 0). 측정 아티팩트가 아니다.
  다만 랑데부 게이트는 첫 라운드만 겹치게 하는 보험이지 경쟁의 유일한 원천이 아니다 —
  게이트 없이도 36건이 나온다.
- **데이터 정합성 4종 전부 의도대로**: 고아 삭제, 다른 세대 청크 보호, 워터마크 순서(청크 커밋 후),
  부분 실패 복구. **"임베딩됐다고 주장하지만 청크가 없는 record"는 만들 수 없다.**
- CI에서 `MONGODB_URI=""`·미설정 양쪽 통과(메모리 서버 직접 기동).

### 남은 것
- **F-1 `running` 좀비 회수 주체가 없다.** graceful shutdown은 SIGTERM 정상 경로만 덮는다.
  SIGKILL·OOM·컨테이너 강제 종료에는 방어가 없다. **G5 정정**: `{status:"running",
  updatedAt < now - leaseMs}` 재클레임으로 **근사 가능**하다 — contracts 재개방 없이도 된다.
  다만 소유자 식별이 없어 정밀도가 떨어지고 `updatedAt`이 리스 하트비트를 겸하게 된다.
  제대로 된 리스(`claimedBy`·`leaseExpiresAt`)를 원하면 `JobSchema`가 `.strict()`라 G3다.
- **F-2 `failed`도 `dead`도 되살리는 주체가 없다.** 회수는 백필 도구의 몫인데 그 도구가 아직 없다.
  `records.find({embeddingVersion: {$lt: N}})`가 커서가 된다.
- **F-3 0청크 record가 무증상으로 검색에서 사라진다.** 공백만 든 본문(`" ".repeat(10)`은
  `IncidentInput`의 `min(10)`을 통과한다)이면 청크 0개가 나오는데, 그때 **세대 스코프가 비워지고
  워터마크는 그대로 상승하며 로그는 `done chunks=0`을 정상처럼 찍는다.**
  결과는 "임베딩 완료로 표시됐지만 검색에 절대 안 걸리는 record"이고 백필 커서가 영원히 건너뛴다.
  데이터 손상은 아니나 **자기 복구가 불가능한 상태**다. `chunkCount === 0`을 이상 신호로 볼지 판단 필요.
- **F-4 `packages/worker`가 `mongodb`·`@sentinel/contracts`에 직접 의존한다.**
  전자는 `ObjectId`·`Db` 타입, 후자는 스키마 재정의 금지(CLAUDE.md) 때문이다. 의존 방향 위반은 아니다
  (둘 다 리프이고 core 배럴은 contracts를 re-export하지 않는다).
  **record/chunk 리포지토리를 `@sentinel/core/db`로 승격할지는 T-007이 같은 매핑을 다시 쓰는 시점에
  판단하는 게 맞다** — 소비자가 둘이 되는 시점이 추상화의 올바른 시점이다.
- **F-5 `specs/03` §1-1의 job 형상이 불완전하다.** `{type:"embed", recordId}` 약칭만 보고 T-007이
  job을 삽입하면 **`claimNextJob`이 영원히 집지 못한다**(`status`·`attempts`·`createdAt`·`updatedAt` 부재).
  실제 계약은 specs/02 jobs 블록의 `JobSchema` 전체다.
- **F-6 기본값 이중화 세 번째 사례.** `3`이 `config.ts`와 `.env.example` 두 곳에 있다.
  T-003 F-8·T-005 F-4와 같은 축이다. 세 번 반복됐으면 관례로 굳은 것이니 드리프트 방지 장치를 세울 시점이다.
- **F-7 실패 정책이 레포 전체에서 갈린다.** `readPositiveInt`가 `"abc"`·`"0"`을 조용히 폴백한다.
  T-006 F-7이 `EMBEDDING_BATCH_SIZE`에 대해 지적한 것과 같은 패턴이다.
- **F-8 `pnpm dev` 동작 변화.** worker의 `dev`가 placeholder에서 실제 워커 기동으로 바뀌었다.
  env 없이 루트 `pnpm dev`를 돌리면 워커만 exit 78로 죽는다 — 의도한 fail-fast지만 로컬 흐름 변화다.
- **F-9 `specs/` 문서가 prettier 포맷과 맞지 않는다.** `pnpm format`을 돌리면 무관한 공백 diff가 섞인다.
  `.prettierignore`에 `specs/`를 넣거나 일괄 포맷하는 별도 태스크가 필요하다.
- **T-005 F-3(레코드 1건이 28청크 → 후보 20슬롯 점유)은 이 워커가 해소하지 않았고 해소할 위치도 아니다.**
  T-011로 그대로 넘어간다.
