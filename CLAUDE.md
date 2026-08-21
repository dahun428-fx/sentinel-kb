# sentinel-kb — Agent Operating Manual

AI-first 트러블슈팅 지식 보관소. 여러 프로젝트의 에이전트가 MCP로 접속해
과거 사례를 검색하고 새 사례를 기록한다. **MCP 서버가 1차 제품이고 UI는 보조다.**

## 최우선 원칙

1. **스펙이 소스 오브 트루스.** 모든 구현은 `specs/`에서 파생된다.
   코드와 스펙이 어긋나면 코드가 아니라 스펙을 먼저 고친다(인간 승인 필요).
2. **태스크 단위로만 작업한다.** `specs/tasks/T-xxx.md` 하나 = 세션 하나 = PR 하나.
   태스크에 없는 개선은 하지 않는다. 발견하면 `## Findings`에 적고 넘어간다.
3. **Context budget을 지킨다.** 태스크 스펙의 "읽어야 할 파일" 밖은 탐색하지 않는다.
4. **테스트와 eval을 고쳐서 통과시키지 않는다.** 이건 즉시 중단 사유다.

## 스펙 인덱스

| 파일 | 내용 | 언제 읽나 |
|---|---|---|
| specs/00-product.md | 제품 정의, FR/NFR | 요구사항 확인 |
| specs/01-architecture.md | 서비스 구성, 설계 결정 | 새 모듈 추가 |
| specs/02-data-model.md | 스키마, 마이그레이션 | DB 관련 작업 |
| specs/03-rag-pipeline.md | 청킹·검색·생성 | RAG 코드 |
| specs/04-api.md | HTTP 계약 | core-api |
| specs/05-test-strategy.md | 테스트·eval 체계 | 테스트 작성 |
| specs/06-deployment.md | AWS 배포 | 인프라 |
| specs/07-mcp.md | MCP 도구 계약 | packages/mcp |

## 명령어

```bash
pnpm verify        # lint + typecheck + unit + integration (머지 전 필수 그린)
pnpm test          # unit only
pnpm test:e2e      # Playwright
pnpm eval          # RAG eval (retrieval + generation)
pnpm eval:tools    # MCP tool-selection eval
pnpm db:seed       # 시드 데이터 적재
pnpm dev           # 패키지 병렬 dev 서버 (M1부터 사용 가능)
pnpm dev:compose   # 전체 스택 compose 기동 (T-026 이후)
```

## 코드 규칙

- TypeScript strict. `any` 금지, 불가피하면 주석으로 사유.
- **API 계약은 `packages/contracts`의 Zod 스키마가 단일 소스.** 타입을 다른 곳에 재정의하지 않는다.
- LLM 호출은 `packages/core/src/llm/` 경유만 허용. 다른 데서 SDK를 직접 부르지 않는다.
- 임베딩 호출은 `embedder` 인터페이스 경유. 모델명 하드코딩 금지(`embeddingVersion` 참조).
- 한국어 산문(문서·주석), 영어 코드(식별자·커밋 메시지 본문).

## 금지 사항

- 시크릿 하드코딩 (SSM/.env만)
- 스펙 없는 신규 API·MCP 도구 추가
- eval 기준선을 낮추는 커밋
- MCP 도구 개수 5개 초과 (specs/07 근거)
- `packages/mcp` 응답에 레코드 본문 전체 삽입 (토큰 예산 NFR-03)

## 태스크 수행 프로토콜

`.claude/skills/task-loop/SKILL.md`를 따른다. 요약:

1. `specs/tasks/T-xxx.md`와 refs만 읽는다
2. 구현 계획 3–7줄 선언
3. 최소 diff로 구현
4. `pnpm verify` (+ 해당 시 eval)
5. 실패 시 3회까지 재시도, 초과 시 BLOCKED 마킹 후 중단
6. 성공 시 PR 생성 (스펙 ID, eval diff 첨부)

## 도그푸딩 프로토콜 (M3 이후)

이 레포에서 작업 중 문제를 만나면:
- 디버깅 **전에** `sentinel-kb.search_knowledge`로 과거 사례 확인
- 해결 **후에** `sentinel-kb.record_knowledge`로 기록
- 에이전트 산출물이 의도와 벌어졌으면 `type: "divergence"`로 기록 (모델·도구·재현 조건 포함)
