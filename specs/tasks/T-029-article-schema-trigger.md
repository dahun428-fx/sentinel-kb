# T-029: 아티클 스키마 + 트리거 판정 배치
refs: specs/08-publishing.md §1–2
M: M7 | deps: T-022, T-024

STATUS: PARTIAL — Scope 3번(`GET /v1/articles`)만 BLOCKED. 1·2번은 구현·검증 완료.

사유: Scope 3번이 specs/04-api.md와 충돌한다. 규칙 경로가 없어 구현자가 고르지 않고 멈춘다.
- 태스크 Scope: "후보 목록 조회 API GET /v1/articles?status=candidate"
- specs/04-api.md 표: 8개 오퍼레이션뿐이고 `/v1/articles`가 없다. specs/08은 §5.3에서
  web의 `/articles` **라우트**만 언급하고 HTTP 계약을 정의하지 않는다.
- CLAUDE.md 금지 사항: "스펙 없는 신규 API·MCP 도구 추가"
- CLAUDE.md 최우선 원칙 1: "코드와 스펙이 어긋나면 코드가 아니라 스펙을 먼저 고친다(인간 승인 필요)"

곁가지가 아니라 실제로 막힌다: `packages/api/src/openapi.ts`의 드리프트 가드가
`pnpm verify`에서 라우트↔오퍼레이션을 양방향 대조하므로, 라우트만 추가하면
`routedButNotDocumented`로 **반드시 실패**한다. 통과시키는 길은 셋뿐이고 모두 막혀 있다:
1. contracts에 9번째 오퍼레이션 등록 → specs/04 표에 근거가 없다(스펙 변경 = 인간 승인)
2. `UNDOCUMENTED_ROUTES` allowlist에 추가 → 그 파일이 명시적으로 금지한 우회
3. `openapi.spec.ts`의 `EXPECTED_OPERATIONS`를 고쳐 통과 → 테스트를 고쳐 통과시키는 것

필요한 결정 (사람):
- `GET /v1/articles`를 specs/04 표에 등재할 것인가? 등재한다면 응답 항목의 형상은?
  (아티클 본문을 목록에 실으면 NFR-03과 같은 문제가 생긴다 — `RecordSummary`처럼
  본문 없는 요약 스키마가 따로 필요하다.)
- 후보 목록은 인증된 `/v1` 표면인가, 아니면 사람만 쓰는 내부 도구인가?

## Scope
- contracts: ArticleSchema, ChartSpecSchema
- worker에 야간 트리거 배치: 4개 유형 조건 판정 → candidate 적재 (중복 방지: 동일 소스 집합 해시)
- 후보 목록 조회 API GET /v1/articles?status=candidate

## Out of scope
- 본문 생성 (T-031)

## Acceptance
- [ ] 시드 데이터에서 패턴(>=3건 클러스터) 후보가 최소 1건 생성됨
- [ ] 같은 소스 집합으로 재실행 시 후보 중복 생성 안 됨
- [ ] 유형별 트리거 조건 유닛 테스트 8케이스
- [ ] `pnpm verify` 그린

## Context budget
- 읽기: specs/08 §1–2, packages/contracts/**, packages/worker/**

## Findings

- **F-1 (T-030): §1 A의 "조회 >= N"은 데이터가 없다.** specs/02의 어느 컬렉션에도 조회
  카운터가 없고 `N` 값도 스펙에 없다. `helped >= 2` 축만 구현했다. 조회 기반 트리거를
  살리려면 조회 계측(어디서? search 응답? MCP `get_record`?)이 선행 스펙이어야 한다.
- **F-2 (T-030/T-031): "유사 클러스터"를 태그 동일성으로 근사했다.** 임베딩 클러스터링은
  Atlas 벡터 검색을 요구해 야간 배치가 로컬·CI에서 검증 불가능해지고, 클러스터 경계가
  실행마다 흔들리면 "동일 소스 집합 해시" 멱등성이 성립하지 않는다. 벡터 클러스터링을
  도입한다면 경계를 결정론적으로 고정하는 방법을 먼저 정해야 한다.
- **F-3 (T-029에서 추가한 판단): 태그 문서빈도 상한.** 시드 50건의 상위 태그가
  `public-postmortem` 20건(40%)·`self-seed` 6건인데 둘 다 출처 라벨이지 실패 양식이 아니다.
  코퍼스의 1/3을 넘는 태그를 패턴 후보에서 제외했다. 이 값(1/3)은 스펙 근거가 아니라
  이 레포의 관측에서 나왔다 — 실데이터가 쌓이면 재검토 대상이다.
- **F-4 (T-031): 배치 CLI는 있으나 스케줄러 배선이 없다.**
  `packages/worker/src/article-batch.cli.ts`를 1회성 실행으로 만들어 뒀지만 cron·compose
  배선은 하지 않았다(T-026 범위). §7의 "야간 배치 리소스 격리"는 그 배선이 되어야 성립한다.
- **F-5 (레포 전반): `integration/m3`의 루트 `package.json`에 병합 충돌 마커가 커밋돼 있었다.**
  유효한 JSON이 아니라 `pnpm install`부터 실패했다. 세 브랜치 eval 스크립트의 합집합으로
  복원했으나(별도 커밋), **integration 브랜치가 이 상태로 머지된 경위**를 확인해야 한다.
  CI가 이걸 잡지 못했다면 게이트에 구멍이 있는 것이다.
- **F-6 (T-031): 이격 리포트의 두 축이 같은 소스 집합을 가리키면 하나로 합쳐진다.**
  `model`·`tool` 축이 정확히 같은 레코드 집합을 낼 때 `_id`가 같아 뒤에 온 쪽이 버려진다.
  같은 재료에 같은 유형의 글이 둘일 이유가 없어 의도한 결과지만, 어느 축의 라벨이
  남는지는 판정 순서(model 먼저)에 달려 있다.
