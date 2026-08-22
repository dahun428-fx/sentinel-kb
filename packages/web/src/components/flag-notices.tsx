/**
 * 새니타이즈 플래그 경고.
 *
 * specs/03 §2가 `injection-suspect`를 "생성 컨텍스트에서 제외, **목록에는 경고와 함께**
 * 노출"로 규정한다. 그 '경고와 함께'를 담당하는 컴포넌트다.
 * 본문은 언제나 React 텍스트 노드로만 렌더한다 — `dangerouslySetInnerHTML`을 쓰지 않는다.
 */
import type { SanitizeFlag } from "@sentinel/contracts";

import { flagNotices } from "../lib/display";

export function FlagNotices({
  flags,
  context,
}: {
  flags: readonly SanitizeFlag[];
  /** 어느 화면의 경고인지 — 스크린리더가 같은 문구를 반복해도 맥락을 잃지 않게 한다. */
  context: string;
}) {
  const notices = flagNotices(flags);
  if (notices.length === 0) {
    return null;
  }

  return (
    <div>
      {notices.map((notice) => (
        <p
          key={notice.flag}
          className={`notice ${notice.tone === "warning" ? "notice-warning" : "notice-info"}`}
          role="note"
          aria-label={`${context} 경고: ${notice.label}`}
        >
          <span className="notice-title">{notice.label}</span>
          {notice.description}
        </p>
      ))}
    </div>
  );
}
