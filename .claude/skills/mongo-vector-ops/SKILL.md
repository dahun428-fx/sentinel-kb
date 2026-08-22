---
name: mongo-vector-ops
description: MongoDB Atlas Vector Search 인덱스 정의, $vectorSearch/$search 쿼리 작성, 임베딩 모델 교체 마이그레이션 작업 시 반드시 사용한다. 인덱스 필터 필드, numCandidates 설정, embeddingVersion 스왑 절차, 로컬 테스트 제약을 다룬다. 벡터 검색·인덱스·마이그레이션 관련 작업이면 이 스킬을 먼저 읽는다.
---

# Mongo Vector Ops

## 인덱스
정의는 **JSON 파일로** 관리하고 스크립트가 적용한다(`pnpm db:search-indexes`). 코드에 인라인 금지.

```json
{ "fields": [
  { "type": "vector", "path": "embedding", "numDimensions": <EMBEDDING_DIM>, "similarity": "cosine" },
  { "type": "filter", "path": "meta.type" },
  { "type": "filter", "path": "meta.project" },
  { "type": "filter", "path": "embeddingVersion" }
]}
```
필터로 쓸 필드는 **반드시 인덱스에 filter로 선언**해야 한다. 빠뜨리면 필터가 무시되는 게 아니라 쿼리가 실패한다.

## 쿼리
- `numCandidates`는 limit의 10–20배. 너무 낮으면 recall이 조용히 떨어진다
- `$vectorSearch`는 파이프라인 **첫 스테이지**여야 한다
- 점수는 `$meta: "vectorSearchScore"`로 꺼낸다. cosine이므로 0–1 범위
- `$search`(텍스트)와는 별도 파이프라인으로 각각 실행하고 애플리케이션에서 RRF 융합한다

## 로컬 테스트 제약
`mongodb-memory-server`는 Atlas Search를 지원하지 않는다 — 검색 인덱스 생성 자체가 안 된다.
- 벡터·텍스트 검색이 필요한 통합 테스트 → **`mongodb/mongodb-atlas-local` 컨테이너**
- 그 외 → memory-server

테스트 파일에 어느 쪽인지 명시한다. 부팅은 `packages/core/src/testing/atlas-local.ts`를 쓴다
(복붙 금지 — 단일 소스다).

**클라우드 자격증명은 필요 없다.** 컨테이너가 `$vectorSearch`·`$search`를 그대로 지원한다.
경계는 "Atlas 유무"가 아니라 **"의미 있는 임베딩 유무"**다 — `FakeEmbedder`는 해시 기반이라
서로 다른 텍스트 간 cosine이 0 근처이므로 **검색 품질**은 측정할 수 없다(eval 계층의 몫).

주의할 점 셋(전부 실측):
- 컨테이너는 **mongod와 mongot 2프로세스**이고 mongod가 먼저 뜬다. `ping`이 통해도 검색은
  `localhost:27027 Connection refused`로 죽는다 — 2단계 부팅 게이트가 필요하다.
- **중복 `createSearchIndex`를 조용히 삼킨다.** 실 Atlas는 `IndexAlreadyExists`로 죽는다.
  즉 멱등 가드를 지워도 컨테이너 테스트로는 못 잡는다 — 드라이버 스텁으로 따로 잠가라.
- **동점 점수 청크의 후보 순서는 보장되지 않는다.** 픽스처에서 점수를 어긋나게 심거나
  동점 그룹을 지목하지 말고 집합으로 단언하라. 어기면 간헐 실패가 뮤테이션 결과를 오염시킨다.

## 점수 척도 (틀리기 쉽다)
`$vectorSearch`의 `vectorSearchScore`는 **원시 cosine이 아니다.** `cosine`/`dotProduct`
similarity에서 Atlas는 **`(1+cos)/2`로 정규화**해 0–1로 준다. 실측:

| 각도 | raw cos | Atlas 점수 |
|---|---|---|
| 동일 | +1.0 | 1.000 |
| 60° | +0.5 | 0.750 |
| **직교** | 0.0 | **0.500** |
| **정반대** | −1.0 | **0.000** |

이 레포의 `retriever`는 `2s − 1`로 **원시 cosine으로 환산해서** 돌려준다(`specs/03 §4`의
`SIMILARITY_THRESHOLD`가 원시 cosine 척도이기 때문). **이중 환산하지 마라.**
`$search`의 `searchScore`는 BM25라 무제한이고 환산 대상이 아니다.

## 임베딩 모델 교체 (무중단)
1. `EMBEDDING_VERSION` 증가
2. 전체 재임베딩 → **신규 버전으로 삽입** (기존 청크 유지)
3. 인덱스 준비 확인 후 검색 필터를 신버전으로 스왑
4. 구버전 청크 삭제

**인플레이스 갱신 금지.** 중간 상태에서 검색이 깨진다.
