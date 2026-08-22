# T-015: MCP 도구 5종 구현
refs: specs/07-mcp.md
M: M3 | deps: T-014

## Scope
- search_knowledge / get_record / record_knowledge / give_feedback 구현
- suggest_resolution은 이 태스크에서 **검색 기반 스텁**(생성은 T-019에서 연결)
- get_record 응답에 `<retrieved-record>` data 래핑 + 지시 무시 문구 (NFR-05)
- record_knowledge 응답에 sanitizeFlags 경고 노출
- 각 도구 description은 specs/07 규칙대로 "무엇 + 언제 + 경계" 서술

## Out of scope
- RAG 생성, tool-selection eval

## Acceptance
- [ ] 도구 5개 정확히 등록됨(6개 이상이면 실패하는 테스트)
- [ ] search_knowledge 응답 토큰 추정치 <= 800 (테스트에서 tokenizer 근사 검증, NFR-03)
- [ ] get_record 응답에 래핑 태그와 지시 무시 문구 존재
- [ ] record_knowledge로 저장 시 project가 키에서 주입됨
- [ ] `pnpm verify` 그린

## Context budget
- 읽기: specs/07, packages/mcp/**, packages/contracts/src/**

## Findings (T-012에서 넘김 — 착수 전에 반드시 읽을 것)

- **⚠️ F-A. `SearchRequest.limit`을 그대로 재사용하면 NFR-03이 깨진다.**
  `specs/07:9`의 `search_knowledge`는 `limit?: number(=5)`인데 **상한이 명시돼 있지 않다.**
  HTTP 계약(`SearchRequest`)의 상한은 `max(20)`이고, T-012 실측상 `limit=20` 응답은
  **NFR-03(≈800 토큰)의 3.0–6.8배**다. 즉 에이전트가 합법적으로 예산을 깨뜨릴 수 있다.
  **NFR-03의 주어는 MCP다** — `specs/00:34` "MCP search 응답 <= 약 800 토큰 (요약+ID만)".
  HTTP 쪽 `max(20)`은 위반이 아니다(UI는 이 예산의 대상이 아니다). **묶어야 하는 쪽은 여기다.**

  T-012 실측(시드 50건 실데이터, 한국어 BPE 실비용 기준):

  | limit | 응답 크기 | 토큰(한국어 실비용) | 예산 대비 |
  |---|---|---|---|
  | 5 | 1,901자 / 2,451B | 953–1,226 | **1.19–1.53배 (이미 초과)** |
  | 20 | 6,923자 / 9,603B | 4,069–5,405 | 5.1–6.8배 |

  → **`limit` 5로는 부족하다. 3 안팎을 검토하라.** 그리고 Acceptance 2("토큰 추정치 <= 800")를
    판정할 때 **바이트/4 같은 근사를 쓰지 마라** — 한국어에서 음절당 0.75토큰을 뜻해
    구조적으로 과소추정이고, T-012가 그 근사 때문에 "경계에 걸쳐 있다"로 오판했다.
  → **응답 구조를 줄이는 쪽이 더 효과적이다.** T-012 실측상 hit당 비용은
    **고정 스캐폴딩 164자 > summary 97자 > title 56자**다. summary 상한(400자)은
    실데이터에서 한 번도 걸리지 않는 죽은 방어선이다(시드 50건 중 0건, max 170 / p50 93자).
    JSON 필드명·구두점을 줄이거나 hit 표현을 납작하게 만드는 편이 낫다.

- **⚠️ F-B. `SearchHit.score`는 RRF 융합 점수다 — 유사도가 아니다. 사용자에게 그대로 보여주지 마라.**
  `Σ 1/(RRF_K + rank)` 척도라 `RRF_K=60`에서 **상한이 `2/61 ≈ 0.033`**이고,
  T-012 실측에서 관측된 최고값은 `1/61 ≈ 0.0164`였다.
  **백분율로 환산하거나("관련도 1.6%") 절대 임계값과 비교하면 안 된다.** 같은 응답 안의
  결과끼리 상대 비교할 때만 의미가 있다. cosine 유사도는 이 응답에 실리지 않는다.
  경고가 `/v1/search` 오퍼레이션 description에 있지만 **너는 `SearchHit` 타입을 import하지
  그 문자열을 읽지 않는다** — 그래서 여기 적는다(G5 R-2). 필드 자체에 넣는 것은 contracts 개정(G3)이다.

- **F-C. `injection-suspect`의 "경고와 함께 노출"이 아직 아무 데서도 구현되지 않았다.**
  `specs/03:41`이 "생성 컨텍스트에서 제외(**목록에는 경고와 함께 노출**)"이라고 갈라놨는데,
  retriever는 `flags` 배열로 **기계 판독 신호만** 주고 HTTP도 그대로 흘린다.
  **"경고"의 산문 형태를 만드는 곳이 없다** — T-015(NFR-05 래핑)나 T-019가 하지 않으면
  이 스펙 조항이 죽은 채로 남는다. Scope의 "record_knowledge 응답에 sanitizeFlags 경고 노출"과
  같은 종류의 일이니 `search_knowledge` 쪽도 함께 볼 것.

- **F-D. 검색 품질은 아직 아무도 검증하지 않았다.**
  T-012의 통합 테스트는 `FakeEmbedder`를 쓰므로 벡터 경로가 cosine ≈ 0이고,
  **벡터 경로를 융합에서 제거해도 테스트 11개가 전부 통과한다**(검증자 뮤테이션 실증).
  `search_knowledge`가 쓸 만한 결과를 돌려주는지의 첫 판정은 **T-013 eval**이다.
  T-016(tool-selection eval)은 "어느 도구를 고르는가"를 재지 "결과가 좋은가"를 재지 않는다.
