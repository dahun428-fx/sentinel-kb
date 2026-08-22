/**
 * core-api 호출 실패 표시.
 * 설정 오류(키 없음)와 "결과 없음"이 화면에서 구분되어야 한다 — 둘을 섞으면
 * 검색이 조용히 죽어도 아무도 모른다.
 */
export function ErrorBox({ title, code, message }: { title: string; code: string; message: string }) {
  return (
    <div className="error-box" role="alert" data-testid="error-box">
      <p>
        <strong>{title}</strong>
      </p>
      <p className="body-text">{message}</p>
      <p className="muted">코드: {code}</p>
    </div>
  );
}
