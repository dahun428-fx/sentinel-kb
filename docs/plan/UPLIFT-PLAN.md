# 고도화 플랜 — 실사용 전환

| 항목 | 내용 |
|---|---|
| 상태 | 진행 중 (P3 대기 — 사용자 환경 준비) |
| 작성일 | 2026-10-21 |
| 기준 커밋 | `f86db75` (origin/main) |
| 역할 | 2026-10-21 이후 **진행 순서·완료 기준의 기준 문서**. 제품 요구는 `specs/`를 따른다 (`docs/README.md` "어디부터 읽나") |
| 선행 문서 | `docs/EXECUTION-PLAN.md`, `docs/plan/WBS.md` (2026-08-21 착수 계획. 진행 상태 미반영) |

## 개정 이력

| 날짜 | 판 | 내용 |
|---|---|---|
| 2026-10-21 | 1 | 최초 작성. 현황 점검, 우선순위, 결정 기록 |
| 2026-10-21 | 2 | 문서 리뷰(`docs/analysis/DOCUMENTATION-REVIEW-2026-10-21.md`) 반영 (T-047). 외부 전송 경로 정정, 품질 기준 3층 구분, 리뷰 지적 심각도와 진입 규칙, 단계별 선행 조건·완료 증거·중단 조건, P5 앞 적재 도구 단계 추가, 첫 화면 요약 |
| 2026-10-22 | 4 | P0 완료, P1 AI 리뷰 결과(§4-2), P2 처리(T-048~T-052 수정, T-053~T-061 등재). P4·P7·P9 선행 조건에 리뷰 결과 반영 |
| 2026-10-22 | 3 | 재점검(`docs/analysis/DOCUMENTATION-RECHECK-2026-10-21.md`) 반영 (T-047). P3의 Anthropic 키 요구 명시(R1, Q-13), 실사용 승인을 P8과 분리해 사내 확장 판단 조건으로 연결(R2) |

---

## 0. 요약

| 항목 | 내용 |
|---|---|
| 목표 | 본인 프로젝트의 장애를 sentinel-kb에 기록하고, 다음 장애 때 검색해서 다시 쓰는 상태 |
| 현재 단계 | **P0·P1·P2 완료. P3 로컬 실행 대기** |
| 다음 행동 | 사용자: `.env` 작성(키 생성, Q-13), Docker로 `pnpm dev:compose` 기동 → P3 완료 증거 확인. 이어서 Voyage 키 발급(P4) |
| 막힌 결정 | P4 전: Q-1, Q-10 / P5 전: Q-9, Q-11 / T-056 eval 정의 변경 승인 / T-052 F-1 태그 시크릿 처리 |
| 하지 않는 것 | `troubleshooting-harness` 스킬 개선, M7 아티클 확장 (§1-1) |

---

## 1. 목적

sentinel-kb는 M0~M7 태스크 대부분이 구현됐지만 한 번도 운영된 적이 없다. 이 문서는 "코드가 있는 상태"에서 "본인 프로젝트의 장애를 실제로 기록하고 검색해 쓰는 상태"로 가는 순서와 각 단계의 완료 기준을 정한다.

- 1차 사용자: 본인 한 명. 본인이 쓰는 프로젝트들(개인 + 회사 업무)에서 사용한다.
- 2차: 사내 확장. P8 도그푸딩 완료와 실사용 승인(§3-1 승인 기준 충족)을 둘 다 통과한 뒤 판단한다.

### 1-1. 범위 밖

- `work_tools`의 `troubleshooting-harness` 스킬 개선. sentinel-kb 고도화를 우선하기로 했다 (D-1). 하네스를 sentinel-kb 클라이언트로 바꾸는 일은 P8 이후 다시 판단한다.
- M7 아티클·블로그 발행 파이프라인 확장 (Q-7).

---

## 2. 단계별 계획

진행 순서는 D-2에 따라 **GitHub 최신화 → AI 평가·피드백 → 로컬 테스트** 순이다. 각 단계는 `선행 조건 / 완료 증거 / 중단 조건 / 후속`을 갖는다. 중단 조건에 걸리면 다음 단계로 가지 않고 이 문서에 사유를 적는다.

### P0. GitHub 최신화

| 항목 | 내용 |
|---|---|
| 선행 조건 | 없음 |
| 할 일 | 9/15 작업·미머지 브랜치 반영 후 push (완료). F-1 deploy-config 수정, F-5 T-045 반영, T-047 문서 정리 |
| 완료 증거 | `git log origin/main..main` 0줄. `ci` 워크플로의 `verify`·`spec-drift`·`deploy-config` 그린. `git log origin/main --all -- '*-local-command-caveat*'` 0줄 |
| 중단 조건 | 세션 내보내기 파일이 포함된 커밋(`backup/main-before-export-removal`, `feat/T-045-test-flakes`)이 원격에 올라갈 상황이면 즉시 중단 |
| 후속 | 백업 브랜치 삭제 (Q-8) |

### P1. AI 평가·피드백

| 항목 | 내용 |
|---|---|
| 선행 조건 | P0 완료. Q-5(도구), Q-6(범위) 결정 |
| 할 일 | 코드 리뷰 실행. 지적을 §4 심각도로 분류해 §4-2 표에 기록 |
| 완료 증거 | §4-2 표에 모든 지적이 심각도·영역·처리 방침과 함께 기록됨 |
| 중단 조건 | 없음 (기록 단계) |
| 후속 | P2 |

### P2. 평가 결과 반영

| 항목 | 내용 |
|---|---|
| 선행 조건 | P1 완료 |
| 할 일 | §4-1 진입 규칙에 따라 Critical 수정·재검증, Major 수정 또는 수용 기록, Minor 백로그 등재 (`specs/tasks/T-050~`) |
| 완료 증거 | Critical 0건 (수정 커밋 + 재검증 결과 링크). Major는 전부 "수정됨" 또는 "수용: 영향·임시 조치·담당 태스크·재검토 시점" 기재 |
| 중단 조건 | 수정되지 않은 Critical이 있으면 그 Critical이 영향을 주는 단계로 진입 금지 |
| 후속 | P3 |

### P3. 로컬 실행

| 항목 | 내용 |
|---|---|
| 선행 조건 | P2 완료. Docker 데몬 실행. Q-13 결정 |
| 할 일 | `.env` 작성 (`.env.example` 기준). **Voyage 키 없이** `EMBEDDING_PROVIDER=fake`. **`ANTHROPIC_API_KEY`는 필요하다** — `docker-compose.yml:113`이 필수(`:?`)로 요구하고 `packages/core/src/llm/config.ts:60–64`가 빈 값을 거부한다. fake LLM을 env로 켜는 경로는 의도적으로 없다 (`packages/core/src/llm/index.ts:5`, T-039 D-9). `pnpm dev:compose`로 전체 스택 기동 |
| 완료 증거 | 로컬 `pnpm verify`(통합 포함) 그린. `pnpm mcp:ping` 종료 코드 0, 도구 5개. Claude Code에서 `sentinel-kb-local`(stdio)로 도구 목록 확인. **이 증거는 기동·연결만 판정한다.** 더미 키로 기동했다면 생성(`suggest_resolution`, `/v1/answer`)은 검증되지 않은 것으로 본다. 생성 검증은 P6 §3-2에서 실 키로 한다 |
| 중단 조건 | compose 기동 실패, 또는 `mcp:ping` 비정상 종료 |
| 후속 | P4 |

### P4. 실 임베딩 연결

| 항목 | 내용 |
|---|---|
| 선행 조건 | P3 완료. Q-1(실행 위치), Q-10(외부 전송 허용 범위) 결정. Voyage 키 발급. **P3에서 쓴 로컬 DB 볼륨 삭제** — fake 벡터와 Voyage 벡터가 같은 `embeddingVersion`으로 섞이면 검색이 정상 응답 모양으로 실패한다(§4-2 C1, T-053이 코드로 막기 전까지의 절차) |
| 할 일 | ① 연결 스모크: 레코드 1건 저장 → 임베딩 → 검색에서 `vectorRank`·`textRank`가 동시에 non-null인 hit 확인. ② 적재 완료: 시드 50건 재임베딩 |
| 완료 증거 | ① 스모크 결과 1건. ② 다음 값을 기록: 대상 record 수, chunk 수, 전 chunk의 `embeddingVersion`이 기대값과 일치하는 비율(100%), `jobs`에서 `done`이 아닌 것 0(대기·실행 중·실패·dead 모두, §4-2 C2), 검색 인덱스 상태 READY. ③ 시드 레코드 제목 3개로 `/v1/answer`를 불러 `maxVectorScore` 분포를 기록(임계값 0.62 근거, §4-2 U1). ④ GitHub 시크릿 등록 후 `nightly-eval` 스케줄 복구(T-048 F-1) |
| 중단 조건 | 실패 job이 남거나 `embeddingVersion` 혼재. 품질 판정은 여기서 하지 않는다 (P6) |
| 후속 | P5a |

### P5a. 적재 도구

| 항목 | 내용 |
|---|---|
| 선행 조건 | P4 완료. Q-11(적재 방식) 결정 |
| 할 일 | 기존 Markdown 트러블슈팅 문서를 `incident` 레코드로 바꿔 넣는 경로 마련. 현재 저장소에 Markdown importer는 없다. 레코드 스키마는 `symptom`·`resolution`을 10자 이상 필수로 요구한다 (`packages/contracts/src/record.ts:46,48`) |
| 완료 증거 | 부록 A 문서 1건을 dry-run으로 변환한 결과가 `CreateRecordInput` 파싱 통과 |
| 중단 조건 | 변환 결과에 `sanitizeFlags`가 붙는데 원인을 설명할 수 없을 때 |
| 후속 | P5b |

### P5b. 실데이터 적재

| 항목 | 내용 |
|---|---|
| 선행 조건 | P5a 완료. Q-9(severity 기준) 결정. 부록 A 문서별로 Q-10 허용 범위 안인지 확인 |
| 할 일 | 부록 A 문서 적재. 여러 장애가 섞인 문서(부록 A 회사 프로젝트 A의 배포 장애 묶음)는 장애 단위로 나눌지 판단 |
| 완료 증거 | 문서별 적재 결과: recordId, `sanitizeFlags`, 마스킹 내역. 적재 건수 / 대상 건수 |
| 중단 조건 | Q-10 허용 범위 밖 내용이 발견되면 그 문서는 적재하지 않는다 |
| 후속 | P6 |

### P6. 품질 측정

| 항목 | 내용 |
|---|---|
| 선행 조건 | P5b 완료 |
| 할 일 | 실사용에 켤 기능별로 §3 평가를 실행 |
| 완료 증거 | §3-2의 필수 평가 결과가 리포트로 남음. 각 리포트에 데이터 버전(record 수·`embeddingVersion`)과 모델 버전 기재. 임계값 조정용 사례와 최종 확인용 사례를 나눠 기록 |
| 중단 조건 | §3-1 중간 기준 미달 |
| 후속 | P7. 승인 기준 미달이면 P8 판정 전에 재평가 시점을 정한다 |

### P7. 내 프로젝트 연결

| 항목 | 내용 |
|---|---|
| 선행 조건 | P6 중간 기준 통과. T-058(피드백 집계), T-059(입력 오류), T-057(답변 잘림) 처리 — 셋 다 첫 실사용에서 바로 드러난다 (§4-2) |
| 할 일 | 사용하는 프로젝트의 Claude Code에 MCP 등록. 각 CLAUDE.md에 세 규칙 추가: 디버깅 전 `search_knowledge`, 해결 후 `record_knowledge`, 결과가 도움이 됐으면 `give_feedback(helped: true)`. 이벤트 로그(`eval/dogfood-log.jsonl`, `docs/dogfooding.md:69–81` 형식)를 누가 남기는지 정함 |
| 완료 증거 | **계측 스모크**: `search`·`record`·`hit` 이벤트를 한 번씩 발생시키고, 로그 파일과 `tools/dogfood-report.cli.ts` 리포트 양쪽에서 각각 1건으로 집계되는 것을 확인 |
| 중단 조건 | 리포트가 이벤트를 세지 못함 |
| 후속 | P8 |

### P8. 도그푸딩

| 항목 | 내용 |
|---|---|
| 선행 조건 | P7 완료 |
| 할 일 | 4주 사용 (`specs/00` 기준). 2주차에 중간 점검 |
| 완료 증거 | 4주 후 `dogfood-report` 결과. 판정: 신규 실기록 30건 이상, 도움됨 피드백(`give_feedback(helped: true)`) 5건 이상. **P5b 일괄 적재분은 신규 실기록에 넣지 않는다** (Q-12). 이 판정은 **도그푸딩 완료**만 뜻한다. 실사용 승인은 아래 별도 게이트다 |
| 중단 조건 | 2주차 중간 점검에서 기록 0건이면 원인(규칙 미적용, 도구 미호출, 계측 누락)을 먼저 찾는다 |
| 후속 | 실사용 승인, P9 |

#### 실사용 승인 (P8과 별도 게이트)

| 항목 | 내용 |
|---|---|
| 선행 조건 | P8 완료 |
| 완료 증거 | §3-1 **승인 기준**을 모두 충족한 최종 평가 리포트. P8 기간에 쌓인 실기록을 포함한 데이터 버전으로 다시 측정한다. 리포트에 데이터 버전·모델 버전 기재 |
| 중단 조건 | 승인 기준 미달. 이때는 사내 확장을 판단하지 않고, 개인 도그푸딩은 계속한다 |
| 후속 | 사내 확장 판단 |

### P9. 배포 (필요 시)

여러 기기·claude.ai에서 접속할 필요가 생기면 EC2 배포 (`docs/runbook.md`). `deploy`·`infra` 워크플로는 AWS 설정이 없으면 의도적으로 실패한다 (F-2, F-3).
선행 조건: T-061(배포 `.env`의 `$` 값). 사내 확장이면 T-060(인용 위조·명령 블록 방어)과 §4-2 S10(프로젝트별 읽기 권한)도.

### 보류

M7 아티클 파이프라인 (T-029~T-034). 저장 → 검색 → 재사용 흐름과 무관하다. P8 이후 다시 판단한다.

### 2-1. 순서의 이유

- P1(평가)을 P3(로컬 실행)보다 앞에 둔 것은 사용자 결정이다 (D-2). 평가에서 구조적 문제가 나오면 로컬 환경을 꾸리기 전에 고친다.
- P4(실 임베딩)가 P5(실데이터)보다 앞인 이유: 실데이터를 fake embedder로 넣으면 다시 넣어야 한다.
- P5(실데이터)가 P6(측정)보다 앞인 이유: 합성 시드만으로 만든 골든셋은 실제 질의를 대표하지 못한다.
- P9(배포)를 맨 뒤에 둔 이유: 검색이 쓸 만한지 확인되기 전에는 운영 비용(EC2, Atlas)과 관리 부담을 늘리지 않는다.

---

## 3. 품질 기준

### 3-1. 기준 3층

| 지표 | 중간 기준 (P6 → P7 진입) | 승인 기준 (실사용 판정, `specs/00`·SRS NFR-08) | 회귀 기준선 |
|---|---|---|---|
| Recall@5 | ≥ 0.80 (`EXECUTION-PLAN` M2) | ≥ 0.85 | `eval/baselines.json` `retrieval`. 첫 리포트를 보고 사람이 확정 |
| 도구 선택 정확도 | ≥ 0.85 (`EXECUTION-PLAN` M3) | ≥ 0.9 (`specs/05` Eval 3) | `eval/baselines.json`. 사람이 확정 |
| 인용률 (생성 사용 시) | 100% | 100% | — |
| 무관 질의 `found:false` (생성 사용 시) | 5/5 | 5/5 (`specs/05` Eval 2-c) | — |
| 인젝션 방어 (생성 사용 시) | 10/10 | 10/10 (`specs/05` Eval 4) | 현재 9/10 (T-021, 일본어 미탐) |

- 중간 기준을 통과해도 승인 기준 충족을 뜻하지 않는다. Recall@5 0.82는 P7로 갈 수 있지만 실사용 승인은 아니다.
- 승인 기준 미달 상태로 P7에 들어가면, P8 판정 전에 재평가 시점을 이 문서에 적는다.
- 승인 기준은 P8 뒤 **실사용 승인** 게이트에서 최종 판정한다 (§2 P8). 재평가 일정을 적은 것만으로는 승인이 아니다. 사내 확장은 이 게이트를 통과한 뒤에만 판단한다.
- 기준 수치 자체를 바꾸려면 `specs/00` 개정과 인간 승인이 필요하다 (CLAUDE.md 원칙 1).

### 3-2. 기능별 필수 평가

실사용에 켜는 기능만 평가한다. 켜지 않는 기능은 "비활성"과 재평가 조건을 적는다.

| 기능 | 켜는 조건 | 필수 평가 |
|---|---|---|
| 검색 (`search_knowledge`, `get_record`) | 항상 | 승인된 질의·정답 recordId, 데이터·모델 버전, Recall@5·MRR. 임계값 조정용과 최종 확인용 사례 분리 |
| 기록 (`record_knowledge`) | 항상 | 실제 클라이언트에서 저장 → 인제스트 완료 → 검색 → 상세 조회 시나리오 1회 |
| 생성 (`suggest_resolution`, `/v1/answer`) | `ANTHROPIC_API_KEY` 설정 시 | 무관 질의 `found:false`, 인용 검증, 인젝션 회귀 |
| MCP 도구 선택 | MCP 연결 시 | `pnpm eval:tools` (T-016) |
| 피드백 (`give_feedback`) | P7부터 | P7 계측 스모크 |

---

## 4. 리뷰 지적 처리

리뷰 지적의 `Critical / Major / Minor / 개선`은 장애 레코드의 `SEV1~NOTE`와 다른 분류다. 앞의 것은 코드·설계 결함의 심각도이고, 뒤의 것은 기록된 장애 사례의 심각도다.

### 4-1. 심각도 정의와 진입 규칙

| 심각도 | 정의 | 다음 단계 진입 |
|---|---|---|
| Critical | 데이터 손실·기밀 유출·인증 우회, 또는 잘못된 결과를 정상으로 반환 (예: 임계값 척도 오류로 모든 질의가 `found:false`) | 수정·재검증 전에는 **영향을 받는 단계 진입 금지** |
| Major | 스펙 위반·기능 결함. 우회 수단이 있음 | 수정하거나, 영향·임시 조치·담당 태스크·재검토 시점을 적고 수용 여부 결정 |
| Minor | 동작에 영향 없는 결함, 문서·주석 불일치 | 백로그 등재로 완료 가능 |
| 개선 | 결함은 아니고 나아질 수 있는 점 | 백로그 등재로 완료 가능 |

### 4-2. 평가 결과 (P1)

2026-10-22 실행. 도구는 로컬 리뷰 에이전트 3개(검색·적재 경로, API·MCP, 보안)이고 범위는 Q-6 (b) 실사용 경로다.
각 지적은 리뷰가 코드 위치로 확인했고, Critical과 주요 Major는 직접 다시 확인했다(C1, C2, S1, S2, S4, A2).
"미확인"은 실 API 지연처럼 실행 없이 확인할 수 없는 부분이다.

| # | 심각도 | 영역 | 지적 | 영향 단계 | 처리 |
|---|---|---|---|---|---|
| S1 | Critical | sanitizer | 마스킹 규칙 7종뿐. postgres·redis URI, PEM, JWT, `PASSWORD=`, GitHub 토큰 등이 평문 저장·외부 전송 | P4, P5 | **수정** T-051. 27건 마스킹 + 오탐 17건 고정 |
| S2 | Critical | api | 검색어·`suggest_resolution` 에러 원문이 마스킹 없이 Voyage·Anthropic으로. 피드백 query가 `eval_cases`에 평문 | P4, P7 | **수정** T-052 |
| S4 | Critical | 배포(로컬) | 로컬 compose가 nginx를 0.0.0.0에 열고 `.env.example`에 공개된 키 | P3 | **수정** T-050 |
| C1 | Critical | embedder | fake와 Voyage 벡터가 같은 `embeddingVersion`에 섞여 `found:false`가 정상 응답 모양으로 나감 | P4~P6 | **절차로 차단** (P4 선행 조건: DB 볼륨 삭제 + 벡터 점수 확인). 코드 수정 T-053 |
| S5 | Critical(공개 시) | git | 회사 메일이 든 커밋 `109a2ee`가 로컬 브랜치 4개·백업 1개에 남음 | — | **수정** 해당 브랜치·worktree 삭제(2026-10-22). 원본은 저장소 밖 보관 |
| C2 | Major | worker | 죽은 프로세스의 `running` 잡을 회수하지 않음 | P4, P5 | 수용: P4·P5 완료 증거로 확인, 남으면 수동 복구. T-054 |
| C3 | Major | worker | 429에 10초 만에 `dead`. `failed`/`dead` 재투입 경로 없음 | P4~P6 | 수용: 같은 확인. T-054 |
| C4 | Major | api/worker | 제목·상태 변경이 청크에 반영 안 됨. draft로 되돌려도 검색됨 | P5, P8 | 수용: 제목 수정 시 본문도 고쳐 재임베딩. T-055 |
| C5 | Major | eval | Recall@5가 실제로는 Recall@3~5. 실데이터 소수면 자명하게 높음 | P6 | T-056 (eval 정의 변경 — 사람 승인). P6 전 처리 |
| A1 | Major | mcp | `suggest_resolution` 답이 인용 제목에 밀려 수십 자로 잘림 | P7, P8 | T-057. P7 전 처리, 그 전엔 `search_knowledge`+`get_record` |
| A2 | Major | 계측 | `give_feedback`이 도그푸딩 리포트에 집계되지 않음 | P7, P8 | T-058. P7 선행 조건 |
| A3 | Major | mcp/api | 빈 문자열 선택 필드가 엉뚱한 오류로 거부되고 상세가 버려짐 | P7, P8 | T-059. P7 선행 조건 |
| A4 | Major | mcp | `/v1/answer` 재시도가 겹쳐 최악 30초·LLM 6회 (지연 미확인) | P4, P7 | T-057 |
| A5 | Major | api | 없는 recordId 피드백 수용(a). query·note 평문 저장(b) | P6, P8 | (b) **수정** T-052. (a) T-059 |
| S3 | Major | api | `relations[].note`·피드백 note·태그 마스킹 누락 | P5 | note **수정** T-052. 태그는 T-052 F-1 (스펙 결정 필요) |
| S6 | Major | generator | 여는 `<chunk` 태그로 인용 위조 | P7, P9 | T-060. 1인 사용 영향 작음, 사내 확장 전 필수 |
| S7 | Major | generator | 코드 블록은 인용 검사 제외인데 "인용된 기록에만 근거" 머리말 | P7 | T-060 |
| S8 | Major(미확인) | 배포 | 배포 `.env`에서 `$`가 든 값이 보간돼 바뀜 | P9 | T-061 |
| C6 | Minor | worker | 영구 실패에도 `attempts` 증가 | — | T-053 |
| C7 | Minor | db | 인덱스 drift 검사가 차원만 비교 | P3, P4 | 백로그 (T-053에서 함께 검토) |
| A6 | Minor | mcp | 기본 검색마다 불필요한 limit 안내문 | P7 | T-059 |
| S9 | Minor | 문서 | 로컬 atlas-local 안전 기동법 없음 | P3 | T-061. P3 전 runbook 우선 |
| C8 | 개선 | embedder | Voyage `input_type` 미전송 | P4, P6 | T-053. P5 적재 전 |
| C9 | 개선 | 검색 | `lucene.standard`가 한국어 어절을 못 나눔 (T-010 F-6) | P6 | 백로그. P6 결과의 korean-prose 분해를 보고 판단 |
| U1 | 개선(미확인) | generator | 임계값 0.62의 실측 근거 없음 | P4, P6 | P4 완료 증거 ③ |
| A7 | 개선 | mcp | `CORE_API_URL=""` 처리, stdio가 전 키 요구 | P3, P7 | T-059 |
| S10 | 개선 | 권한 | 프로젝트 간 읽기 전면 허용, 웹 UI 단일 계정 | P9 | 사내 확장 전 재검토 |
| S11 | 개선 | CI | `ci.yml` 토큰 권한 미지정 | — | **수정** T-048 |

**P2 판정:** 미수정 Critical은 C1 하나이고 영향 단계는 P4~P6이다. P4 선행 조건의 절차가 그 경로를 막으므로 P3 진입은 허용된다(§4-1).
Major는 전부 수정되거나 담당 태스크·임시 조치·재검토 시점(표의 "P7 전" 등)이 적혀 있다.

---

## 5. 데이터 외부 전송

DB를 로컬(atlas-local)에 두어도 아래 경로로 텍스트가 외부 API에 나간다. 실행 위치(Q-1)만으로 회사 문서의 외부 전송 여부를 판단할 수 없다.

| 경로 | 보내는 것 | 받는 곳 | 근거 | 켜지는 조건 |
|---|---|---|---|---|
| 레코드 임베딩 | sanitizer를 거친 청크 원문 | Voyage (`api.voyageai.com`) | `packages/core/src/embedder/voyage.ts:23,131` | `EMBEDDING_PROVIDER=voyage` |
| 검색 질의 임베딩 | 검색어 원문 | Voyage | `packages/core/src/retriever/retrieve.ts:98,219` | 위와 같음 |
| 답변 생성 | 검색된 청크 + 질의 | Anthropic | `packages/core/src/llm/anthropic.ts:206`, `packages/mcp/src/tools/suggest-resolution.ts` | `ANTHROPIC_API_KEY` 설정 + `suggest_resolution` 또는 `/v1/answer` 호출 |
| eval (judge, tool-selection) | 시나리오·골든셋 질의, 검색 결과 | Anthropic | `eval/*/run.cli.ts` | eval 실행 시 |
| 아티클 생성 (보류) | 레코드 팩트 | Anthropic | T-031 | M7 사용 시 |

```
원문 → sanitizer(로컬) → 청크 → [Voyage] → 벡터 → 로컬 DB
검색어 → [Voyage] → 벡터 → 로컬 DB 검색 → (생성 시) 청크 + 검색어 → [Anthropic] → 답변
```

- sanitizer는 시크릿 패턴을 마스킹한다. 회사 문서의 비공개 내용 전체를 제거한다는 근거는 없다.
- 허용 범위는 Q-10에서 정한다. 개인 자료와 회사 비공개 자료를 나눠 정한다.
- 골든셋·시드 파일은 공개 저장소에 커밋된다. 회사 문서 원문은 넣지 않는다.

---

## 6. 결정 기록

| # | 날짜 | 결정 | 근거 |
|---|---|---|---|
| D-1 | 10-21 | 트러블슈팅 지식 저장소는 sentinel-kb를 고도화한다. `troubleshooting-harness` 개선이나 별도 git 저장소(`troubleshooting-kb`)는 진행하지 않는다 | sentinel-kb가 같은 목표(여러 프로젝트 공유 트러블슈팅 보관소 + MCP)로 이미 대부분 구현돼 있음 |
| D-2 | 10-21 | 진행 순서: GitHub 최신화 → AI 평가·피드백 → 로컬 테스트 | 사용자 결정 |
| D-3 | 10-21 | 평가 방식은 AI 코드 리뷰 | 우선순위 재조정 근거로 쓸 구체적 지적이 필요함 |
| D-7 | 10-22 | Q-2 (a): F-1을 P1 전에 수정 (T-048). Q-3 (a): nightly 스케줄을 P4까지 중지 (T-048). Q-4 (a): T-045를 cherry-pick | 권장안 채택 (사용자 위임 "스스로 판단해서 완료") |
| D-8 | 10-22 | Q-5 (b) 로컬 리뷰 에이전트, Q-6 (b) 실사용 경로 | `/code-review ultra`는 사용자만 실행할 수 있다. 필요하면 P3 전에 추가로 돌린다 |
| D-9 | 10-22 | 검색어 마스킹 기준을 '저장 여부'에서 '외부 전송 여부'로 바꾼다 (T-007 R-2 변경) | §5의 외부 전송 경로. 시크릿을 제3자에 보내는 비용이 검색 결과 차이보다 크다 |
| D-4 | 10-21 | 미머지 브랜치는 main에 직접 머지 후 push (브랜치별 PR 생략) | 셋 다 2차 감사 지적 수정. 1인 작업이라 PR 리뷰 이득이 적음 |
| D-5 | 10-21 | 세션 내보내기 파일은 push 전 기록에서 제거, 원본은 저장소 밖 보관, `.gitignore` 패턴 추가 | 회사 메일 주소 포함. 공개 저장소 기록에 남으면 삭제 불가 |
| D-6 | 10-21 | 문서 리뷰 지적은 T-047로 처리하고, 코드·테스트가 걸린 부분(`goldenSetWarnings` 문구)은 후속 태스크로 분리 | CLAUDE.md "태스크 단위로만 작업", "테스트를 고쳐서 통과시키지 않는다" |

---

## 7. 결정 대기

| # | 필요한 시점 | 질문 | 선택지 | 권장 |
|---|---|---|---|---|
| Q-1 | P4 전 | 1차 실행 위치 | (a) 로컬 맥북: Docker Compose + atlas-local, `sentinel-kb-local`(stdio) (b) 처음부터 EC2 (c) 서버 로컬, 데이터 Atlas 클라우드 | **(a)**. 검색 품질 검증 전에 운영 비용을 늘리지 않는다. **원문 DB는 로컬에 남지만 임베딩 입력·검색어는 Voyage로, 생성 입력은 Anthropic으로 나간다** (§5). Docker가 켜져 있을 때만 쓸 수 있다 |
| Q-2 | 해소 (D-7) | F-1 deploy-config 결함 수정 시점 | (a) P1 전 수정 (b) P2에서 수정 | **(a)**. 원인이 명확한 한 줄 수정 |
| Q-3 | 해소 (D-7) | F-4 nightly-eval 매일 실패 | (a) 자격증명이 생길 때까지 스케줄 비활성화 (b) 자격증명이 없으면 건너뛰고 경고 (c) 그대로 | **(a)**. (b)는 이 저장소의 "가짜 그린 금지" 규약(`deploy.yml` 주석)과 충돌 |
| Q-4 | 해소 (D-7) | F-5 T-045 처리 | (a) `c764f0a`를 main에 cherry-pick, 내보내기 파일 제외, 원 브랜치 삭제 (b) 보류 | **(a)** |
| Q-5 | 해소 (D-8) | 리뷰 도구 | (a) `/code-review ultra` (클라우드 멀티 에이전트, 유료, 사용자가 직접 실행) (b) 로컬 리뷰 에이전트 (`code-reviewer`, `security-auditor`) (c) 둘 다 | 확인 필요 |
| Q-6 | 해소 (D-8) | 리뷰 범위 | (a) 저장소 전체 (b) 실사용 경로: core(sanitizer, retriever, embedder), api, mcp, worker (c) (b) + 배포 설정 | **(b)**. M7은 보류 범위 |
| Q-7 | — | M7 아티클 | (a) 보류 (b) 코드 제거 (c) 병행 | **(a)**. 머지됐고 테스트가 통과하므로 지우지 않는다 |
| Q-8 | 해소 (10-22 삭제) | 백업 브랜치 `backup/main-before-export-removal` | F-5 처리 후 삭제 | 원본 파일은 저장소 밖 보관 중 |
| Q-9 | P5b 전 | severity 기준 (SEV1~NOTE) | — | 등급별 기준을 한 줄씩 정한다 (`DECISIONS-PENDING.md` §5) |
| Q-10 | P4 전 | 외부 API로 보내도 되는 자료 범위 | (a) 개인 프로젝트 자료만 (b) 회사 자료도 허용 (사내 정책 확인 후) (c) 회사 자료는 요약·익명화 후 | **(a)로 시작**. 회사 자료는 사내 정책(외부 AI API 전송)을 확인한 뒤 (b)/(c) 결정 |
| Q-11 | P5a 전 | 적재 방식 | (a) Markdown → `CreateRecordInput` 변환 스크립트 (태스크 신설) (b) Claude Code에서 MCP `record_knowledge`로 한 건씩 (c) `postmortem-interview` 프롬프트로 대화형 기록 | **(b)**. 7건이라 도구를 만들 규모가 아니고, 실제 기록 경로(MCP)를 같이 검증한다 |
| Q-12 | P8 전 | P5b 일괄 적재분을 P8 "신규 실기록 30건"에 포함하나 | (a) 제외 (b) 포함 | **(a)**. 30건은 도그푸딩 기간에 실제로 기록하는 습관을 재는 지표다 |
| Q-13 | P3 전 | P3 로컬 기동에 쓸 `ANTHROPIC_API_KEY` | (a) 더미 값으로 기동하고 생성 검증은 P6로 미룸 (b) 실 키 발급 후 기동 (c) fake LLM 실행 경로를 태스크로 신설 | **(a)**. P3 완료 증거는 기동·MCP 연결뿐이고 `config.ts`는 빈 값만 거부한다. 더미 키로 생성을 부르면 인증 오류로 실패하므로 가짜 성공이 나오지 않는다. (c)는 T-039 D-9가 막아 둔 경로를 여는 일이라 하지 않는다 |

---

## 8. 현황 (2026-10-21 점검)

### 8-1. 확인된 것

| 항목 | 결과 | 확인 방법 |
|---|---|---|
| 타입체크 | 통과 | 로컬 `pnpm typecheck` |
| lint | 통과 | 로컬 `pnpm lint` |
| 단위 테스트 | 139개 파일, 2,590개 통과 | 로컬 `pnpm test` (T-042·T-043·T-046 머지 후) |
| 통합 테스트 (atlas-local) | 통과 | GitHub Actions `ci` → `verify` (run 39543953589). 로컬은 Docker 데몬이 꺼져 있어 미실행 |
| spec-drift 검사 | 통과 | GitHub Actions `ci` → `spec-drift` |
| PR | #11~#44 대부분 머지 또는 통합 PR(#22)로 대체 | `gh pr list` |
| GitHub | 공개 저장소, main 최신화 | 2026-10-21 push (`02899c2..f86db75`) |

### 8-2. 안 된 것

| 항목 | 현재 상태 | 영향 |
|---|---|---|
| 실행 환경 | `.env` 없음. `ANTHROPIC_API_KEY`, `VOYAGE_API_KEY` 비어 있음 | 로컬 실행 불가 |
| 배포 | Terraform state·tfvars 없음. 문서 도메인은 `kb.example.com` 예시 | 원격 접속 불가 |
| MCP 연결 | `~/.claude.json`에 sentinel-kb 미등록 | 어느 프로젝트에서도 사용하지 않음 |
| 실데이터 | `eval/dogfood-log.jsonl` 0줄. 시드 50건은 합성 데이터 | 도그푸딩 미시작 |
| 검색 품질 | T-013 Recall@5, T-016 tool-selection 판정 불가 (실 임베딩 없음) | 검색이 쓸 만한지 모름 |
| 골든셋 | 0건. ID 안정성 문제는 `02899c2`로 해소됨. 남은 선행 조건은 자격증명과 작성 | P6 불가 |
| 임계값 | `SIMILARITY_THRESHOLD=0.62` 실측 근거 없음 | `found` 판정 신뢰 불가 |
| severity 기준 | SEV1~NOTE 판정 기준 없음 | 기록 시 일관성 없음 |
| Markdown importer | 없음 | P5a 필요 |

### 8-3. 태스크 상태

`eval/loop-log.jsonl`의 마지막 엔트리와 각 태스크 파일의 `STATUS:` 줄 기준. 둘 다 없으면 "기록 없음"으로 적었다. 기록 없음은 미완료라는 뜻이 아니다. PR은 대부분 머지됐다.

| M | 태스크 | 상태 |
|---|---|---|
| M0 하네스 | T-000, T-001 | GREEN |
| M1 코어·데이터 | T-002~T-009 | 전부 GREEN |
| M2 검색 | T-010, T-011, T-012 | GREEN |
| | T-013 retrieval eval | **BLOCKED** (실 임베딩 자격증명) |
| | T-036 openapi 서빙 | 기록 없음 (PR #16 머지) |
| M3 MCP | T-014, T-015 | GREEN |
| | T-016 tool-selection eval | **BLOCKED** (자격증명) |
| | T-017 클라이언트 연결 | PARTIAL (배포 서버 없어 Acceptance 1 판정 불가) |
| | T-038 postmortem-interview 프롬프트 | 기록 없음 (PR #25 머지) |
| M4 RAG | T-018 generator | 기록 없음 (PR #23 머지) |
| | T-019 /v1/answer, T-039 LLM provider | done |
| | T-020 인용 검증, T-021 레드팀, T-040 인젝션 탐지 | PARTIAL (T-021: 일본어 미탐 1/10) |
| | T-022 feedback | GREEN |
| M5 도그푸딩·UI | T-023 Web UI, T-024 도그푸딩 | 기록 없음 (PR #19, #29 머지). 도그푸딩 데이터 0건 |
| M6 배포·패키징 | T-025 Terraform, T-026 Compose, T-027 CI/CD | 기록 없음 (PR 머지). 실제 배포 안 함 |
| | T-028 포트폴리오 | PARTIAL (그릴 데이터 0건) |
| | T-042 web 인증, T-046 CI 복구 | GREEN (2026-10-21 main 머지) |
| M7 아티클 | T-029 | PARTIAL |
| | T-030, T-031, T-032, T-035 | 기록 없음 또는 DONE |
| | T-033 아티클 UI | BLOCKED / IN PROGRESS (두 기록이 다름) |
| | T-034 스타일 eval | PARTIAL |
| M7 감사 후속 | T-041, T-043, T-044 | 머지됨 |
| | T-045 간헐 실패 봉합 | PARTIAL (2026-10-22 cherry-pick, F-5 해소. 지목 3지점은 75회 0건, 다른 통합 플레이크 3종은 T-062) |
| 미분류 | T-037 | GREEN |
| | T-047 문서 리뷰 반영 | GREEN (2026-10-22 main) |
| UPLIFT P0~P2 | T-048 CI 더미 env·nightly 중지·권한, T-049 골든셋 경고 문구 | GREEN |
| | T-050 로컬 노출, T-051 마스킹 범위, T-052 검색어·피드백 마스킹 | GREEN (P1 Critical 수정) |
| | T-053~T-061 P1 리뷰 Major | TODO (§4-2) |

자동 완결률(`specs/00` 공식 정의)은 README 지표 표 기준 목표 70% 미달이다. 값은 README 표에서 읽는다.

---

## 9. 작업 기록

### 9-1. 2026-10-21 완료

1. 미머지 브랜치 3개를 main에 머지: T-043 → T-042 → T-046.
   - 충돌: `README.md`(자동 생성 지표 표), `eval/loop-log.jsonl`(양쪽 1줄씩 추가), `specs/tasks/T-042-web-auth.md`(브랜치 쪽이 main 쪽을 포함).
   - 해결: 지표 표는 `pnpm sync:readme`로 재생성, loop-log는 양쪽 줄 모두 유지, 태스크 파일은 브랜치 쪽 채택.
   - 머지마다 lint, typecheck, 단위 테스트 통과 확인.
2. 커밋 `109a2ee`에 실수로 들어간 Claude Code 세션 내보내기 파일(`2026-08-26-164041-local-command-caveat...txt`, 8,520줄, 회사 메일 주소 3회 포함)을 push 전 기록에서 제거.
   - 방법: `git filter-branch --index-filter`로 `origin/main..main` 범위만 재작성.
   - 원본 보관: 저장소 밖 `../sentinel-kb-session-export-20260826.txt`.
   - 재작성 전 main: 로컬 브랜치 `backup/main-before-export-removal` (push 금지).
   - `.gitignore`에 `*-local-command-caveat*.txt` 추가 (`f86db75`).
3. main push (`02899c2..f86db75`, 14커밋).
4. 문서 리뷰 반영 (T-047). 이 문서 2판.
5. 재점검(R1~R3) 반영 (T-047, 2026-10-22). 이 문서 3판. R3은 F-8로 이미 후속 처리 중이라 변경 없음.

### 9-1b. 2026-10-22 완료 (P0 마무리 → P1 → P2)

1. 플랜 부록 A의 회사 프로젝트명·문서 경로를 익명화하고, push 전 커밋 4개를 다시 써서 기록에서도 지웠다. 대응표는 저장소 밖 `../sentinel-kb-private-notes.md`.
2. T-045 cherry-pick. 고병렬 전체 실행 75회 중 4회 실패 — 전부 T-045 처방 밖의 통합 동기화 플레이크라 T-062로 분리 (T-045 결과 절).
3. T-048(F-1 수정, 더미 env를 compose에서 계산해 대조하는 단언, nightly 스케줄 중지, `ci.yml` 권한), T-049(골든셋 경고 문구).
4. P1: 로컬 리뷰 에이전트 3개 실행 → §4-2 표 28건.
5. P2: Critical S1·S2·S4 수정(T-050~T-052), C1은 P4 절차로 차단, S5 브랜치 정리, Major는 T-053~T-061 등재.
6. 각 수정은 뮤테이션(수정을 되돌리면 새 단언이 실패하는지)으로 단언이 실제로 잡는지 확인했다.

### 9-2. push 후 발견

| # | 항목 | 내용 | 판단 |
|---|---|---|---|
| F-1 | `ci` → `deploy-config` 실패 (**해소** T-048) | T-042가 `docker-compose.yml:273`에 `WEB_HTPASSWD_B64`를 필수(`:?`)로 추가했는데 `.github/workflows/ci.yml`의 더미 env(`/tmp/ci.env`)에는 없다 | **결함.** 더미 값 한 줄 추가로 해결 예상. Q-2 |
| F-2 | `infra` → `terraform plan` 실패 | AWS 자격증명 없음 | 의도된 실패 |
| F-3 | `deploy` → `preflight` 실패 | AWS 저장소 변수 없음 | 의도된 실패. 실제 배포는 일어나지 않음 |
| F-4 | `nightly-eval` 매일 실패 (**해소** T-048, P4에서 복구) | `API_KEYS` 시크릿 없음 (exit 78) | 미배포 상태의 결과. 매일 실패 알림. Q-3 |
| F-5 | `feat/T-045-test-flakes` 미머지 (**해소** cherry-pick, 원 브랜치 삭제) | 재작성 전 커밋(`109a2ee`)에서 갈라져 세션 내보내기 파일을 포함. 그대로 머지·push하면 파일이 공개된다 | `c764f0a`만 cherry-pick. Q-4 |
| F-6 | `specs/tasks/T-044-dead-second-defenses.md` 바이너리 인식 | 14행 코드 인용 `join("\u0000")`에 실제 NUL 문자가 들어가 있었음 (오프셋 897) | **해소** (T-047) |
| F-7 | `DECISIONS-PENDING.md` §0, §3 | 해소된 항목이 미해소로 남아 있었음 | **해소** (T-047) |
| F-8 | `eval/retrieval/golden-set.ts` `goldenSetWarnings` (**해소** T-049) | 0건 경고가 해소된 `seedBatch`를 선행 조건으로 출력. 테스트 2개가 그 문구를 단언 | T-047 Findings F-1. 후속 태스크 |

---

## 부록 A. P5 실데이터 후보

| 프로젝트 | 원격 저장소 | 문서 | 줄 수 | Q-10 (a) 기준 |
|---|---|---|---|---|
| 회사 프로젝트 A | 회사 내부 저장소 | 웹 렌더링 장애 1건 | 169 | 보류 |
| | | UI 테스트 장애 1건 (시크릿 키워드 8건, 적재 전 확인) | 112 | 보류 |
| | | 배포 장애 묶음 1건 (여러 장애 묶음, 시크릿 키워드 3건) | 611 | 보류 |
| 회사 프로젝트 B | 회사 내부 저장소 | 모바일 파일 처리 장애 1건 | 132 | 보류 |
| coupang-atoa | 원격 없음 (개인) | `docs/troubleshooting/akamai-bot-block.md` | 105 | 적재 |
| | | `docs/troubleshooting/a2a-sdk-1.1.2-protobuf-drift.md` | 41 | 적재 |
| my-recruit | 개인 GitHub | `docs/troubleshooting/docx-template-render-pipeline.md` | 161 | 적재 |

회사 프로젝트명과 문서 경로는 공개 저장소에 두지 않는다. 실제 대응은 저장소 밖 `../sentinel-kb-private-notes.md`에 있다.

## 부록 B. 관련 경로

| 이름 | 경로 |
|---|---|
| 문서 리뷰 | `docs/analysis/DOCUMENTATION-REVIEW-2026-10-21.md` |
| 리뷰 반영 재점검 | `docs/analysis/DOCUMENTATION-RECHECK-2026-10-21.md` |
| 세션 내보내기 원본 (저장소 밖) | `~/Documents/workspaces9/sentinel-kb-session-export-20260826.txt` |
| 이전 플랜 초안 (D-1로 대체됨) | `~/Documents/workspaces9/troubleshooting-kb/docs/PLAN.md` |
| 트러블슈팅 하네스 스킬 | `~/work_tools/skills/troubleshooting-harness/` |
