# T-045: 부하 하 간헐 실패 봉합 (testTimeout + 벽시계 단언)
refs: specs/05-test-strategy.md
M: M7 | deps: -

## 배경

감사가 전체 스위트를 **고병렬로 41회** 돌렸다. 간헐 실패율 **≈7.3% (3/41)**.
(`pnpm verify` 순차 4회는 4/4 그린 — 부하에서만 난다.)

| 파일 | 실패 | 빈도 | 원인 |
|---|---|---|---|
| `tools/deploy-rollback.int.spec.ts` :: `` `up -d` 가 실패하면 직전 태그로 되돌린다`` | 2회 | 4.9% | `execFileSync`로 실 bash + 스텁 다수 spawn. **3번째 인자에 타임아웃 없음 → vitest 기본 5000ms.** 단독 5회는 0.4s급 전건 그린 |
| `packages/core/src/sanitizer/sanitize.property.spec.ts:753` :: `상한 크기 입력을 … 선형 시간에 처리한다` | 1회 | 2.4% | `expect(best).toBeLessThan(500)` — 관측 **889.7ms**. 워밍업 2회 + 3회 최소값으로 이미 경화됐는데도 넘어간다 |
| `tools/dependency-boundaries.spec.ts` | 0회 | — | 이번엔 안 터졌으나 `specs/tasks/T-030-fact-extractor.md:47-50`에 동일 형태가 기록돼 있다 (ESLint 인스턴스 5개 × 5s 암묵 타임아웃) |

**구조적 원인**: `vitest.config.ts`에 `testTimeout`/`hookTimeout`이 **어느 프로젝트에도 없다.**
실 프로세스를 띄우는 테스트(위 2건 + `*.cli.spec.ts` 8파일 56건의 `node --import tsx` 부팅)가
전부 기본 5초를 쓴다. `eval/style/run.cli.spec.ts:35-40`은 이 위험을 명시적으로 적어 두고
**그 파일에서만** 완화했다 — 선례는 있는데 일반화되지 않았다.

### 이 태스크가 가장 조심해야 할 것

**벽시계 단언이 "잠긴 계약"으로 오인되고 있다.** T-043 배경이 밝혔듯
`DEFAULT_MAX_INPUT_CHARS`의 **유일한 관측 경로가 바로 이 `< 500ms` 단언**이다.
즉 이 레포에서 **가장 불안정한 단언이 레지스트리에서 "행동으로 잠김"의 근거로 쓰이고 있다.**

→ 그러므로 이 단언을 **그냥 느슨하게 만들면 T-043이 세우려는 앵커가 같이 무너진다.**
두 태스크는 같은 지점을 반대편에서 만진다. **경화의 방향은 "임계값을 올린다"가 아니라
"시간이 아닌 것으로 잰다"여야 한다.**

## Scope
- `vitest.config.ts`: 프로젝트별 `testTimeout`/`hookTimeout` 설정.
  실 프로세스를 띄우는 계층(`tools/**`, `*.cli.spec.ts`, `*.int.spec.ts`)에 여유를 준다.
  **유닛 계층까지 무차별로 늘리지 마라** — 무한 대기를 감추게 된다.
- `tools/deploy-rollback.int.spec.ts`: `execFileSync`에 명시적 타임아웃 인자.
- `sanitize.property.spec.ts:753`: 벽시계 의존을 줄인다. 권고 방향 —
  절대 ms 대신 **입력 크기 대비 비율**(예: 2배 입력에 대해 시간이 4배 미만 = 선형성)로 잰다.
  그래야 머신·부하와 무관하고, 재는 대상("선형 시간")과 단언이 일치한다.

## Out of scope
- `tools/assertion-audit.ts` 레지스트리 (T-043 몫 — **같은 파일을 만지지 마라**)
- docker 의존 테스트를 docker 없이 돌게 만드는 일
- 테스트를 skip/삭제해서 플레이크를 없애는 것 — **즉시 중단 사유**

## Acceptance
- [ ] 고병렬(`npx vitest run` 전체 동시) **20회 이상** 반복해 간헐 실패 **0건**.
      실행 횟수와 결과를 리포트에 그대로 적을 것
- [ ] `sanitize.property.spec.ts`의 성능 단언이 **절대 ms에 의존하지 않는다**
- [ ] 그 단언이 여전히 무언가를 잡는다 — masking을 일부러 2차식으로 만들면 죽는다 (뮤테이션으로 확인)
- [ ] `testTimeout`이 유닛 계층에서 무차별로 늘어나지 않았다
- [ ] `pnpm verify` 그린

## Context budget
- 읽기: `vitest.config.ts`, `tools/deploy-rollback.int.spec.ts`,
  `packages/core/src/sanitizer/sanitize.property.spec.ts`,
  `packages/core/src/sanitizer/masking.ts`, `eval/style/run.cli.spec.ts`,
  `tools/dependency-boundaries.spec.ts`, `specs/05`, `package.json`

## Findings (인계)

- **⚠️ 타임아웃을 늘리는 것은 플레이크를 "안 보이게" 만드는 것이지 고치는 게 아니다.**
  `deploy-rollback`은 단독 0.4s인데 5s에 걸린다 — 12배 여유를 CPU 경합이 먹은 것이므로
  타임아웃 조정이 정당하다. 반면 `sanitize.property`는 **단언 자체가 잘못된 것을 재고 있다**.
  둘을 같은 처방으로 다루지 마라.
- **T-043과 동시 진행 중이다.** `assertion-audit.ts`와 `retriever/config.ts`는 그쪽 소유다.
  `DEFAULT_MAX_INPUT_CHARS`의 **행동 앵커를 만드는 것도 T-043 몫**이다 —
  이 태스크는 벽시계 단언을 고치기만 하고, 그 상수의 앵커를 대신 세우려 하지 마라.
  다만 **벽시계 단언을 고치면 T-043이 의존하던 killer가 사라진다**는 사실을
  Findings에 명시해 인계하라.
- `specs/tasks/T-028`의 F-11이 같은 플레이크를 이미 기록했다. 세 번째 관측이다.

## 결과 (2026-10-22, UPLIFT P0)

`c764f0a`를 세션 내보내기 파일이 든 부모(`109a2ee`) 없이 cherry-pick했다. 커밋 메시지가 원인별 처방을 적고 있다
(deploy-rollback은 타임아웃이 아니라 SIGPIPE, sanitize 선형성은 CPU 시간 비, 계층별 타임아웃).

**고병렬 반복** — 로컬 맥북, Docker 켬, `npx vitest run`(unit + integration 동시) 75회:

| 묶음 | 횟수 | 실패 | 실패 내용 |
|---|---|---|---|
| 1 | 20 | 1 | `packages/api/src/records.int.spec.ts` 파일 전체가 `beforeAll`에서 실패(57건 skip). 25초 만에 끝나 120초 타임아웃은 아님. MongoMemoryServer 기동 경합으로 추정 |
| 2 | 15 | 0 | — |
| 3 | 40 | 3 | `retrieve.int.spec.ts` cosine 척도 2건(`maxVectorScore` 0 — 문서가 vector 인덱스에 아직 반영되지 않음), `search-indexes.int.spec.ts` `$vectorSearch`가 다른 문서 반환(같은 원인), `nginx-streaming.int.spec.ts` ECONNRESET |

3번째 묶음 동안 다른 worktree에서 테스트를 같이 돌려 부하가 더 컸다.

**판정: PARTIAL.** 이 태스크가 지목한 세 지점(`deploy-rollback`, `sanitize.property` 선형성, `dependency-boundaries`)은 75회 동안 한 번도
실패하지 않았다. Acceptance 1("간헐 실패 0건")은 **다른 원인의 통합 테스트 플레이크 3종** 때문에 충족하지 못했다. 세 종류 모두
타임아웃·벽시계가 아니라 외부 프로세스 동기화 문제라 이 태스크의 처방(타임아웃·계기 교체)으로 고칠 대상이 아니다 → T-062.

- **F-1** T-043 인계: 벽시계 단언이 사라졌으므로 `DEFAULT_MAX_INPUT_CHARS`의 유일한 killer도 사라졌다(`tools/assertion-audit.ts:328`이 이미 예고).
  상한 초과 입력이 던지는 것을 보는 행동 단언은 T-043 몫이다.

STATUS: PARTIAL — Acceptance 1 미충족(통합 플레이크 3종, T-062). 나머지 Acceptance 충족.
