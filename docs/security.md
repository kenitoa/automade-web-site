# 보안 경계

기본 local은 loopback 전용 소유자 도구입니다. 공개 제작자 운영에는 명시적 managed 모드·정확한 HTTPS origin·중앙 creator 인증/서버 ACL을 사용합니다. local-owner는 사설 IP나 managed loopback으로 얻지 못합니다. 제작자 계정과 사이트 방문자 계정은 분리합니다. OS 폴더 권한과 디스크 보안을 적용하세요.

Host·Origin·Sec-Fetch-Site, HttpOnly·SameSite 쿠키, CSRF, 요청 크기/속도 제한을 확인합니다. 경로 정규화와 realpath containment로 외부 탈출을 거부합니다. 정적 서버는 dist만 제공하고 dotfile을 차단합니다. HTTP 파일맵/저장 경로는 허용하지 않습니다.

React 텍스트 이스케이프와 안전한 JSON 삽입을 적용합니다. 링크 프로토콜과 자격정보를 검증합니다. 이미지 MIME·헤더·실제 바이트 시그니처·개별5MB/총20MB를 검사합니다. SVG와 HTML 원문 실행은 제공하지 않습니다.

외부 생성은 환경 변수의 HTTPS 호스트만 허용합니다. 사설/루프백/링크 로컬/IPv4 매핑 주소를 거부하고 검증한 DNS 주소에 연결을 고정합니다. API 키는 프론트엔드에 전달하지 않습니다. 공급자 응답을 런타임 스키마로 검사합니다.

로그는 operation/resourceId/status/time과 HTTP requestId/path/duration/status를 사용합니다. 폼 원문·쿠키·API 비밀값은 로그에 기록하지 않습니다. 공급자 오류는 고정 메시지로 변환합니다. 테스트 trace에는 테스트 데이터만 사용하세요.

Studio 로그 경로는 알려진 라우트와 :id로 제한하고 query를 제거합니다. child stdout은 제한된 구조화 필드만 전달하며 임의 stderr를 요청 로그로 복사하지 않습니다. X-Request-ID는 응답과 감사/진단에서 추적에 사용합니다. 제작자 세션은 해시로 저장하며 logout/역할 회수/credential issuer 검증을 실제 서버에서 적용합니다.

공개 사이트는 scrypt 회원 인증·HttpOnly 세션·CSRF·프로젝트 역할·소유권을 서버에서 검사합니다. 일회용 비밀번호 재설정과 초대 토큰은 해시로 저장하며 만료를 적용합니다. 공개 바인딩에는 정확한 HTTPS origin과 관리자 환경 설정이 필요합니다. 표 쓰기·이력·회원 전용 API·주문/예약 조회에도 권한을 적용합니다. 로컬 소유자 기능은 loopback에 한정됩니다. 실제 TLS 프록시와 비밀 관리는 배포 대상 선정 후 확인합니다.

AI 제안은 선택 콘텐츠의 전송 범위를 안내하고, 원문 운영 데이터·이미지·브리프를 줄여 전달합니다. 서버는 제안에서 운영 데이터·권한·잠금·폼 규칙·버튼 연결 등 허용하지 않은 변경을 제거하고 구조를 다시 검사합니다. 외부 연결은 HTTPS 호스트 allowlist·고정 DNS·timeout·응답 한도·환경 변수 비밀 참조를 사용합니다. 공개 배포 헬스에는 API 비밀값을 보내지 않습니다.

결제는 클라이언트 성공 상태를 신뢰하지 않고 서명된 이벤트/공급자 대사를 검사합니다. HMAC 서명·5분 시간 범위·이벤트 중복/역순·통화/금액·부분 환불 합계를 확인합니다. 공급자 타임아웃은 불명확한 상태로 남길 수 있으며 재발행 전에 수동 대사가 필요합니다. 백업/원본/배포 패키지는 개인정보·회원 콘텐츠를 포함할 수 있으므로 공개 정적 폴더 밖에서 제한된 운영자만 취급합니다.

보존 정리는 realpath로 검증한 파일을 같은 저장소의 격리 폴더로 이동하며 영구 삭제하지 않습니다. 원본 마스킹은 복구할 수 없는 작업이므로 UI의 범위 확인이 필요합니다. 로그에는 값·토큰·쿠키를 남기지 않고 작업 ID·상태·오류 코드만 기록합니다.

조직·workspace·project·environment를 서버에서 재검증하고 원본/CSV/ZIP/blob/백업/작업에도 ACL을 적용합니다. API 키와 webhook은 scope·발급자·만료·회수·원문 서명·시간·중복을 검사합니다. 결제 공급자 callback은 제작자 쿠키 없이 raw body 서명으로 인증하고 반드시 project/environment 범위를 지정합니다. 다른 JSON API는 creator/local 세션과 CSRF를 요구합니다.

vault 비밀은 EXPANSION_SECRET_KEY로 암호화하고 읽기/교체/회전/사용 감사를 남깁니다. 로컬 자동 키는 DATA_DIR 내부의 검증된 경로에서 exclusive 생성해 재사용합니다. 0600 생성 모드는 Windows 사용자 ACL 강화의 증거가 아니므로 운영자가 폴더 ACL·키 백업을 관리합니다. 중앙 AUTH_* 및 다른 조직 비밀은 managed 사이트 worker에 전달하지 않습니다.

관리형 고위험 변경은 비밀번호·TOTP/일회용 복구 코드와 작업 method/path/scope/본문에 묶인 일회용 step-up proof를 요구합니다. 조직/권한/키/복원/배포뿐 아니라 결제 연결 설정과 환불에도 적용합니다. 환경 비밀은 시험된 활성 버전만 해석하며 등록됐지만 inactive인 참조는 local에서도 이전 조직 키나 process 환경 변수로 대체하지 않습니다. 새 파일은 격리/private 상태이며 승인/public 전에는 공개 생성·독립 산출물에서 차단합니다. malware scanner는 미설정이며 검사 완료로 표시하지 않습니다. 상세 API·키 보관·검증 경계는 [운영 서버 고도화 기록](system-backend-implementation.md)을 확인하세요.

소스 내보내기는 중앙 세션/비밀/키/실제 운영DB를 제외합니다. 운영 DB 이전은 별도 backup.restore 권한이 필요하며 SQLite 헤더·SHA·schema/FK·귀속·실행 SQL을 검사합니다. 복원 후 결제/환불/예약 차이는 보류 상태로 남겨 중복 외부 실행을 막습니다. immutable workflow snapshot과 actor/lease 검증은 권한 회수 또는 늦은 worker 결과의 반영을 차단합니다.

blob 업로드·승인은 격리된 Sharp worker에서 네 형식의 실제 픽셀과 애니메이션 전체를 디코딩합니다. 8MB·총 4000만 픽셀·128프레임·16000 변 길이·시간 제한을 적용하며 worker 환경에 인증 비밀을 상속하지 않습니다. 서버 변형본은 EXIF/XMP/ICC를 제거하고 첫 프레임 정적 PNG/WEBP로 저장하며 자체 격리 검토를 받습니다. 원본 바이트와 메타데이터는 보존됩니다. [이미지 처리 결정](adr/0003-server-image-processing.md)에 native 메모리·CPU 측정·라이선스 경계를 기록했습니다.

Node22 node:sqlite는 실험 상태 경고를 출력합니다. [Node 공식 문서](https://nodejs.org/docs/latest-v22.x/api/sqlite.html)를 참고하고 업그레이드 때 통합 테스트를 실행하세요.
