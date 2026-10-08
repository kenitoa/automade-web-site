# 검증

## 2026-10-09 H01~H48 최종 로컬 검증

`npm.cmd run verify:system`이 종료 코드 0으로 완료됐다. Windows x64, Node 22.22.3, Ryzen 7 4800H/16GB 환경의 결과이며, 검증 시작·종료 소스와 빌드 해시가 모두 `e456ff057ff9d638305e896686dd1ac0400a8116b5e771cd76c0123a9c3dabe2`로 일치했다. Git commit은 미주입 상태인 `null`이며 공개 배포 SHA 검증과 구분한다.

| 검증 명령 | 결과 |
|---|---|
| `npm.cmd run typecheck` | 통과 |
| `npm.cmd run lint` | 통과 |
| `npm.cmd test` | 단위/통합 227/227 통과 |
| `npm.cmd run build` | 통과; 메인 JS 535.52kB(gzip 163.46kB) 크기 경고 있음 |
| `npm.cmd run test:e2e` | Chromium 42/42 통과 |
| `npm.cmd run verify:delivery` | 독립 결과물 설치·타입·린트·테스트·재빌드·포함 Node 실행·페이지·실제 폼 저장 통과 |
| `npm.cmd run system:benchmark -- --seconds 10 --records 10000` | 인덱스 조회 582회, 29,100행, 실패 0 |
| `npm.cmd run system:drill` | 격리 프로세스/SQLite 장애 훈련 4/4 통과 |
| `npm.cmd audit --audit-level=high` | 알려진 취약점 0 |
| `git diff --check` | 통과; Git의 CRLF 안내 경고 있음 |

전체 보고서는 `.data/system-verification.json`, 명령별 로그는 `.data/system-verification/`에 있다. 독립 결과물은 `exports/verified-delivery/ed196231-fad8-4b19-bbe9-21e140a40c5d/`, 실행 증거는 `.data/delivery-verification.json`이다. [H01~H48 구현 기록](system-implementation.md)과 [항목별 코드·검사 연결](system-evidence-matrix.json)에 구현 범위와 외부 조건을 기록했다. 파일 존재/전체 검사 통과 상태는 각 기능의 실운영 인수를 대신하지 않는다.

저장 충돌 회귀는 의미가 동일한 canonical CMS snapshot의 객체 키 순서 차이를 허용하고 실제 같은 revision의 내용 변조는 거절한다. 즉시 수정 후 생성 요청은 같은 저장 큐의 실제 서버 ACK와 동일한 원본을 사용한다. 브라우저 검사는 자동 저장 대기 우회 없이 팝업 차단 상태에서도 이를 검증했다. 별칭 릴리스의 물리 경로 중복과 다른 환경의 사용량 섞임, 이전 승격 실패가 더 최신 성공 승격을 되돌리는 경합도 회귀 검사로 확인했다.

CMS 부하의 p50/p95/p99는 17.07/18.45/18.99ms다. 이 측정은 동기 SQL 100회마다 양보하는 순차 배치이며 HTTP 큐 대기·제공자 지연을 포함하지 않는다. 같은 fixture의 event-loop p95/max는 1,785.72ms였으므로 운영 HTTP 응답 목표나 동시 처리 용량의 근거로 사용할 수 없다. 총 43.91초 중 조회 구간은 10초이며 나머지는 1만 건 준비다. DB/WAL은 52,801,536/45,262,352바이트, RSS는 약 81.0→177.8MB였다. 상세는 `.data/system-capacity.json`이다.

최종 300블록 편집기 측정의 DOM 이벤트→두 번째 animation frame p95는 입력 36.2ms/키보드 26.9ms로 해당 로컬 fixture의 100ms 목표를 충족했다. 자동화 왕복을 포함하면 119.9/124.9ms다. DOM 4,703개, 사용 JS heap 47.4MB이며 화면 밖 선택과 전체 원본 내보내기를 보존했다. 다른 크기의 선택 측정과 실기기 경계는 [편집기 기록](system-editor-implementation.md)을 따른다.

기존 실제 작업 DB는 적용 전 온라인 백업 `studio.sqlite.before-system-upgrade-2026-10-08T14-32-15.224Z-d80696aa-1393-4a8a-87cf-e4aec07fc288.sqlite`(847,872바이트)를 보존했다. 백업 `integrity_check=ok`와 프로젝트·제출 지문을 확인한 뒤 migration8→15를 적용했다. 기존 프로젝트 1건/제출 0건 및 원시 id·revision·body/제출 SHA256이 적용 후와 서버 기동 후 모두 동일했다. 증거는 `.data/system-backup-verification.json`, `.data/system-live-before.json`, `.data/system-live-after.json`이다.

http://127.0.0.1:5173/ 에서 최신 production 빌드의 UI·local-owner 세션·기존 프로젝트 조회·`/health` 소스 해시·`/ready`를 확인했다. `start-site.cmd`의 launcher가 같은 서버를 재사용하며 브라우저를 여는 것도 확인했다. `.data/system-live-verification.json`에 generator 2.1.0과 동일 빌드 해시를 기록했다.

실제 AI/메일/CRM/결제, 공개 HTTPS/DNS/배포 SHA, 원격 CI 보호 승인, Docker/Linux·다중 호스트·외부 DB/객체 저장소/큐, 다른 물리 장비 복원, 악성 파일 검사 공급자, 실기기/스크린 리더/실제 인증 앱, 장기 부하·운영 RPO/RTO는 별도 미검증이다. SQLite quota 오류 주입은 OS 디스크 고갈과 구분하며, 이미지 worker의 JS heap 제한은 native OS 메모리 강제 제한을 대신하지 않는다.

타입·린트·단위/통합 테스트·프로덕션 빌드를 실행합니다. Playwright는 빌드된 프로덕션 서버에서 프로젝트 생성/저장/복구, 반응형 화면, 원클릭 새 탭, 폼/표 저장, CSV, 모달/탭/차트, 팝업 차단, 요청 보안을 확인합니다.

verify:delivery는 별도 결과의 npm ci·타입·린트·테스트·재빌드, 포함된 Node 독립 실행·UI/health·데이터 저장을 확인합니다. 결과는 .data/delivery-verification.json입니다. test-results/playwright-report에 브라우저 결과를 기록하며 [trace 확인](https://playwright.dev/docs/trace-viewer)을 지원합니다.

자동 검사는 모든 디자인을 증명하지 않습니다. 실제 휴대폰·스크린리더·외부 사용자 평가·외부 생성 공급자·결제·공개 클라우드는 별도 미검증 항목입니다. 계정이 없는 연동을 완료로 표시하지 않습니다.

최종 실행 기록은 완료 보고와 이 문서에 추가합니다.

## 2026-10-05 Windows 검증 기록

Node22.22.3에서 타입 검사·린트·32개 단위/통합 테스트·프로덕션 빌드가 통과했습니다. 프로덕션 서버의 Chromium E2E 6개가 통과했습니다. 별도 산출물의 npm ci·타입·린트·테스트·재빌드와 포함된 Node 독립 실행, 공개 페이지 경로, 실제 폼 저장을 확인했습니다. npm audit의 알려진 취약점은 0건입니다. GitHub CI는 작성했으며 원격 워크플로 실행은 미검증입니다.

## 2026-10-07 고도화 최종 검증

기존 편집 구조를 유지한 32개 기획 항목의 구현과 연결 설정을 반영했습니다. Node v22.22.3에서 `npm.cmd run typecheck`, `npm.cmd run lint`, `npm.cmd test`(93/93), `npm.cmd run build`, `npm.cmd run test:e2e`(Chromium 17/17), `npm.cmd run verify:delivery`, `git diff --check`가 통과했습니다. `npm.cmd audit --audit-level=high`의 알려진 취약점은 0건입니다.

독립 결과물은 설치·재빌드·포함 Node 실행·페이지 경로·실제 폼 저장까지 검증했습니다. 기존 DB 마이그레이션/백업, 운영 데이터 보존·복구, 권한과 회원 콘텐츠, 주문·예약 경합, 외부 응답 경쟁, 표 충돌·이력과 배포 상태는 단위/통합·브라우저 검사로 확인했습니다.

[고도화 항목별 구현 위치와 최종 증거](upgrade-verification.md)에 결과물 경로와 로그를 기록했습니다. 공급자·배포 대상은 미정이므로 실제 AI·메일/CRM·결제·공개 배포는 미검증입니다. Docker는 이 PC에 설치되지 않아 컨테이너 실행을 확인하지 못했습니다. 실기기·스크린리더·실사용자·장기 운영 검증도 별도로 필요합니다.

## 2026-10-07 확장 E01~E32 최종 검증

앞선 R01~R32와 기존 편집 틀을 보존한 확장 기획32개를 반영했습니다. 최신 전체 `npm.cmd run typecheck`, `npm.cmd run lint`, `npm.cmd test`(152/152), `npm.cmd run build`, `npm.cmd run test:e2e`(Chromium30/30), `npm.cmd run verify:delivery`가 통과했습니다. 알려진 의존성 취약점은0건이며 새 의존성·lockfile 변경은 없습니다.

독립 결과물 `exports/verified-delivery/4e30eeb7-a48e-4367-af22-cad1cbb19d24/`는 자체 설치·재빌드·포함 Node 실행·페이지 경로·실제 폼 저장을 검증했습니다. 실제 작업 공간 DB도 적용 전 온라인 백업을 만들고 migration1에서1~8로 업그레이드했습니다. 기존 프로젝트/제출 건수와 원본 ID/revision/body·제출의 SHA256 지문이 동일함을 확인했습니다. 최신 로컬 서버는 http://127.0.0.1:5173/ 에서 UI·세션·기존 프로젝트 조회가 정상입니다.

[E01~E32 전체 구현 위치·검증 기록·백업·운영 경계](expansion-implementation.md)에 최종 로그와 미검증 범위를 기록했습니다. 이 검사는 Windows 단일 호스트의 실제 worker/공유 DB 경쟁, 로컬 공급자 fixture, 격리된 managed HTTPS 브라우저 검사입니다. 실제 외부 AI·메일/CRM·결제·공개 배포, Docker/다중 호스트/PostgreSQL, 장기 부하와 실기기·스크린리더·외부 사용자 검증은 포함하지 않습니다.
