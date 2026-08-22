# T-006: embedder 추상화 + provider 구현
refs: specs/03-rag-pipeline.md, NFR-06
M: M1 | deps: T-002

## Scope
- `core/src/embedder/index.ts`: `interface Embedder { embed(texts: string[]): Promise<number[][]>; dim: number; version: number }`
- provider 1종 구현 + env 기반 팩토리 (`EMBEDDING_PROVIDER`)
- 배치 최대 32, 429/5xx 지수백오프 재시도 3회
- 테스트용 `FakeEmbedder` (해시 기반 결정론적 벡터) export

## Out of scope
- 워커 통합 (T-008)

## Acceptance
- [ ] 배치 분할 테스트: 100개 입력 → 4회 호출
- [ ] 재시도 테스트: 429 두 번 후 성공
- [ ] 모델명이 코드에 하드코딩되지 않았음(grep 기반 테스트)
- [ ] `pnpm verify` 그린

## Context budget
- 읽기: specs/03, .env.example, packages/core/src/embedder/**

## Findings

### 미결 해소 — T-005 F-1: `chunk.embeddingVersion`의 소스는 **embedder**다
`Embedder.version`(= env `EMBEDDING_VERSION`)이 소스다. `record.embeddingVersion`이 아니다.
근거는 specs/02 마이그레이션 규칙이다: "모델 교체 = EMBEDDING_VERSION 증가 → 전체 재임베딩
(신규 버전 삽입) → 검색 필터 스왑 → 구버전 청크 삭제, **인플레이스 갱신 금지**".
이 절차는 재임베딩 창 동안 **같은 record가 구·신 버전 청크를 동시에 갖는 것**을 전제한다.
청크 버전이 record를 따라가면 신버전 청크를 삽입하는 순간 구버전 청크의 버전도 같이 움직여야 하고,
그러면 구버전 필터로 도는 검색이 깨져 무중단 보장이 성립하지 않는다.
즉 청크의 `embeddingVersion`은 "그 record의 상태"가 아니라 **"그 벡터를 만든 모델 세대"**다.
`packages/core/src/embedder/types.ts`의 `Embedder` 주석에 명시했다.

**G5가 더 강한 근거를 찾았다 — 산문이 아니라 인덱스다.** `specs/02:84`의
`chunks: {recordId, section, seq, embeddingVersion} unique`에서, 청크 버전이 record를 따라간다면
한 record의 모든 청크가 같은 값을 가져 **`embeddingVersion` 성분이 완전한 사문(死文)**이 된다 —
키가 `{recordId, section, seq}`로 축약돼도 동작이 같아진다. 이 성분이 존재하는 유일한 이유는
같은 `(recordId, section, seq)`에 **버전이 다른 두 도큐먼트가 공존**하는 것이고, 그 창이 곧 마이그레이션이다.
보강: `/health`가 `embeddingVersion`을 반환하는 것(specs/04:15)은 배포 단위의 현재 세대라는 뜻이고,
`$vectorSearch(filter{embeddingVersion})`(specs/03:21)은 검색 시점 **상수 필터**라
record 상태를 따라가면 필터 스왑이 원자적일 수 없다.

### 후속 태스크가 알아야 할 것
- **F-1 `record.embeddingVersion`은 "워터마크"로 확정 권고 — G3 불필요 (G5 판정).**
  청크 쪽이 "벡터를 만든 모델 세대"로 확정되면 record 필드에 남는 의미는 하나뿐이다:
  **"이 record가 마지막으로 온전히 임베딩된 세대"**. 파생 필드라 삭제하는 선택지는 성립하지 않는다 —
  record는 임베딩 잡보다 먼저 생성되므로(specs/03 §1-1) "아직 임베딩 안 됨"을 표현할 자리가 필요하고,
  그게 record 밖에 있으면 백필 커서가 사라진다.
  `RecordSchema`의 `embeddingVersion`이 `nonnegative()`라 **`0`을 미임베딩 센티널로 쓸 수 있고**,
  embedder는 `EMBEDDING_VERSION >= 1`을 강제하므로 실제 세대와 충돌하지 않는다 → **contracts 변경 불필요.**
  **T-008 용도:** 재임베딩 백필의 저렴한 재개 커서. `records.find({embeddingVersion: {$lt: N}})`로
  미처리 record를 뽑고, 세대 N 청크가 **전부 커밋된 뒤에만** `embeddingVersion = N`으로 올린다.
  이 필드가 없으면 진행률을 chunks 집계로 유도해야 하는데 `records`에 그럴 인덱스가 없다.
  **워커는 `record.embeddingVersion != chunk.embeddingVersion`을 에러로 취급하면 안 된다** —
  재임베딩 창에서는 정상이다.
- **F-1b (스펙 결함, 인간 판단 필요) `records.embeddingVersion`에 쓰기 주체를 배정한 스펙이 전무하다.**
  전 스펙에서 이 필드의 언급은 specs/02 스키마 정의 한 줄이 전부이고, 나머지 등장은 전부 청크 쪽이거나
  검색 필터다. T-008 Scope도 "record 로드 → chunker → embedder → chunks upsert"까지만 쓴다.
  **현행 스펙대로 구현하면 이 필드는 T-007이 생성 시 한 번 쓰고 영구히 stale하다.**
  T-008 진입 전에 결정돼야 한다.
- **F-2 배치 실패의 부분 성공 처리가 없다.** 100개 중 4번째 배치만 죽으면 `embed()`는 통째로
  던지고 앞 3배치(96개 벡터)는 버려진다. 잡 단위 재시도(specs/03 §1-4)가 있으니 정합성 문제는
  아니지만 **재시도마다 성공분을 다시 임베딩해 비용을 낸다.** T-008이 배치 단위 체크포인트를
  둘지 판단할 것.
- **F-3 provider 엔드포인트 URL은 코드 상수다.** 모델명·차원과 달리 env로 빼지 않았다
  (튜닝 파라미터가 아니라 provider 정체성). provider를 추가할 때 이 판단을 재확인할 것.
- **F-4 `EMBEDDING_DIM`과 Atlas `vec_idx`의 dim이 어긋나는지는 런타임에만 걸린다.** embedder는
  응답 차원이 `EMBEDDING_DIM`과 다르면 던지지만, 인덱스 정의와의 일치는 검증하지 못한다
  (specs/02 인덱스 절). T-010이 인덱스를 만들 때 같은 env를 읽는지 확인할 것.

### 뮤테이션 검증 결과 (직접 실행, 8종 중 7종 사망)
`MAX_EMBEDDING_BATCH_SIZE 32→16` / `DEFAULT_MAX_RETRIES 3→0` / `BACKOFF_FACTOR 2→1` /
`retryable을 status>=400으로` / `응답 index 기반 순서 복원 제거` / `FakeEmbedder 상수 벡터` /
`모델명·차원 리터럴 삽입` 전부 테스트가 죽였다.
**생존 1종: `embed()`의 `if (texts.length === 0) return []` 가드 제거.** 커버리지 공백이 아니라
**동등 뮤턴트**다 — 가드가 없어도 `for (start=0; start<0; ...)`이 한 번도 돌지 않아 HTTP 호출 0회,
반환 `[]`로 관측 가능한 동작이 완전히 같다. 가드는 명시적 문서 역할로 남겼다.

### 검증에서 나온 것 — 수정 완료
- **MK 상호 마스킹 (테스트 내구성 공백).** `parseVectors`의 다섯 검사
  (개수·index 범위·index 중복·차원·슬롯 미충족) 중 **범위·중복·미충족 셋이 서로를 가려주고 있었다.**
  개별로 지우면 다른 검사가 대신 잡아 뮤턴트가 죽지만, **범위와 미충족을 함께 지우면 35개가 전부 통과**했다.
  그때 실제로 벌어지는 일: 입력 3개에 `index`가 `(0,1,5)`로 오면
  **길이 6에 구멍이 `undefined`로 박힌 배열이 에러 없이 반환된다** —
  정확히 "엉뚱한 텍스트에 엉뚱한 벡터가 붙어 조용히 저장되는" 실패 모드다.
  출하 코드는 옳았고 테스트만 없었다.
  → 개별 검사가 아니라 **불변식**을 단언하는 테스트를 추가했다:
  반환 배열은 입력과 길이가 같고 구멍이 없으며 각 슬롯이 올바른 텍스트의 벡터다.
  뮤테이션 확인: 범위+미충족 동시 제거 시 3 failed.
  (중복 index 검사 단독 제거는 여전히 생존하지만 **동등 뮤턴트**다 —
   중복이 생기면 다른 슬롯이 비어 미충족 검사가 같은 `RESPONSE_INVALID`를 던진다.)

### 확인된 것 (결함 없음)
검증자가 순서·정합성 11종을 실험해 **엉뚱한 벡터가 조용히 붙는 경로를 찾지 못했다**:
응답 역순·무작위 순열·index 전부 0·index 누락·개수 31/33·전체 차원 불일치·
**일부 벡터만 차원 불일치**·NaN·index 범위 밖 — 전부 `RESPONSE_INVALID`로 잡힌다.
순서 복원은 배열 순서가 아니라 `index` 기반 슬롯 채우기이고 배치 간에는 순차 이어붙이기다.

### 남은 것
- **F-5 `FakeEmbedder`의 충돌 상한은 32비트 시드가 결정한다.** 벡터가 `fnv1a32(text)` 하나로
  완전히 결정되므로 생일 문제의 지배를 받는다. 실측: 구조적 코퍼스(사례문장 5천, 유사 id 5만,
  한글 음절 1만1천, 이모지 3천, 1글자 차이 1만)에서는 **충돌 0**이지만,
  길이가 제각각인 무작위 텍스트 10만 개에서 **2건**, 30만 개에서 **12건**(이론값 1.16 / 10.48)이 나온다.
  청크 1만 개면 기대 충돌 0.01건, 10만 개면 ~1.2건 — 시드·unit 규모에서는 무해하나
  **"보장된 유일성"은 아니다.** 충돌하면 cosine 1.0 동점이라 검색 순위가 무의미해진다.
  L2 노름은 `[0.999999999999997, 1.000000000000002]`, **0 벡터 0건**(전0이면 축 하나로 폴백).
- **F-6 배치를 순차 호출하는 결정이 테스트로 잠기지 않았다.** `Promise.all` 병렬로 바꿔도
  `Promise.all`이 순서를 보존하므로 정합성엔 무해하고 테스트가 죽지 않는다.
  소스 주석이 "레이트리밋 압력" 때문에 순차라고 밝히지만 그 결정을 지키는 장치가 없다.
- **F-7 실패 정책이 파일 안에서 갈린다.** `EMBEDDING_DIM`·`EMBEDDING_VERSION`은 오설정 시 즉시 던지는데
  `EMBEDDING_BATCH_SIZE`는 `"abc"`·`"0"`을 조용히 32로 폴백한다.
  레이트리밋을 피하려 `EMBEDDING_BATCH_SIZE=eight`로 오타 낸 운영자는 오히려 최대 배치로 얻어맞는다.
- **F-8 (스코프 판단) `EMBEDDING_PROVIDERS`에 `fake`가 배선돼 있다.**
  Scope는 "provider 1종 구현"이고 `FakeEmbedder`는 "테스트용 export"로 규정됐다.
  `.env.example`은 `fake`가 유효값이라는 사실을 문서화하지 않는다.
  운영에서 선택되면 난수 벡터가 **정상 `embeddingVersion`을 달고** 저장돼 마이그레이션 절차로
  구별할 수 없다. 다만 실패가 조용하지 않다 — fake 벡터는 서로 다른 텍스트 간 cosine ≈ 0
  (실측 mean −0.00007, sd 0.031)이라 `SIMILARITY_THRESHOLD=0.62` 게이트가 **항상** `found:false`를 낸다.
  즉시 눈에 띄고 복구는 표준 재임베딩이다. `.env.example` 문서화 또는 프로덕션 가드 권고.
