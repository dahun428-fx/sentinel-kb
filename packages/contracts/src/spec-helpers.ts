/**
 * 스펙 전용 헬퍼. 프로덕션 코드에서는 쓰지 않는다.
 * 필수 필드가 빠진 페이로드를 만들 때 쓴다 — 스키마가 진짜로 거부하는지 보려면
 * 값을 undefined로 덮는 게 아니라 키 자체를 없애야 한다.
 */
export function without(
  source: Readonly<Record<string, unknown>>,
  ...keys: readonly string[]
): Record<string, unknown> {
  return Object.fromEntries(
    Object.entries(source).filter(([key]) => !keys.includes(key)),
  );
}
