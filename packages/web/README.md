# @sentinel/web — 읽기 UI

트러블슈팅 지식의 **검색·열람 전용** 콘솔이다 (FR-08, T-023).
MCP 서버가 1차 제품이고 이 UI는 보조다 — 기록·수정·대시보드는 여기 없다.

## 화면

| 경로 | 하는 일 |
|---|---|
| `/` | 검색 콘솔. 질의 + 종류·프로젝트 필터 → `POST /v1/search` 결과 목록 |
| `/answer` | 인용 포함 답변. `POST /v1/answer` → 인용 클릭 시 해당 레코드의 해당 섹션으로 점프 |
| `/records/:id` | 레코드 상세. `GET /v1/records/:id`. 섹션마다 `#section-<ChunkSection>` 앵커 |

전부 서버 컴포넌트다. 폼은 `<form method="get">`이라 클라이언트 JS 없이 동작하고,
검색 상태가 URL에 남아 결과를 그대로 공유할 수 있다.

## 환경변수

`.env.example`에는 아직 없다 — 루트 파일 수정이 T-023 범위 밖이라 여기에 적는다.
아래 두 줄을 `.env.example`에 추가해야 한다.

```
# --- Web UI (T-023) ---
# 웹이 부를 core-api 주소. 미설정 시 http://localhost:3001 (CORE_API_PORT 기본값)
CORE_API_URL=http://localhost:3001
# 웹이 core-api에 쓸 Bearer 키. API_KEYS의 항목 중 하나여야 한다.
# NEXT_PUBLIC_ 접두사를 붙이지 마라 — 붙는 순간 클라이언트 번들로 인라인된다.
CORE_API_KEY=
```

## 명령

```bash
pnpm --filter @sentinel/web dev        # 개발 서버
pnpm --filter @sentinel/web build      # 프로덕션 빌드
pnpm --filter @sentinel/web test:e2e   # Playwright E2E (core-api 스텁을 함께 띄운다)
```

E2E는 `pnpm verify`에서 분리되어 있다. 최초 1회 `pnpm exec playwright install chromium` 필요.

## 설계 메모

- **점수를 백분율로 보여주지 않는다.** `SearchHit.score`는 RRF 융합값 `Σ 1/(k+순위)`이고
  `RRF_K=60`에서 상한이 `2/61 ≈ 0.0328`이다. 유사도가 아니므로 화면은 **순위**를 쓰고
  원값은 `RRF 0.0328`처럼 척도를 밝혀 곁들인다. 근거와 테스트는 `src/lib/display.ts`.
- **`injection-suspect`는 감추지 않고 경고와 함께 노출한다** (specs/03 §2). 본문은 언제나
  React 텍스트 노드로 들어가며 `dangerouslySetInnerHTML`은 소스 전역에서 금지다
  (`src/client-safety.spec.ts`가 강제한다).
- **API 키는 서버 프로세스 밖으로 나가지 않는다.** 클라이언트 컴포넌트가 없고,
  `lib/api-client.ts`는 브라우저에서 실행되면 던진다. 검증은 `src/client-safety.spec.ts`와
  e2e의 카나리 키 검사 두 겹이다.
- **`--webpack`으로 돈다.** `@sentinel/contracts`가 빌드 산출물이 아니라 소스를 노출하고
  (`main: ./src/index.ts`) NodeNext 규칙대로 `./common.js` 형태로 import하는데,
  Turbopack은 그 확장자 별칭(`experimental.extensionAlias`)을 무시한다.
  contracts가 dist를 노출하게 되면 이 플래그와 옵션을 함께 되돌릴 수 있다.
