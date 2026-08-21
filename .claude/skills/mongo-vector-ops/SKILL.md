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
`mongodb-memory-server`는 Atlas Search를 지원하지 않는다.
- 벡터·텍스트 검색이 필요한 통합 테스트 → Atlas 테스트 클러스터
- 그 외 → memory-server
테스트 파일에 어느 쪽인지 명시한다.

## 임베딩 모델 교체 (무중단)
1. `EMBEDDING_VERSION` 증가
2. 전체 재임베딩 → **신규 버전으로 삽입** (기존 청크 유지)
3. 인덱스 준비 확인 후 검색 필터를 신버전으로 스왑
4. 구버전 청크 삭제

**인플레이스 갱신 금지.** 중간 상태에서 검색이 깨진다.
