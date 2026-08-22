/** 없는 레코드로 들어왔을 때. 검색으로 되돌리는 것이 읽기 UI의 유일한 할 일이다. */
export default function NotFound() {
  return (
    <>
      <h1>기록을 찾을 수 없다</h1>
      <p>요청한 ID의 기록이 없거나 접근할 수 없다.</p>
      <p>
        <a href="/">검색으로 돌아가기</a>
      </p>
    </>
  );
}
