# T-033: 아티클 UI (블로그 렌더 + 편집·발행)
refs: specs/08-publishing.md §5.3, §7
M: M7 | deps: T-031, T-023

STATUS: BLOCKED

사유: 이 화면이 읽고 쓸 HTTP 표면이 없고, 만들 수 있는 경로가 전부 막혀 있다.
T-029가 `GET /v1/articles`에서 멈춘 벽과 **같은 벽**이며, 여기서는 쓰기 경로까지 겹친다.

## 왜 스텁으로 우회하지 않았는가 (T-023 선례가 적용되지 않는 이유)

T-023의 스텁은 **specs/04 표에 있고 packages/api에 실재하는** 엔드포인트를 E2E에서 대신한 것이다.
여기서 스텁을 쓰면 스펙에 없는 오퍼레이션 4개를 web 안에서 **새로 발명**하게 된다:
- 계약 형상(특히 목록 항목이 `body`를 싣는지)을 `packages/web`에 정의 → "계약은 contracts가
  단일 소스" 위반. contracts 수정은 G3(인간 승인)이고 이 태스크의 수정 범위 밖이다.
- CLAUDE.md 금지 사항 "스펙 없는 신규 API 추가"에 그대로 해당한다. 코드가 api가 아니라 web에
  있다는 사실은 이 판정을 바꾸지 않는다 — 발명되는 것은 HTTP 계약이다.

**결정적인 이유는 Acceptance 3이다.** "candidate는 공개 목록에 노출되지 않는다"는 서버가
`published`만 내보낼 때 성립한다. 서버 엔드포인트가 없으면 web이 전량을 쥐고 거르는 수밖에 없는데,
그것이 바로 이 Acceptance가 금지하는 배치다. 즉 지금 UI를 만들면 **가장 중요한 Acceptance를
위반하는 형태로만** 만들어진다. 스텁 위에서 통과하는 필터 테스트는 스텁 자신을 재는 것이라
T-031 F-7이 지적한 자기충족적 단언과 같은 부류다.

## 실측 (주장이 아니라 관측)

현재 HEAD에서 `documentedOperations(buildOpenApiDocument())` = **8개**, `/v1/articles` 없음.
필요한 라우트 4개가 섰다고 가정하고 `diffOperations`를 돌린 결과:

```
routedButNotDocumented: [
  "GET /v1/articles", "GET /v1/articles/{slug}",
  "PATCH /v1/articles/{id}", "POST /v1/articles/{id}/publish"
]
```

이 가드는 `pnpm verify` 안에서 돈다. 통과시키는 길 셋이 모두 막힌 것은 T-029 기록 그대로이며
현재 HEAD에서 재확인했다:
1. contracts에 9번째 오퍼레이션 등록 → `packages/contracts/src/openapi.spec.ts:44`
   "specs/04 표에 없는 오퍼레이션은 등록하지 않는다"가 실패한다(`toHaveLength(8)`).
   그 테스트를 고치는 것은 **즉시 중단 사유**다.
2. `UNDOCUMENTED_ROUTES` allowlist 추가 → `packages/api/src/openapi.ts:101` 이 명시적으로 금지한 우회.
3. 기대값 편집 → 테스트를 고쳐 통과시키는 것.

## 쓰기 경로는 아예 없다 (T-031 F-5 재확인)

`draftArticle`은 `ArticleDraftPatch`를 반환할 뿐이고, core는 DB 쓰기를 갖지 않으며
worker(`packages/worker/src/articles.ts`)를 import할 수도 없다(의존 방향).
`packages/api/src` 전체에 `articles` 문자열이 **0건**이다.
따라서 "본문 수정", "발행 버튼", "editHistory 기록"이 호출할 대상이 존재하지 않는다.
지시대로 만들지 않고 보고한다.

## 필요한 결정 (사람)

- **D-a: `/v1/articles` 읽기 표면을 specs/04 표에 등재하는가?** 등재한다면 목록 항목의 형상은?
  본문을 실으면 NFR-03과 같은 문제가 생긴다 — `RecordSummary`처럼 본문 없는 요약이 따로 필요하다.
  `status` 필터를 **서버 기본값**으로 못박을 것인가(공개 목록은 `published`만)? Acceptance 3이
  검증 가능해지려면 이 기본값이 계약에 있어야 한다.
- **D-b: 편집·발행 쓰기 표면은 누구의 것인가?** 인증된 `/v1` 표면인가, 사람만 쓰는 내부 도구인가.
  §0-5·§7이 "발행은 사람"이라고 못박았으므로 이 엔드포인트의 인가 모델이 전자동 발행 금지의
  마지막 집행 지점이 된다. `PATCH /v1/articles/{id}`(본문+editHistory)와 발행을 한 오퍼레이션으로
  합칠지 나눌지도 함께 정해야 한다.
- **D-c: mermaid 렌더가 `dangerouslySetInnerHTML` 금지와 충돌한다.** mermaid는 SVG 문자열을
  돌려주고 그 SVG는 `foreignObject`로 HTML을 품을 수 있다. 아티클 본문은 **모델이 쓴 Markdown**이며
  T-031 F-1이 "한국어·영어 인젝션은 초안 프롬프트까지 들어온다"고 명시했으므로 신뢰할 수 없는 입력이다.
  `client-safety.spec.ts:144`의 금지를 ref+DOM 삽입으로 우회하는 것은 문자열만 피하고 위험은 그대로라
  택하지 않았다. 필요한 결정: SVG 허용목록 기반 서버 렌더인가, mermaid 생략인가, 금지의 예외인가.

## Scope
- web /articles: 발행물 목록·상세 (Markdown + mermaid + 차트 렌더)
- draft 편집 화면: 본문 수정, 발행 버튼 (발행은 사람만)
- 편집 diff 요약을 editHistory에 기록
- 단일 HTML 내보내기

## Acceptance
- [ ] E2E: draft 편집 → 발행 → 목록 노출
- [ ] 차트 3종(bar/line/heatmap)과 mermaid가 렌더됨
- [ ] candidate 상태 아티클은 공개 목록에 노출되지 않음
- [ ] `pnpm verify` 그린

## Context budget
- 읽기: specs/08 §5.3, packages/web/**
