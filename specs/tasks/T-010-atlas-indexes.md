# T-010: Atlas 벡터·텍스트 인덱스 정의 스크립트
refs: specs/02-data-model.md (인덱스), specs/06
M: M2 | deps: T-003

## Scope
- `vec_idx` 정의 JSON (path embedding, cosine, dim from env, filter: meta.type/meta.project/embeddingVersion)
- `text_idx` 정의 JSON (lucene.standard on text)
- Atlas Admin API 또는 `createSearchIndex`로 적용하는 멱등 스크립트 `pnpm db:search-indexes`
- 인덱스 상태 대기(READY까지 폴링) 유틸

## Out of scope
- 검색 로직

## Acceptance
> 판정 주체는 **verifier**다(`task-loop` §3: 구현자가 자기 결과를 판정하지 않는다).
> 아래 체크는 구현자가 먼저 채웠고, verifier가 컨테이너를 실기동해 4항목 전부 독립 재현했다.
> (G5가 절차 위반으로 지적 — 비준 항목 7번.)

- [x] 스크립트 2회 실행 시 에러 없이 동일 상태
      — 3회 실행 `created→existing→existing`, 전부 exit 0. 인덱스 `id`+`latestDefinition` diff 동일(재생성 아님).
- [x] 인덱스 정의가 코드가 아닌 JSON 파일로 관리되고, dim이 env와 불일치하면 실패
      — `EMBEDDING_DIM=8` → `SEARCH_INDEX_DIM_MISMATCH`, exit 78, **기존 인덱스 무변경**을 전후 diff로 확인.
- [x] 통합 테스트: 인덱스 READY 후 간단 $vectorSearch 1건 성공
      — atlas-local에서 **11 tests passed, skipped 0**. `$vectorSearch` 1건, cosine score > 0.9.
- [x] `pnpm verify` 그린 — unit 702→714, integration 112. 기존 테스트·eval 파일 수정 0건.

## Context budget
- 읽기: specs/02, packages/core/src/db/**, **packages/core/src/embedder/config.ts**

> **정정(인간 사후 비준 대상):** 원문 Context budget에는 `packages/core/src/embedder/**`가 없었다.
> 그런데 **같은 파일의 Findings(T-006 인계분)가 "dim만 읽는 경로를 따로 두거나 config를 쪼갤 것"을
> 지시한다** — 즉 이 태스크 스펙은 스스로 모순이었다. 구현자는 `config.ts`를 수정했고
> `task-loop` "중단 사유: Context budget 밖 파일이 반드시 필요할 때"에 해당했으나 멈추지 않았다.
> G5 판정은 "변경 자체는 정당(스펙이 지시), 절차는 위반". 위 한 줄은 그 모순을 해소하는 최소 수정이다.

## Findings (T-006에서 미리 넘김)

- **`readEmbedderConfig`를 재사용하려면 마찰이 있다.** Acceptance 2("dim이 env와 불일치하면 실패")를
  위해 `EMBEDDING_DIM` 하나만 필요한데, 이 함수는 `EMBEDDING_PROVIDER`·`EMBEDDING_VERSION`까지
  유효해야 통과한다. **인덱스 스크립트가 임베딩 자격증명 없이 도는 환경이면 걸린다.**
  dim만 읽는 경로를 따로 두거나 config를 쪼갤 것.
- **`vec_idx`의 dim과 `EMBEDDING_DIM` 불일치는 지금 런타임에만 잡힌다**(T-006 F-4).
  embedder는 응답 차원이 env와 다르면 던지지만 인덱스 정의와의 일치는 검증하지 못한다.
  이 태스크가 그 대조를 맡는 유일한 지점이다.

## Findings (T-010 구현 중)

- **F-1. `readEmbedderConfig` 재사용 대신 `readEmbeddingDim`으로 쪼갰다** (T-006 F-4 해소).
  `embedder/config.ts`에 `readEmbeddingDim(env)`를 export하고 `readEmbedderConfig`가 그것을
  내부에서 호출하도록 바꿨다. 파싱 규칙·에러 코드(`EMBEDDER_DIM_INVALID`)는 하나로 유지되면서
  인덱스 스크립트는 `EMBEDDING_PROVIDER`·`EMBEDDING_VERSION` 없이 돈다.
  실측 확인: 그 둘 없이 `pnpm db:search-indexes` 정상 종료.
  (embedder에 **새 파일**을 만들지 않은 이유: `no-hardcoded-model.spec.ts`가 embedder 디렉터리의
   파일 목록을 리터럴로 단언한다. 새 파일은 그 테스트를 깨뜨린다.)

- **F-2. atlas-local은 검색 인덱스 중복 생성을 조용히 삼킨다.** 실 Atlas의 `createSearchIndex`는
  같은 이름이 있으면 `IndexAlreadyExists`로 죽지만 컨테이너는 그냥 성공한다.
  **재현 절차**: atlas-local 컨테이너에 `createSearchIndex({name:"vec_idx", ...})`를 연달아 2회 호출한다.
  검증자 실측 결과 `1st: vec_idx / 2nd: ACCEPTED -> vec_idx / index count now: 1` — 에러 없음.
  (실 Atlas 쪽 `IndexAlreadyExists` 동작은 **문서 근거이며 이 레포에서 실측된 바 없다.**
   자격증명이 생기는 시점에 확인할 것.)
  즉 **멱등 가드를 지워도 컨테이너 통합 테스트만으로는 못 잡는다.** `search-indexes.spec.ts`가
  드라이버 스텁으로 "이미 있으면 `createSearchIndex`를 부르지 않는다"를 직접 잠근다.
  T-011 이후 이 종류의 "실 Atlas에서만 나는 에러"를 더 만나면 같은 패턴을 쓸 것.

- **F-3. atlas-local은 mongod와 mongot 두 프로세스이고, mongod가 먼저 뜬다.** `ping`이 통해도
  검색은 `Error connecting to localhost:27027 ... Connection refused`로 죽는다.
  통합 테스트는 (1) 컨테이너 healthcheck가 `healthy`가 될 때까지, (2) 없는 인덱스를 향한
  `$search`가 연결 에러 없이 답할 때까지 두 단계로 기다린다. 이 게이트가 없으면 간헐 실패한다.
  **T-011·T-012가 같은 컨테이너를 쓸 때 이 부팅 게이트를 재사용해야 한다** — 지금은
  `search-indexes.int.spec.ts` 안에 있다. 두 번째 사용처가 생기면 공용 헬퍼로 뽑을 것(스펙 필요).

- **F-4. CI에서 컨테이너를 쓸 수 있으나 이미지가 ~1.95GB다.** GitHub Actions ubuntu 러너에는
  Docker가 있어 `mongodb/mongodb-atlas-local`을 그대로 쓸 수 있지만 첫 실행에서 pull에 수 분이
  걸린다. 캐싱 전략(`docker save`/`actions/cache` 또는 러너 이미지 프리풀)은 **T-026(CI/CD) 몫**으로
  넘긴다. 지금 통합 테스트의 부팅 타임아웃은 pull까지 감안해 600초다.

- **F-5. 컨테이너를 못 쓰면 skip하되 조용하지 않게 했다.** `describe.skipIf` + stderr 배너.
  "docker가 없으니 그린"은 가짜 그린이므로 통과 처리하지 않는다.
  **검증자 실측(공격 A)이 심각도를 올렸다**: docker를 실패 스텁으로 가린 채 `pnpm verify`를 돌리면
  `Tests 101 passed | 11 skipped`에 **종료 코드 0**이다. 배너는 stderr로 나가지만
  **CI 브랜치 보호가 읽는 것은 종료 코드**다. 즉 배너는 게이트가 아니다 —
  Docker 없는 러너에서 Acceptance 3을 이루는 11개 테스트가 통째로 사라지면서 게이트는 그린이 된다.
  → **T-026(CI/CD)이 반드시 처리할 것**: `REQUIRE_DOCKER=1` 류 스위치로 CI에서 skip을 하드 실패로 승격.
  (현 GitHub Actions ubuntu 러너에는 Docker가 항상 있어 **당장의 실害는 없다** — 그래서 T-010을
   반려하지 않는다. 그러나 러너·실행 환경이 바뀌는 순간 조용히 열린다.)

- **F-6. `lucene.standard`는 한국어 형태소 분석을 하지 않는다.** "스트리밍이"는 한 토큰이라
  질의 "스트리밍"으로는 매칭되지 않는다. 영문·식별자(`nginx`, `proxy_buffering`)는 잘 걸린다.
  **재현 절차**: atlas-local에 `text_idx`(lucene.standard) 생성 후 본문 "스트리밍이 끊긴다"인 문서를
  넣고 `$search({text:{query:"스트리밍", path:"text"}})` → 0건, `query:"스트리밍이"` → 1건.
  **이 주장은 구현자 실측이며 아티팩트가 남지 않았다** — 위 절차로 재확인한 뒤 스펙 결정에 쓸 것.
  **T-011의 텍스트 검색 recall과 T-013 eval 골든셋에 직접 영향**을 준다. 분석기 교체
  (`lucene.cjk` 또는 nori)는 specs/02 §인덱스 수정이 선행되어야 하므로 여기서 손대지 않았다.

- **F-7. 정의 드리프트는 dim만 검사한다 — ⚠️ T-011 선결 조건으로 승격.**
  이미 존재하는 인덱스의 `similarity`나 filter 목록이 JSON과 달라져도 `existing`으로 통과한다
  (Acceptance가 dim만 요구). **검증자가 폭발 반경을 실측했고, "미검사"라는 표현은 이를 과소평가한다:**

  `similarity:"euclidean"` + filter 1개(`meta.type`)뿐인 `vec_idx`를 먼저 만들고 CLI(=cosine·filter 3개)를
  실행하면 `existing` / `2개 검색 인덱스 READY` / **exit 0**을 보고한다. 그 직후 실제 쿼리는:
  ```
  OK   meta.type (declared)                        : 1 hit, score=1
  FAIL meta.project (specs/02 필수, 라이브 인덱스에 없음) : Path 'meta.project' needs to be indexed as filter
  FAIL embeddingVersion (specs/02 필수, 없음)          : Path 'embeddingVersion' needs to be indexed as filter
  ```
  즉 **부트스트랩이 성공을 보고한 직후 스펙 필수 필터 3개 중 2개가 런타임 쿼리 실패를 낸다.**
  또 `similarity`가 euclidean이면 점수 척도가 cosine의 0–1이 아니게 되어
  **specs/03 §4의 `SIMILARITY_THRESHOLD` 게이트가 조용히 오작동한다** — T-011·T-013이 직접 밟는 지뢰다.
  → T-011은 이 상태를 전제하지 말고, **검색 경로가 의존하는 인덱스 정의가 라이브와 일치하는지**
    먼저 확인할 수단을 갖거나, 아래 비준 5번(드리프트 정책)의 답을 받고 시작할 것.

- **F-9. dim 해석의 일치는 구조적 규율일 뿐 테스트가 없었다 (검증자 C3 생존 뮤테이션).**
  F-1은 "두 경로가 같은 파서를 공유하니 갈릴 수 없다"고 주장했고 그 주장은 참이었다. 그러나
  `readEmbeddingDim`의 위임을 끊어 인덱스 경로만 관대한 `parseInt`로 바꿔도
  **lint·typecheck·unit 702개가 전부 통과했다.** `EMBEDDING_DIM="1536abc"`가
  인덱스는 1536으로 만들고 embedder는 설정 오류로 거부하는 — 즉 **차원 대조 자체가 무의미해지는**
  상태가 아무 경고 없이 성립한다. 이것은 T-006 F-4가 T-010에 넘긴 문제의 핵심이다.
  → **해소함.** `search-indexes.spec.ts`에 오형식 dim 6종(`"1536abc"`, `"1.5"`, `"0"`, `"-8"`, `"abc"`, `" "`)에
    대해 (a) 인덱스 경로가 거부하는가 (b) 두 경로가 **같은 판정**을 내리는가를 잠그는 테스트를 추가했다.
    C3 뮤테이션 재적용 시 **13개 실패**로 사망함을 확인했다(추가 전 0개).

- **F-10. 2단계 부팅 게이트 중 실제로 일하는 것은 1단계다 (검증자 공격 F).**
  게이트 2개 모두 제거 → 4/4 실행 전부 `Connection refused` 실패(F-3 재현됨).
  그러나 **2단계(mongot probe)만 제거 → 6/6 실행 안정 통과**. 이 머신(이미지 warm, 로컬 SSD)에서
  일하는 것은 컨테이너 healthcheck다. 2단계는 느린 CI 러너에 대한 값싼 보험으로 남기되,
  **F-3이 T-011·T-012에 넘긴 "공용 헬퍼 추출" 권고는 유효하다.**

- **F-8. `.claude/skills/mongo-vector-ops`의 "로컬 테스트 제약" 절이 낡았다.**
  "벡터·텍스트 검색이 필요한 통합 테스트 → Atlas 테스트 클러스터"라고 적혀 있지만
  specs/05는 이미 atlas-local 컨테이너로 정정됐다. 스킬 파일 수정은 이 태스크 범위 밖이라
  건드리지 않았다 — **별도 태스크로 동기화 필요.**

## 인간 비준 대기 (G5 산출, T-010이 새로 올린 것)

1. **Context budget 정정 사후 비준** — 위 `## Context budget`의 정정 문단. 태스크 스펙의
   자기모순(Findings는 config 분할을 지시, budget은 embedder 배제)을 해소한 최소 수정이다.
2. **`SEARCH_INDEX_READY_TIMEOUT_MS` / `SEARCH_INDEX_POLL_INTERVAL_MS`의 스펙 근거 확정.**
   현재는 `specs/03 §6`(RAG 튜닝 파라미터) 유추 적용뿐이다. `specs/06`은 배포 시 SSM→.env 렌더
   대상을 정하므로 실질적 배포 계약이다 — 거기 또는 `specs/02 §인덱스`에 등재할지 결정.
   (선례: `EMBED_JOB_MAX_ATTEMPTS`·`EMBED_POLL_INTERVAL_MS`가 T-008에서 같은 논리로 들어갔다.)
3. **`specs/06`에 인덱스 부트스트랩 단계 신설.** 현재 specs/06에는 "인덱스"라는 단어가 없다.
   `db:search-indexes`는 기본 300초까지 블로킹하고 Atlas·atlas-local에서만 도므로
   **compose up 이전인지 이후인지가 첫 검색 성공 여부를 가른다.** 지금 이 절차는 코드 주석에만 있었고,
   그 주석은 "없는 계약을 발명한 것"이라 이번에 제거했다.
4. **⚠️ `specs/02 §인덱스`의 `lucene.standard` 재검토 (F-6) — T-011 착수 전 필요.**
   한국어 형태소 분석 부재가 사실이면 `specs/05` Eval 1의 `Recall@5 >= 0.8` 기준선이 직접 타격을 받는다.
   결정: `lucene.standard` 유지 / `lucene.cjk` / nori 전환.
5. **⚠️ 정의 드리프트 정책 (F-7) — T-011 선결.** `similarity`·filter 목록 변경을 `updateSearchIndex`로
   반영할지, 마이그레이션 절차로만 다룰지. 현재는 조용히 통과하고 그 결과가 런타임 쿼리 실패다.
6. **`.claude/skills/mongo-vector-ops/SKILL.md` 동기화 (F-8).** specs/05의 atlas-local 정정과 충돌.
7. **Acceptance 체크박스 판정 주체** — `task-loop` §3("구현자가 자기 결과를 판정하지 않는다")과
   실제 운영의 괴리. 구현자 self-check를 허용하되 verifier 재현을 필수로 둘지 명문화.
