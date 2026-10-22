# 로컬 실행 (UPLIFT P3)

맥북 한 대에서 전체 스택(core-api, worker, mcp, web, nginx)을 띄우고 Claude Code를 MCP로 붙이는 절차다.
2026-10-22에 이 순서로 처음 기동해 확인했다(UPLIFT §8 P3 결과).

## 1. DB: atlas-local

`$search`·`$vectorSearch`가 필요하므로 일반 mongo가 아니라 `mongodb/mongodb-atlas-local`을 쓴다.
**`127.0.0.1`에만 열고 인증을 켠다.** `-p 27017:27017`로 열면 인증 없는 DB가 같은 네트워크에 노출된다(P1 리뷰 S9).

```bash
DBPW=$(openssl rand -hex 16)
docker run -d --name sentinel-kb-atlas \
  -p 127.0.0.1:27017:27017 \
  -e MONGODB_INITDB_ROOT_USERNAME=sentinel -e MONGODB_INITDB_ROOT_PASSWORD="$DBPW" \
  -v sentinel-kb-atlas-data:/data/db \
  mongodb/mongodb-atlas-local:latest
```

## 2. `.env`

`.env.example`을 복사해 아래 값을 채운다. `.env`는 git이 무시한다.

| 변수 | 값 |
|---|---|
| `MONGODB_URI` | `mongodb://sentinel:<DBPW>@host.docker.internal:27017/sentinel?authSource=admin&directConnection=true` (compose 컨테이너에서 호스트의 atlas-local로 간다) |
| `API_KEYS` | `<openssl rand -hex 32로 만든 키>:sentinel-kb` |
| `SENTINEL_KB_KEY`, `CORE_API_KEY` | 위 키 |
| `WEB_HTPASSWD_B64` | `printf 'admin:%s\n' "$(openssl passwd -apr1 '<웹 비밀번호>')" \| base64` |
| `EMBEDDING_PROVIDER` | P3는 `fake`. P4부터 `voyage` + `VOYAGE_API_KEY` |
| `ANTHROPIC_API_KEY` | P3는 아무 문자열(Q-13 (a)). 코드는 빈 값만 거부한다. 더미 키로는 생성이 검증되지 않는다 |

## 3. 기동과 확인

```bash
docker compose up --build -d
docker compose ps                     # db-init: Exited (0), 나머지 healthy
curl -s -o /dev/null -w '%{http_code}\n' http://127.0.0.1:8080/health   # 200
curl -s -o /dev/null -w '%{http_code}\n' http://127.0.0.1:8080/         # 401 (웹은 basic 인증)
SENTINEL_KB_URL=http://127.0.0.1:8080 SENTINEL_KB_KEY=<키> pnpm --silent mcp:ping   # 도구 5개, 종료 코드 0
```

nginx는 `127.0.0.1:8080`에만 열린다(T-050).

## 4. Claude Code 연결

`.mcp.json`의 `sentinel-kb-local`(stdio)은 셸 환경변수를 읽는다. core-api는 호스트에 직접 열려 있지 않으므로
nginx를 거친다.

```bash
export SENTINEL_KB_KEY=<키>
export API_KEYS=<키>:sentinel-kb
export CORE_API_URL=http://127.0.0.1:8080
claude   # 이 저장소에서 실행하면 .mcp.json을 읽는다. /mcp 로 sentinel-kb-local 도구 5개 확인
```

다른 프로젝트에서 쓰려면 HTTP 항목(`sentinel-kb`)을 그 프로젝트 `.mcp.json`에 넣고 `SENTINEL_KB_URL=http://127.0.0.1:8080`을 준다.

## 5. P4로 넘어가기 전

fake 벡터와 Voyage 벡터가 같은 `embeddingVersion`에 섞이면 검색이 정상 응답 모양으로 실패한다(P1 리뷰 C1).
T-053 이후에는 섞이려 하면 worker·core-api가 `EMBEDDING_GENERATION_MISMATCH`로 기동을 거부한다. 둘 중 하나를 한다.

- **버전을 올리고 재임베딩**: `.env`에서 `EMBEDDING_VERSION`을 올리고 `docker compose up -d` 후
  `pnpm --filter @sentinel/worker reembed`(호스트에서 실행할 때는 `MONGODB_URI`를 `127.0.0.1:27017`로, `MONGODB_DB=sentinel`).
- **P3 데이터를 지운다** (실데이터가 없을 때 가장 단순하다):

```bash
docker compose down
docker rm -f sentinel-kb-atlas && docker volume rm sentinel-kb-atlas-data
```
그다음 1단계부터 다시 하되 `EMBEDDING_PROVIDER=voyage`와 `VOYAGE_API_KEY`를 넣는다.

core-api나 mcp 컨테이너만 다시 만들었으면 `docker compose restart nginx`를 한다. nginx가 옛 컨테이너 IP를 쥐고 502를 낸다(T-064).

## 멈추기

```bash
docker compose down            # 스택
docker stop sentinel-kb-atlas  # DB (데이터는 볼륨에 남는다)
```
