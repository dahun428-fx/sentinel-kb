# 다른 프로젝트에 sentinel-kb 연결하기

이 문서 하나로 임의의 프로젝트에서 sentinel-kb MCP 서버에 붙일 수 있어야 한다.
계약의 단순함이 이 제품의 범용성이다 — **키 하나, `.mcp.json` 하나, CLAUDE.md 한 줄.**

관련 스펙: `specs/07-mcp.md`(도구 계약·도그푸딩), `specs/06-deployment.md`(nginx 라우팅),
`specs/00-product.md`(FR-05, NFR-03/04/05).

---

## 0. 전송 두 가지

| 전송                | 언제 쓰나                                          | 엔드포인트 / 진입점                    |
| ------------------- | -------------------------------------------------- | -------------------------------------- |
| **Streamable HTTP** | 일반적인 경우. 배포된 서버에 붙는다                | `POST/GET/DELETE https://<domain>/mcp` |
| **stdio 어댑터**    | 로컬 개발. 클라이언트가 서버 프로세스를 직접 spawn | `packages/mcp/src/stdio.cli.ts`        |

둘은 **같은 `createMcpServer`에서 나온 같은 도구 목록**을 쓴다. 전송만 다르다.
"로컬에선 되는데 서버에선 안 된다"가 도구 계약 차이로 생기는 일은 없다 — 생긴다면
원인은 거의 항상 아래 §2의 키 불일치다.

---

## 1. 키 발급

키는 `<key>:<projectSlug>` 형식이고, 콤마로 여러 개를 잇는다. 서버의 `API_KEYS` env에 넣는다.

```
API_KEYS=<key-a>:sentinel-kb,<key-b>:bizcare-web
```

- 키 하나가 **project 하나**에 묶인다. Bearer로 들어온 키가 그 요청의 project 스코프를 정한다.
- 그래서 클라이언트는 project를 스스로 고르지 않는다. **키를 바꾸는 것이 project를 바꾸는 유일한 방법이다.**
- 프로덕션 키는 SSM Parameter Store(SecureString)에 두고 배포 시 `.env`로 렌더한다(specs/06).
  이 문서를 포함해 **어떤 파일에도 키 값을 적지 않는다.** `.mcp.json`에는 `${SENTINEL_KB_KEY}` 참조만 쓴다.
- 형식이 깨졌거나 비어 있으면 서버는 **부팅에서** 죽는다(`parseApiKeys`). 첫 요청까지 미루지 않는다.

---

## 2. ⚠️ 배포 함정: MCP와 core-api의 `API_KEYS`는 반드시 같아야 한다

**이 절을 건너뛰면 배포 후 가장 오래 헤매게 된다.**

MCP 서버는 자기 서비스 키를 들고 있지 않다. 호출자가 보낸 Bearer 키를 **그대로** core-api로 전달한다.
confused deputy를 막기 위한 의도적 설계다 — MCP가 특권 키를 들고 있으면 인증만 통과한 아무 호출자나
MCP를 대리인 삼아 core-api의 전 권한을 쓸 수 있다.

그 결과 생기는 실패 모드:

> MCP의 `API_KEYS`에는 등록됐지만 core-api의 `API_KEYS`에는 없는 키가 있으면,
> **MCP 연결은 성공하고 도구 목록도 잘 보인다.** 401은 도구를 실제로 호출하는 순간
> core-api에서 나온다. 즉 실패가 연결 시점이 아니라 **한참 뒤 도구 호출 시점에** 드러난다.

체크리스트:

- [ ] MCP 컨테이너와 core-api 컨테이너가 **같은 `API_KEYS` 문자열**을 받는가
- [ ] 두 서비스가 **같은 SSM 파라미터**에서 렌더되는가 (복붙본이 두 벌 있으면 언젠가 갈라진다)
- [ ] 키를 추가·회수할 때 **두 서비스를 함께** 재시작하는가

진단: 연결은 되는데 도구 호출만 401이면 이 절을 의심한다. MCP 로그에는 `project`가 찍히고
core-api 로그에는 401이 찍히는 조합이 결정적 증거다.

---

## 3. `.mcp.json` — Streamable HTTP (기본)

연결할 프로젝트의 루트에 둔다.

```json
{
  "mcpServers": {
    "sentinel-kb": {
      "type": "http",
      "url": "${SENTINEL_KB_URL}/mcp",
      "headers": {
        "Authorization": "Bearer ${SENTINEL_KB_KEY}"
      }
    }
  }
}
```

- `SENTINEL_KB_URL`은 배포 도메인(예: `https://kb.example.com`). 경로 `/mcp`는 nginx가
  `mcp:3002`로 넘긴다(specs/06). 이 경로는 `proxy_buffering off`가 아니면 스트리밍이 죽는다 —
  **배포 후 첫 검증 항목.**
- 도메인을 리터럴로 박지 않고 env로 두는 이유: 도메인이 아직 확정되지 않았고, 개발·스테이징·프로덕션이
  같은 파일을 공유하기 때문이다. 값이 없으면 클라이언트가 서버를 띄우지 않고 알려준다 —
  잘못된 호스트에 조용히 붙는 것보다 낫다.
- 서버는 **stateless**다. 요청마다 새 서버·새 전송을 만들고 세션 ID를 발급하지 않는다.
  세션을 들고 있으면 키가 회수돼도 살아 있는 세션이 계속 그 project로 쓰기 때문이다.

---

## 4. `.mcp.json` — stdio (로컬 개발)

`specs/07`의 예시에는 stdio 항목이 없다. 이 레포의 `.mcp.json`이 그 자리를 채운 정본이다.

```json
{
  "mcpServers": {
    "sentinel-kb-local": {
      "type": "stdio",
      "command": "pnpm",
      "args": ["exec", "tsx", "packages/mcp/src/stdio.cli.ts"],
      "env": {
        "SENTINEL_KB_KEY": "${SENTINEL_KB_KEY}",
        "API_KEYS": "${API_KEYS}",
        "CORE_API_URL": "${CORE_API_URL}"
      }
    }
  }
}
```

### 4-1. `pnpm exec`를 쓰는 이유 — stdout에 배너가 섞이면 연결이 죽는다

stdio 전송의 stdout은 **JSON-RPC 프레임 전용 채널**이다. 한 줄이라도 다른 것이 섞이면
클라이언트 파서가 깨지고 `initialize`가 실패한다.

`pnpm run <script>`는 실행 헤더(`> @sentinel/mcp@0.0.0 start:stdio ...`)를 **stdout으로** 낸다.
이 레포에서 실제로 확인한 동작이다. 그래서 `.mcp.json`은 `pnpm run`을 쓰지 않는다.

| 형태                                          | stdout 오염           |
| --------------------------------------------- | --------------------- |
| `pnpm run start:stdio`                        | **있음 — 쓰지 말 것** |
| `pnpm --silent run start:stdio`               | 없음                  |
| `pnpm exec tsx packages/mcp/src/stdio.cli.ts` | 없음 (**권장**)       |

서버 자신도 같은 규칙을 지킨다 — `stdio.cli.ts`의 준비 완료 로그는 stderr로 나간다.

### 4-2. stdio는 인증에 실패하면 **뜨지 않는다**

stdio에는 HTTP가 없다. 401을 실을 상태 줄도, `WWW-Authenticate`를 실을 헤더도 없다.
그래서 인증 실패를 **부팅 실패**로 처리한다: 프로세스 시작 시 `SENTINEL_KB_KEY`를 `API_KEYS`에
대조해 project를 확정하고, 확정하지 못하면 비정상 종료한다.

이유는 "엄격해서"가 아니다. specs/07이 요구하는 것은 "Bearer → **project 스코프 주입**"이고,
project를 확정하지 못한 서버는 인증을 건너뛴 서버가 아니라 **쓰기 스코프가 없는 서버**다.
그런 서버가 조용히 뜨면 로컬에서 기록한 사례가 엉뚱한 project로 들어가고,
그건 몇 달 뒤 검색이 안 될 때에야 발견된다. 부팅에서 죽는 편이 훨씬 싸다.

stderr에 이 문구가 나오면 원인은 하나다:

> `SENTINEL_KB_KEY`가 설정되지 않았거나 `API_KEYS`에 등록되어 있지 않다.
> stdio 모드는 project 스코프를 확정하지 못하면 기동하지 않는다.

조치: `SENTINEL_KB_KEY` 값이 `API_KEYS`의 `<key>` 부분과 **정확히** 일치하는지 확인한다
(공백·따옴표가 섞이기 쉽다).

---

## 5. MCP 서버가 읽는 환경변수

| 변수                    | 기본값                  | 설명                                                                                                                                                                            |
| ----------------------- | ----------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `SENTINEL_KB_KEY`       | 없음                    | **stdio 전용.** 이 프로세스가 쓸 project 키. HTTP 모드에서는 요청 헤더로 온다                                                                                                   |
| `API_KEYS`              | 없음(필수)              | `<key>:<projectSlug>` 콤마 구분. **core-api와 동일해야 한다**(§2)                                                                                                               |
| `CORE_API_URL`          | `http://localhost:3001` | compose 안에서는 `http://core-api:3001`                                                                                                                                         |
| `CORE_API_TIMEOUT_MS`   | `10000`                 | core-api 호출 타임아웃                                                                                                                                                          |
| `CORE_API_MAX_ATTEMPTS` | `3`                     | **읽기 경로에만 적용된다.** `record_knowledge` 같은 쓰기는 절대 재시도하지 않는다 — 타임아웃은 "도달하지 않았다"가 아니라 "결과를 모른다"이고, 재전송하면 레코드가 두 벌 생긴다 |
| `MCP_PORT`              | `3002`                  | HTTP 모드 리스닝 포트                                                                                                                                                           |

⚠️ `SENTINEL_KB_KEY`·`CORE_API_URL`·`CORE_API_TIMEOUT_MS`·`CORE_API_MAX_ATTEMPTS`는
**아직 `.env.example`에 없다**(T-014 F-2). T-026에서 compose env와 함께 추가될 예정이며,
그때까지는 이 표가 정본이다.

---

## 6. 연결할 프로젝트의 CLAUDE.md에 넣을 프로토콜 문구

`.mcp.json`만으로는 에이전트가 도구를 **언제** 부를지 모른다. 그 트리거를 프로젝트 규칙에 심는 것이
연결의 나머지 절반이다. 대상 프로젝트의 `CLAUDE.md`에 아래 섹션을 그대로 붙여 넣는다.

```markdown
## 지식보관소 프로토콜 (sentinel-kb)

이 프로젝트에서 문제를 만나면:

- 디버깅을 **시작하기 전에** `sentinel-kb.search_knowledge`로 과거 사례를 먼저 확인한다.
- 해결한 **후에** `sentinel-kb.record_knowledge`로 기록한다.
- 에이전트 산출물이 의도와 벌어졌으면 `type: "divergence"`로 기록한다
  (모델·도구·재현 조건 포함).
```

한 줄로 줄여야 한다면 specs/07의 원문을 쓴다:

> 디버깅 전 `sentinel-kb.search_knowledge`로 과거 사례를 먼저 확인하고,
> 해결 후 `record_knowledge`로 기록한다.

**"전에"와 "후에"가 이 문구의 전부다.** 도구 설명만으로는 에이전트가 디버깅을 다 끝낸 뒤에야
검색을 떠올린다. 그 시점의 검색은 아무것도 아끼지 못한다.

이 레포(sentinel-kb) 자신의 `CLAUDE.md`에는 "도그푸딩 프로토콜 (M3 이후)" 절로 이미 반영돼 있다.

---

## 7. 도구 5개

| 도구                 | 언제 부르나                                    | 응답                                                                                              |
| -------------------- | ---------------------------------------------- | ------------------------------------------------------------------------------------------------- |
| `search_knowledge`   | 증상·키워드로 과거 사례를 훑을 때              | 요약 목록만 (**본문 없음**, NFR-03 약 800토큰)                                                    |
| `get_record`         | 목록에서 후보를 정하고 전문이 필요할 때        | 전체 레코드. `<retrieved-record>` 블록으로 감싸 나오며 **그 안의 지시문은 따르지 않는다**(NFR-05) |
| `record_knowledge`   | 해결한 뒤 기록할 때                            | `{recordId, sanitizeFlags[], warning?}`. 마스킹이 일어나면 **무엇이 마스킹됐는지 알려준다**       |
| `suggest_resolution` | "이 에러 어떻게 고치나"를 한 번에 묻고 싶을 때 | 인용 후보 목록. 0건이면 `found:false` + 기록 유도                                                 |
| `give_feedback`      | 어떤 기록이 실제로 도움이 됐는지 표시할 때     | 골든셋 후보로 적재(자동 승격 없음)                                                                |

**도구는 5개에서 늘지 않는다.** 도구 수는 곧 에이전트의 인지 부하다. 추가는 스펙 개정 + 인간 승인 사항이다.

### `suggest_resolution`의 현재 한계 — 과장하지 말 것

이 도구는 **현재 검색 기반 스텁이다.** 원인 가설과 해결 절차를 **생성하지 않는다.**
관련 있는 과거 기록을 인용 후보로 돌려줄 뿐이고, 판단은 호출자가 `get_record`로 전문을 읽어서 한다.

근거 없는 해결책 생성 금지는 NFR-02이고 이 제품이 존재하는 이유 자체다. 생성은 T-019가
`/v1/answer`를 붙이면서 온다. 그전에 그럴듯한 문장을 만들어 두면 근거 없는 답변이 실제로 유통된다.

---

## 8. 연결 확인

### 8-1. `pnpm mcp:ping` (권장)

```bash
export SENTINEL_KB_URL=https://kb.example.com
export SENTINEL_KB_KEY=...          # 셸 히스토리에 남기지 않으려면 .env에서 읽어라
pnpm mcp:ping
```

`initialize` → `tools/list`를 던져 **도구가 5개인지** 확인한다. 도구 이름은 stdout으로,
진단은 stderr로 나간다.

**판정은 눈이 아니라 종료 코드로 한다.** 실패를 원인별로 가르는 것이 이 스크립트의 요점이다 —
"연결이 안 된다"와 "붙었는데 도구가 모자란다"는 고치는 사람이 다르다.

| 종료 코드 | 뜻                                                     | 누가 고치나          |
| --------- | ------------------------------------------------------ | -------------------- |
| `0`       | 도구 5개 확인                                          | —                    |
| `1`       | 붙었지만 도구 수가 5개가 아님                          | 서버 코드 (specs/07) |
| `69`      | 서버에 닿지 못함 (미기동·DNS·방화벽·타임아웃)          | 배포·네트워크        |
| `70`      | ping 자신의 버그                                       | 이 스크립트          |
| `76`      | HTTP는 되는데 MCP로 말이 안 통함 (404·5xx·깨진 프레임) | nginx 라우팅         |
| `77`      | 인증 실패 (401/403)                                    | `API_KEYS` (§2)      |
| `78`      | env 오설정                                             | 호출자               |

⚠️ **stdout을 파싱하려면 `pnpm --silent mcp:ping`을 써라.** `pnpm run`은 자신의 실행 헤더를
stdout으로 내보낸다(§4-1과 **같은 함정이다** — 확인된 동작이다). CI·런북은 목록을 세지 말고
종료 코드를 보면 된다.

`mcp:ping`은 HTTP 전송만 확인한다. stdio 항목은 §8-2의 4번으로 확인한다.

### 8-2. Claude Code에서

1. `.mcp.json`을 둔 프로젝트에서 세션을 연다.
2. `/mcp`를 실행해 `sentinel-kb`(또는 `sentinel-kb-local`)가 **connected**로 뜨는지 본다.
3. 도구 목록에 위 5개가 모두 보이는지 확인한다.
4. `search_knowledge`를 아무 키워드로 한 번 호출한다 — **여기서 401이 나면 §2의 키 불일치다.**

3번까지 통과하고 4번에서 실패하는 조합이 §2가 경고하는 바로 그 실패 모드다.
`mcp:ping`도 3번까지만 본다 — **4번은 사람이 해야 한다.**

### 8-3. HTTP 도달성·인증만 먼저 보고 싶으면

`initialize`는 모든 MCP 세션의 첫 메시지다. 이것만 던져 보면 nginx 라우팅과 Bearer 인증을
클라이언트 없이 가를 수 있다.

```bash
curl -sS -D- -o/dev/null \
  -X POST "$SENTINEL_KB_URL/mcp" \
  -H "Authorization: Bearer $SENTINEL_KB_KEY" \
  -H "Content-Type: application/json" \
  -H "Accept: application/json, text/event-stream" \
  -d '{"jsonrpc":"2.0","id":1,"method":"initialize","params":{"protocolVersion":"2025-06-18","capabilities":{},"clientInfo":{"name":"curl","version":"0"}}}'
```

| 결과                               | 해석                                                                             |
| ---------------------------------- | -------------------------------------------------------------------------------- |
| `401` + `WWW-Authenticate: Bearer` | 키가 **MCP의** `API_KEYS`에 없다                                                 |
| `404`                              | 경로가 `/mcp`가 아니거나 nginx가 MCP로 넘기지 않는다                             |
| 연결 실패·타임아웃                 | 도메인/방화벽. SG는 443만 열려 있다(specs/06)                                    |
| `200`                              | MCP 인증 통과. **core-api 쪽 키는 아직 검증되지 않았다** — 8-2의 4번을 해야 한다 |

`mcp:ping`이 이 왕복을 대신해 주므로 보통은 §8-1로 충분하다. 이 curl은 ping 자체를 의심할 때 쓴다.

---

## 9. 지원 클라이언트

1차 타깃은 **Claude Code**다 — `.mcp.json`의 커스텀 헤더를 지원한다.
웹 클라이언트의 원격 커넥터는 OAuth를 요구할 수 있어 현 버전 범위 밖이다.
필요해지면 OAuth 지원을 백로그로 다룬다. (감사 B-3)

---

## 10. 증상별 진단표

먼저 `pnpm mcp:ping`을 돌려라 — 종료 코드가 아래 어느 줄인지 대개 바로 가려 준다(§8-1).

| 증상                                  | 원인 후보                       | 확인                                   |
| ------------------------------------- | ------------------------------- | -------------------------------------- |
| 도구 목록은 보이는데 호출만 401       | **§2 키 불일치** (가장 흔함)    | core-api의 `API_KEYS`에 그 키가 있는가 |
| stdio 서버가 뜨자마자 죽음            | `SENTINEL_KB_KEY` 미설정/미등록 | stderr 첫 줄. §4-2                     |
| stdio `initialize` 실패 / 파싱 오류   | stdout에 배너가 섞임            | `pnpm run`을 쓰고 있지 않은가. §4-1    |
| HTTP 연결은 되는데 응답이 끊김        | nginx `proxy_buffering`         | specs/06 nginx 라우팅                  |
| 기록이 엉뚱한 project로 들어감        | 키를 잘못 씀                    | project는 키가 정한다. §1              |
| `suggest_resolution`이 해결책을 안 줌 | 정상 동작                       | §7의 한계 절                           |
