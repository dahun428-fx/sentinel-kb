# T-033: 아티클 UI (블로그 렌더 + 편집·발행)
refs: specs/08-publishing.md §5.3, §7
M: M7 | deps: T-031, T-023

STATUS: IN PROGRESS (BLOCKED 해소 — 재시도)

## BLOCKED 해소 기록 (재시도 세션이 실측으로 확인한 것)

아래 D-a·D-b가 **해소됐다.** D-c는 **해소되지 않았고**, 이 태스크는 그 공백을 메우지 않고
안전한 쪽을 택한 뒤 사람의 결정 대상으로 남긴다.

| 결정 | 상태 | 근거 (이 세션이 직접 읽은 것) |
|---|---|---|
| D-a 읽기 표면 | **해소** | `specs/04-api.md` 표에 `GET /v1/articles`·`GET /v1/articles/:id` 등재. 목록 행에 "**본문 없는 요약**", "**기본은 `published`만**"이 문면으로 박혔다. `packages/contracts`에 `ArticleSummary`(본문·facts·charts·editHistory 없음, `.strict()`)와 `ListArticlesQuery`(`status: ArticleStatus.default("published")`)가 **순수 추가**됐다. |
| D-b 쓰기 표면 | **해소** | 표에 `PATCH /v1/articles/:id`(편집은 `candidate`·`draft`에서만)와 `POST /v1/articles/:id/publish`(`publishedAt`은 서버가 찍고 클라이언트가 보내면 400)가 등재. 인가 모델은 표 아래 블록쿼트 3번이 "인증된 `/v1` 표면"으로 못박았다. `packages/api/src/articles.ts`에 라우트 4개가 실재한다. |
| D-c mermaid 렌더 | **미해소** | specs/04 정정은 **HTTP 표면만** 다뤘다. 블록쿼트의 세 결정 근거 어디에도 mermaid·`dangerouslySetInnerHTML`·SVG 허용목록에 대한 판정이 없다. specs/08 §5.3은 여전히 "Markdown 렌더 + mermaid + 차트 컴포넌트" 한 줄뿐이다. |

**드리프트 가드**: `documentedOperations(buildOpenApiDocument())` = **12개**, `diffOperations`의
`routedButNotDocumented`·`documentedButNotRouted` 모두 빈 배열. BLOCKED 사유가 지목한
세 갈래 우회(계약 등록 실패 / allowlist / 기대값 편집)는 **하나도 쓰지 않았다** — 스펙이 먼저 고쳐졌다.

## D-c에 대한 이 태스크의 판단: mermaid를 렌더하지 않는다

`mermaid.render()`는 **SVG 문자열**을 돌려준다. 그 문자열을 DOM에 넣는 길은
`dangerouslySetInnerHTML`과 `ref + innerHTML/DOMParser + appendChild` 둘뿐이고, 후자는
`client-safety.spec.ts:144`의 grep만 피할 뿐 **위험은 한 톨도 줄지 않는다.** 테스트를 통과시키는
것이 목적이 되는 순간 그 테스트는 아무것도 지키지 않게 되므로 택하지 않았다.
근거와 대안 평가는 아래 `## Findings` F-2에 적는다. mermaid 블록은 **원문 코드 블록**으로
(React 텍스트 노드) 다이어그램 종류 라벨과 함께 노출한다 — §5.2가 "깨진 다이어그램이 실리는 것보다
없는 편이 낫다"고 한 것과 같은 방향의 판단이다.

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
- [x] E2E: draft 편집 → 발행 → 목록 노출 — `packages/web/e2e/article-path.spec.ts`, 12/12 통과
- [~] 차트 3종(bar/line/heatmap)과 mermaid가 렌더됨 — **차트 4종은 렌더된다**(timeline 포함).
      **mermaid는 의도적으로 렌더하지 않는다**(위 D-c 판단, F-2). 절반은 미충족이며 숨기지 않는다.
- [x] candidate 상태 아티클은 공개 목록에 노출되지 않음 — 필터는 서버에 있고, 웹은 `status`를
      만들 수단 자체가 없다(`publicArticlesPath`). 뮤턴트 M1·M1b가 죽는다.
- [x] `pnpm verify` 그린 — lint·typecheck·unit(137파일 2493테스트)·integration(20파일 377) 전부 통과

## Findings

- **F-1 (해소된 BLOCKED의 교훈): 스펙을 먼저 고치는 것이 유일한 경로였고, 실제로 통했다.**
  T-029·T-031·T-032·T-033 넷이 같은 벽에서 멈췄고, 벽은 코드가 아니라 specs/04 표였다.
  라우트만 세우는 우회는 T-036 드리프트 가드가 막았고 그것이 옳았다 — 우회했다면 계약과
  구현이 갈라진 채 M7이 끝났을 것이다.

- **F-2 (mermaid): 렌더하지 않기로 했다. 근거는 셋이다.**
  1. `mermaid.render()`는 SVG **문자열**을 낸다. 그 문자열을 DOM에 넣는 길은
     `dangerouslySetInnerHTML`과 `ref + innerHTML/DOMParser` 둘뿐이고, 후자는
     `client-safety.spec.ts`의 grep만 피할 뿐 위험이 동일하다. 테스트를 통과시키는 것이
     목적이 되는 순간 그 테스트는 아무것도 지키지 않는다.
  2. mermaid의 방어는 `securityLevel`·`htmlLabels` 설정에 얹혀 있는데, 그 값은
     **다이어그램 소스 안의 `%%{init: …}%%` 디렉티브로 덮어쓸 수 있다.** 본문이 신뢰
     불가 입력인 상황(T-031 F-1)에서 방어의 스위치가 입력 안에 있는 것은 방어가 아니다.
  3. "SVG 허용목록 → React 엘리먼트 변환"은 이론상 안전하지만(문자열을 거치지 않으므로)
     그러려면 `mermaid`를 `packages/web`의 의존으로 들여야 한다. core는 그 패키지를
     **파싱 전용**으로만 쓰고(80MB대, d3·cytoscape·katex 동반) 배럴에서 정적 import조차
     피했다(`publisher/mermaid.ts`). 스펙에 없는 무거운 의존을 UI에 들이는 결정은
     이 태스크가 혼자 내릴 것이 아니다.
  **결정적으로, specs/04 정정은 D-a·D-b만 해소했고 D-c는 판정하지 않았다.** 스펙이 침묵하는
  곳에서는 좁고 안전한 쪽을 고른다 — 목록 기본값을 `published`로 둔 것과 같은 원리다.
  현재 동작: mermaid 블록은 다이어그램 종류 라벨과 함께 **원문 코드 블록**으로 노출된다.
  **사람의 결정이 필요하다**: (a) SVG 허용목록 서버 렌더를 T-0xx로 신설, (b) mermaid 영구 생략
  (그렇다면 specs/08 §5.3의 "mermaid"를 지워야 한다), (c) 금지의 명시적 예외.

- **F-3: `pnpm verify`가 컴포넌트 렌더 회귀를 못 막는다는 T-023 F-5를 실측으로 재현했다.**
  뮤턴트 둘이 lint·typecheck·unit을 **전부 통과**하고 E2E에서만 죽었다:
  `ArticleCharts`가 heatmap을 조용히 버리는 변경, 편집 게이트를 `true`로 고정하는 변경.
  E2E는 머지 게이트가 아니므로 사실상 막는 것이 없었다. 이 태스크에서 둘 다 닫았다 —
  전자는 `components/article-render.spec.ts`(실제 렌더 마크업을 본다), 후자는
  `articles-safety.spec.ts`의 **호출 형태까지 보는** 소스 가드. 재실행으로 사망을 확인했다.

- **F-4: `vitest.config.ts`의 unit 프로젝트에 `esbuild.jsx: "automatic"`을 켰다.**
  `packages/web`이 `jsx: "preserve"`(Next가 변환)라 esbuild가 classic 변환을 내고
  `React is not defined`로 죽었다. 앱 코드에 쓰이지 않는 `import React`를 넣는 대신
  테스트 변환 설정을 고쳤다. **`packages/web` 밖의 유일한 코드 변경이며 빌드에는 영향이 없다.**
  이제 다른 패키지도 `.tsx`를 단위 테스트할 수 있다.

- **F-5: `renderToStaticMarkup`은 App Router에서 쓸 수 없다.** 단일 HTML 내보내기에서
  `react-dom/server`는 빌드가 거부하고("You're importing a component that imports
  react-dom/server"), `react-dom/server.edge`의 `renderToStaticMarkup`은 런타임이
  "do not use legacy react-dom/server APIs"로 거부한다. 둘 다 실측했다. 남은 정문은
  `server.edge`의 `renderToReadableStream` 하나이며 그것으로 구현했다.

- **F-6: `lib/source-scan.ts`가 `client-safety.spec.ts`의 `stripComments`와 같은 구현이다.**
  스펙 파일을 다른 스펙에서 import하면 그쪽 `describe`가 이쪽 수집기에 등록되어 같은
  테스트가 두 번 돈다. 합치려면 남의 테스트 파일에서 함수를 들어내야 하는데 그건 이
  태스크의 범위 밖이다. 통합은 별도 태스크로.

- **F-7: `json-dates.ts`의 되살리기 키에 `at`을 더한 것이 차트 데이터와 부딪힌다.**
  `ArticleEdit.at`은 `z.date()`라 되살려야 하는데, 그 순회가 `charts[].data.events[].at`
  (팩트 추출기가 낸 **문자열**)에도 닿는다. `chart-model.ts`가 두 형태를 모두 받아 흡수했다.
  근본 해법은 되살리기를 스키마 경로 기반으로 바꾸는 것이지만, 그건 `json-dates`의 설계를
  바꾸는 일이라 여기서 하지 않았다.

- **F-8: `articles`에는 `project` 필드가 없다.** 그래서 이 UI에는 프로젝트 필터가 없다.
  `packages/api/src/articles.ts`가 같은 이유를 적어 뒀다(집계물이라 소유 project가 없다).
  아티클이 늘면 `kind` 필터가 필요해질 텐데 `ListArticlesQuery`에 `kind`가 없고
  인덱스도 그 조회 패턴을 커버하지 않는다(B-1 판단). 스펙 변경이 선행되어야 한다.

## Context budget
- 읽기: specs/08 §5.3, packages/web/**
- (재시도 세션 추가) specs/04-api.md 아티클 절, packages/api/src/articles.ts,
  packages/contracts/src/article.ts·api.ts, packages/core/src/facts/charts.ts(차트 data 형상),
  packages/core/src/publisher/mermaid.ts(F-2 판단 근거)
