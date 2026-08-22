/**
 * 루트 레이아웃. 읽기 UI의 공통 골격이다(T-023, FR-08).
 * 서버 컴포넌트다 — 이 트리에는 클라이언트 JS가 필요 없다.
 */
import type { Metadata } from "next";
import type { ReactNode } from "react";

import "./globals.css";

export const metadata: Metadata = {
  title: "sentinel-kb 지식 콘솔",
  description: "트러블슈팅 지식 검색·열람 (읽기 전용)",
};

export default function RootLayout({ children }: { children: ReactNode }) {
  return (
    <html lang="ko">
      <body>
        {/* 키보드 사용자가 헤더를 건너뛰게 한다 — Lighthouse 접근성의 기본 항목이다. */}
        <a className="skip-link" href="#main">
          본문으로 건너뛰기
        </a>
        <header className="site-header">
          <div className="shell">
            <p className="site-title">sentinel-kb 지식 콘솔</p>
            <nav className="site-nav" aria-label="주요">
              <ul>
                <li>
                  <a href="/">검색</a>
                </li>
                <li>
                  <a href="/answer">답변</a>
                </li>
              </ul>
            </nav>
          </div>
        </header>
        <main id="main" className="shell">
          {children}
        </main>
      </body>
    </html>
  );
}
