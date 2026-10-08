# 실행과 복구

start-site.cmd는 lock 해시 확인·의존성 설치·빌드 후 기존 원본 주소인 5173 포트(사용 중이면 동적 포트)에 실행합니다. workspaceId·health·UI 준비를 확인한 뒤 브라우저를 엽니다. 정상 서버는 재사용하며 URL을 실행 창과 .data/running.json에 남깁니다. 개발 주소는 http://127.0.0.1:5173/ 입니다.

기본 설정은 PORT(0 또는1..65535), DATA_DIR, EXPORT_DIR, AUTOMADE_ROOT입니다. .env는 서버 시작 시 읽으며 .env와 .env.*는 커밋하지 않습니다. .env.example은 키 이름만 제공합니다. 외부 생성은 GENERATION_API_URL/HOST/KEY의 HTTPS·호스트 일치를 조기 검사합니다.

GENERATION_MONTHLY_LIMIT(기본1000), GENERATION_REQUEST_COST_MINOR, GENERATION_SPEND_LIMIT_MINOR, GENERATION_CURRENCY는 요청 수와 **예상** 비용 한도입니다. 비용 한도는 요청당 추정값 설정이 필요하며 실제 공급자 청구 증거가 아닙니다. PLATFORM_ALLOWED_HOSTS는 명시적 HTTPS 호스트 목록입니다. 각 연결에는 비밀값 대신 서버 환경 변수 이름을 저장합니다. 결제는 API 비밀과 webhook 서명 비밀을 별도로 설정합니다.

생성 사이트의 SITE_HOST(기본127.0.0.1), SITE_PORT(기본0), SITE_PUBLIC_ORIGIN, SITE_DATA_FILE, SITE_ACTIVE_RELEASE_ID, SITE_DEPLOYMENT_SHA256와 관리자 환경은 [공개 배포](public-deployment.md)에 설명되어 있습니다. 공개 Host는 HTTPS 프록시의 정확한 Host와 일치해야 합니다. 제작자는 아래 명시적 관리형 모드로 배포하며 생성 사이트와 인증 realm을 분리합니다.

npm run build 후 npm start로 실행합니다. 정적 파일만 배포하면 저장 API가 없어집니다. 생성 결과는 site-server.mjs와 원본을 함께 실행하세요. [Vite 배포 안내](https://vite.dev/guide/static-deploy.html)는 프론트엔드 범위의 참고입니다.

같은 OS/아키텍처에는 포함된 Node 실행파일로 결과 폴더를 실행합니다. 다른 OS에는 해당 Node22.16 이상을 설치하고 output의 npm start를 사용하세요. 소스 수정은 npm ci → 타입/린트/테스트 → build입니다. 원본으로 공개 페이지 HTML을 다시 만들고 새 dist로 승격하며 이전 dist는 숨김 백업으로 남깁니다.

CI는 Windows/Linux 검증을 제공합니다. 배포 계정/대상이 없으므로 외부 자동 배포 성공으로 표시하지 않습니다.

오류 시 설치/Node/네트워크 확인, 품질·운영 패널의 작업ID 확인, 팝업 차단은 결과 링크 사용, 원본 충돌은 내보낸 후 최신본 다시 열기, DB 장애는 실행 종료 후 백업 복원을 사용하세요. 실패 staging을 실행하거나 DB를 초기화하지 않습니다. 서버 재시작 후 완료 결과는 운영에서 다시 실행합니다.

운영 백업은 화면의 백업·복원 또는 SQLite 온라인 백업을 사용합니다. 복원은 현재 문의·회원·주문·예약·표 등 운영 DB를 선택 시점으로 교체하므로 범위를 검토하고 직전 자동 백업을 확인합니다. 디자인만 되돌리려면 릴리스의 디자인 복원 기능을 사용합니다. 보존 관리의 가역 격리는 파일을 삭제하지 않습니다.

공개 운영용 코드·연결 설정·독립 Docker 파일은 구현되어 있습니다. 공급자·계정·도메인·TLS 설정은 미정이므로 실배포/실메일/실거래/Docker 컨테이너 실행은 별도 미검증입니다. Windows localhost와 모의 공급자 계약 검증은 공개 배포 증거가 아닙니다.

## 제작자 운영 모드

기본 local은 STUDIO_HOST를 loopback에 한정합니다. managed는 `APP_MODE=managed`, 정확한 HTTPS `STUDIO_PUBLIC_ORIGIN`, `STUDIO_ADMIN_EMAIL`/`STUDIO_ADMIN_PASSWORD`를 설정해야 시작합니다. `STUDIO_HOST`는 역방향 프록시의 내부 bind 주소입니다. 프록시가 정확한 공개 Host를 전달하고 HTTPS를 종료해야 Secure 제작자 쿠키가 동작합니다. `STUDIO_ALLOW_REGISTRATION=true`로 공개 가입을 명시적으로 허용하거나 조직 초대를 사용합니다. 관리자 환경은 초기 계정 생성에만 쓰며 기존 비밀번호를 시작 때마다 덮어쓰지 않습니다.

사이트 미리보기 worker는 로컬 loopback 주소를 반환합니다. 원격 팀에 공개 미리보기/사이트 URL을 제공하려면 환경의 배포 연결에 별도 origin·도메인·TLS를 구성하고 공개 릴리스의 health/revision/release/hash를 검증하세요. 로컬 worker의 주소가 원격 브라우저에서도 접근 가능한 주소라는 뜻은 아닙니다.

로컬 vault는 `.data/keys/expansion.key`를 한 번 생성해 재사용합니다. 관리형은 별도의 비밀 관리에서 64자리 hex `EXPANSION_SECRET_KEY`를 주입합니다. 키와 DATA_DIR/중앙 blob을 별도 백업하고 접근권한을 설정하세요. 키 자체는 프로젝트 원본/ZIP/운영 DB 이전에 포함하지 않습니다. 환경변수 `TENANT_*` 참조 또는 조직/workspace vault 연결은 서버에서만 해석하며 사이트 worker에는 선택 환경의 실제 연결 참조만 전달합니다.

master key 회전에는 `EXPANSION_SECRET_KEYS`(keyId→64자리 hex 키 JSON map)와 `EXPANSION_ACTIVE_KEY_ID`를 서버 비밀 관리로 주입합니다. 활성 키 설정 후 같은 회전 작업 ID로 제한된 재암호화 배치를 재개합니다. DB의 재암호화가 완료되어도 과거 BackupSet의 keyIds가 요구하는 구 키는 별도로 보관합니다. 관리형 운영자는 먼저 인증 앱과 복구 코드를 등록하고 고위험 변경에 일회용 step-up을 사용합니다. 추가 migration9~15 및 [운영 서버 고도화 기록](system-backend-implementation.md)의 복구/외부 검증 경계를 함께 확인하세요.

중앙 제작자 비밀번호 복구 메일은 `STUDIO_MAIL_ENDPOINT`, `STUDIO_MAIL_ALLOWED_HOST`, `STUDIO_MAIL_SECRET_REF`를 함께 설정합니다. secret ref는 `AUTH_*` 서버 환경변수이며 방문자 사이트 연동과 분리합니다. 미설정 상태를 발송 성공으로 표시하지 않습니다. HTTPS 게이트웨이·배송 계약·실제 수신 여부는 선택한 공급자로 검증해야 합니다.

`WORKER_CONCURRENCY`는 영속 큐의 전체 실행 한도(기본2,1~16), `WORKER_TIMEOUT_MS`는 작업 제한(기본180000,1000~900000)입니다. 생성/사이트/자동화는 각각 별도 Node 프로세스에서 실행합니다. 큐/리소스 lease는 SQLite에 남으며 여러 로컬 coordinator의 중복 실행·늦은 결과를 차단합니다. 같은 DB를 공유하는 coordinator에는 같은 한도 설정을 사용하세요. SQLite 파일 공유를 다중 호스트 운영으로 간주하지 않습니다.

관리형 도입 순서는 기존 DB 온라인 백업 → 새 코드 build/type/lint/test → 기존 serving/DB 핸들 종료 → 현재 버전까지의 추가 migration(기존1~8 보존, 고도화9~15) 적용 → creator 권한/CSRF/서로 다른 조직 접근 검증 → 환경별 실제 배포 → health/version/hash 확인입니다. 원본과 연결 설정을 보존해 롤백하며 DB 파일은 이전 앱으로 직접 다운그레이드하지 않습니다.

이미지 검사/변형은 exact `sharp@0.35.5`와 `dist-service/image-worker.mjs`를 사용합니다. 배포 대상 OS/CPU에서 기존 lockfile로 `npm ci`를 실행해 해당 native optional 패키지를 설치하고 이미지 worker를 build manifest와 함께 배포합니다. 다른 OS의 node_modules를 복사하지 않습니다. 전체 개발 소스의 package/lock/SBOM에도 의존성이 들어가며 공개 사이트 실행 bundle은 이미지 코덱을 사용하지 않습니다. native 패키지의 LICENSE/README와 구성요소 고지를 유지합니다. Windows x64 실제 decode/resize는 검증했지만 Linux/컨테이너 설치는 아직 실행하지 않았습니다. native 메모리와 프로세스 동시 수 제한은 [이미지 처리 결정](adr/0003-server-image-processing.md)을 확인하세요.
