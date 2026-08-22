/**
 * cursor 페이지네이션. 출처: specs/04-api.md 규약
 * > 페이지네이션은 cursor(`createdAt+_id`) 방식. offset 금지.
 *
 * offset이 금지된 이유는 취향이 아니다. 이 컬렉션은 앞쪽(최신)에 계속 삽입되므로
 * `skip(n)`은 페이지를 넘기는 사이에 들어온 레코드만큼 **창을 뒤로 밀어** 같은 레코드를
 * 두 번 보여주거나 건너뛴다. `createdAt`만으로도 부족하다 — 같은 밀리초에 들어온 두
 * 레코드가 경계에 걸리면 하나가 영영 안 나온다. 그래서 `_id`가 동점 처리자로 붙는다.
 *
 * `offset` 파라미터 자체는 `ListRecordsQuery`의 `.strict()`가 거부한다(contracts).
 * 여기서 다시 막지 않는다 — 계약이 이미 하는 일을 코드로 반복하면 둘이 갈라진다.
 */
import { ObjectId } from "mongodb";

/** 목록 정렬 키. 최신순이며 `_id`가 동점 처리자다. 이 순서가 곧 cursor의 의미다. */
export interface ListCursor {
  readonly createdAt: Date;
  readonly id: ObjectId;
}

/** 페이로드 구분자. ISO 8601에도 24자 hex에도 등장하지 않는 문자여야 한다. */
const SEPARATOR = "|";

/**
 * cursor를 base64url로 인코딩한다. 불투명하게 만드는 것이 목적이다 —
 * 평문이면 클라이언트가 값을 조립해 보내기 시작하고, 그 순간 정렬 키 변경이 breaking change가 된다.
 */
export function encodeCursor(cursor: ListCursor): string {
  const raw = `${cursor.createdAt.toISOString()}${SEPARATOR}${cursor.id.toHexString()}`;
  return Buffer.from(raw, "utf8").toString("base64url");
}

/** 형식이 어긋나면 `undefined`. 호출자가 400으로 번역한다(던지면 500이 된다). */
export function decodeCursor(encoded: string): ListCursor | undefined {
  let raw: string;
  try {
    raw = Buffer.from(encoded, "base64url").toString("utf8");
  } catch {
    return undefined;
  }

  const separatorAt = raw.indexOf(SEPARATOR);
  if (separatorAt < 0) return undefined;

  const createdAt = new Date(raw.slice(0, separatorAt));
  if (Number.isNaN(createdAt.getTime())) return undefined;

  const hex = raw.slice(separatorAt + 1);
  if (!/^[0-9a-fA-F]{24}$/.test(hex)) return undefined;

  return { createdAt, id: new ObjectId(hex) };
}
