# T-054: 워커 잡 복구 — 멈춘 running, 429, 영구 실패 재투입
refs: docs/plan/UPLIFT-PLAN.md §4-2 (C2 (Major), C3 (Major))
M: M2 | deps: T-008

## 배경

2026-10-22 P1 AI 리뷰(UPLIFT §4-2) 지적. 근거 위치는 리뷰가 코드에서 확인했고, 주요 건은 재확인했다.

- C2: 워커는 `status:"pending"`만 집는다(`packages/worker/src/jobs.ts:64-67`). 처리 중 프로세스가 죽거나(OOM, 20초 유예 후
  SIGKILL, 노트북 절전) `failJob` 자체가 던지면 잡이 `running`으로 영구히 남는다. 그 레코드는 청크가 없어 검색에 나오지 않고,
  시드 드레인도 `running`을 보지 않아 성공으로 끝난다.
- C3: 429 재시도가 프로세스 안 1.4초(200·400·800ms) + 큐 백오프 2·4초라 분 단위 rate limit에서 약 10초 만에 `dead`가 된다
  (`voyage.ts:25-29,107-115`, `jobs.ts:117-122`). 401·403은 영구 실패(`failed`)이고 `failed`/`dead`를 되살리는 경로가 없다.
  키 오타 한 번이면 그동안 들어온 실레코드를 손으로 고쳐야 한다. 기동 시 키는 존재만 확인한다(`voyage.ts:55-61`).

## Scope
- 잡 리스(`claimedAt`/`leaseExpiresAt`) 또는 최소한 워커 부팅 시 오래된 `running`을 `pending`으로 되돌린다.
- `Retry-After` 존중, 지터 백오프 상한 60초 이상, 큐 백오프 기본값을 실 provider에 맞게 설정 가능하게.
- `requeue failed|dead` CLI.
- 기동 시 짧은 임베딩 1회로 키 유효성 확인.

## Acceptance
1. `running`으로 남긴 잡이 다음 기동(또는 리스 만료) 뒤 처리된다.
2. 429를 연속 5회 내는 스텁에서 잡이 `dead`가 되지 않고 끝내 성공한다.
3. `requeue` 후 `failed` 잡이 처리된다.
4. `pnpm verify` 그린.

## Context budget
- 읽기: `packages/worker/src/{jobs.ts,worker.ts,errors.ts,ingest.ts}`, `packages/core/src/embedder/voyage.ts`, `docker-compose.yml`(worker), `specs/02-data-model.md`(jobs), `specs/03-rag-pipeline.md` §1-4

## 처리 메모
- **임시 조치:** UPLIFT P4·P5 완료 증거에 `db.jobs.find({status:{$ne:"done"}})` 0건 확인이 이미 있다. 남으면 손으로 `pending`으로 되돌린다.

STATUS: TODO
