# 보안 경계

기본은 loopback 전용 단일 소유자 도구입니다. 인터넷에 편집기를 그대로 공개하지 마세요. 로컬 세션은 회원 로그인을 대체하지 않습니다. OS 폴더 권한과 디스크 보안을 적용하세요.

Host·Origin·Sec-Fetch-Site, HttpOnly·SameSite 쿠키, CSRF, 요청 크기/속도 제한을 확인합니다. 경로 정규화와 realpath containment로 외부 탈출을 거부합니다. 정적 서버는 dist만 제공하고 dotfile을 차단합니다. HTTP 파일맵/저장 경로는 허용하지 않습니다.

React 텍스트 이스케이프와 안전한 JSON 삽입을 적용합니다. 링크 프로토콜과 자격정보를 검증합니다. 이미지 MIME·헤더·실제 바이트 시그니처·개별5MB/총20MB를 검사합니다. SVG와 HTML 원문 실행은 제공하지 않습니다.

외부 생성은 환경 변수의 HTTPS 호스트만 허용합니다. 사설/루프백/링크 로컬/IPv4 매핑 주소를 거부하고 검증한 DNS 주소에 연결을 고정합니다. API 키는 프론트엔드에 전달하지 않습니다. 공급자 응답을 런타임 스키마로 검사합니다.

로그는 operation/resourceId/status/time과 HTTP requestId/path/duration/status를 사용합니다. 폼 원문·쿠키·API 비밀값은 로그에 기록하지 않습니다. 공급자 오류는 고정 메시지로 변환합니다. 테스트 trace에는 테스트 데이터만 사용하세요.

표 편집은 로컬 기능입니다. 공개 서비스에는 사용자 인가 없이 수정 API를 공개하면 안 됩니다. 외부 운영 전 TLS·사용자/관리자 인증·서버 인가·문의 보존/삭제·비밀 관리와 보안 검토가 필요합니다.

Node22 node:sqlite는 실험 상태 경고를 출력합니다. [Node 공식 문서](https://nodejs.org/docs/latest-v22.x/api/sqlite.html)를 참고하고 업그레이드 때 통합 테스트를 실행하세요.
