/**
 * 정렬 원시함수. 팩트 팩의 **결정론은 전부 이 파일 위에 서 있다.**
 *
 * ## `localeCompare`를 쓰지 않는다
 *
 * `String.prototype.localeCompare`의 결과는 런타임의 ICU 데이터와 기본 로케일에 달려 있다.
 * 같은 코드가 개발자 노트북과 CI 컨테이너에서 다른 순서를 낼 수 있고, 그러면
 * "같은 입력 → 같은 출력"이 **환경이 같을 때만** 성립하는 약속으로 격하된다.
 * 아티클은 소스 집합 해시로 멱등성을 잡는데(T-029), 그 아래에서 팩트가 흔들리면
 * 같은 `_id`의 아티클이 실행마다 다른 팩트를 갖게 된다.
 *
 * 코드유닛 비교는 로케일을 보지 않는다. 사람이 보기 좋은 한국어 정렬을 포기하는 대신
 * 어디서 돌려도 같은 바이트가 나온다 — 발행 파이프라인에서는 후자가 훨씬 중요하다.
 */

/** UTF-16 코드유닛 순서. 로케일 의존이 없다. */
export function compareStrings(a: string, b: string): number {
  if (a === b) return 0;
  return a < b ? -1 : 1;
}

/** 빈도 내림차순 → 키 오름차순. 동수일 때 순서가 흔들리지 않게 하는 전순서다. */
export function compareByCountThenKey(
  a: { readonly key: string; readonly count: number },
  b: { readonly key: string; readonly count: number },
): number {
  return b.count - a.count || compareStrings(a.key, b.key);
}

/** 소수 자릿수 고정. 부동소수 잔여(0.30000000000000004)가 스냅샷에 새는 것을 막는다. */
export function round(value: number, digits: number): number {
  const factor = 10 ** digits;
  return Math.round(value * factor) / factor;
}
