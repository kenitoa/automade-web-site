# 실행과 복구

start-site.cmd는 lock 해시 확인·의존성 설치·빌드 후 기존 원본 주소인 5173 포트(사용 중이면 동적 포트)에 실행합니다. workspaceId·health·UI 준비를 확인한 뒤 브라우저를 엽니다. 정상 서버는 재사용하며 URL을 실행 창과 .data/running.json에 남깁니다. 개발 주소는 http://127.0.0.1:5173/ 입니다.

설정은 PORT(0 또는1..65535), DATA_DIR, EXPORT_DIR, AUTOMADE_ROOT, GENERATION_API_URL/HOST/KEY입니다. .env는 서버 시작 시 읽고 커밋하지 않습니다. 외부 생성은 HTTPS와 호스트 일치를 조기 검사합니다.

npm run build 후 npm start로 실행합니다. 정적 파일만 배포하면 저장 API가 없어집니다. 생성 결과는 site-server.mjs와 원본을 함께 실행하세요. [Vite 배포 안내](https://vite.dev/guide/static-deploy.html)는 프론트엔드 범위의 참고입니다.

같은 OS/아키텍처에는 포함된 Node 실행파일로 결과 폴더를 실행합니다. 다른 OS에는 해당 Node22.16 이상을 설치하고 output의 npm start를 사용하세요. 소스 수정은 npm ci → 타입/린트/테스트 → build입니다. 원본으로 공개 페이지 HTML을 다시 만들고 새 dist로 승격하며 이전 dist는 숨김 백업으로 남깁니다.

CI는 Windows/Linux 검증을 제공합니다. 배포 계정/대상이 없으므로 외부 자동 배포 성공으로 표시하지 않습니다.

오류 시 설치/Node/네트워크 확인, 품질·운영 패널의 작업ID 확인, 팝업 차단은 결과 링크 사용, 원본 충돌은 내보낸 후 최신본 다시 열기, DB 장애는 실행 종료 후 백업 복원을 사용하세요. 실패 staging을 실행하거나 DB를 초기화하지 않습니다. 서버 재시작 후 완료 결과는 운영에서 다시 실행합니다.

공개 클라우드 운영에는 계정·도메인·TLS·회원/관리자 인가·영속 볼륨·백업/복구·공개 API 정책이 필요합니다. localhost 검증은 공개 배포 증거가 아닙니다.
