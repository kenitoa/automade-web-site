# 고도화 반영 및 검증 기록

이 문서는 앞선 R01~R32 단계의 기록이다. 이후 E01~E32 확장의 최신 전체 검증은 [확장 구현 기록](expansion-implementation.md)에 있다. 현재 전체 테스트는 단위/통합152개·브라우저30개이며 실제 작업 공간 DB 업그레이드·백업/원본 보존도 확인했다. 아래93개/17개와 기존 결과물 경로는 당시 검증 증거로 유지한다.

2026-10-07. 공개 배포 대상·AI·메일/CRM·결제 공급자는 사용자 답변대로 미정이다. 기존 편집 화면과 공통 생성 런타임을 유지하고 로컬 기능·영속 저장·실제 연결 설정을 구현한다. 외부 성공을 가장하지 않으며 공급자별 어댑터·비밀 환경·실환경은 분리해 기록한다.

## 전체 요구사항 반영

| ID | 구현 내용 | 확인 위치 |
|---|---|---|
| R01 | 목적·방문자·행동·분위기·자료 안내, 건너뛰기 | ProjectWizard, editor-upgrade E2E |
| R02 | 템플릿 구조 유지/추천, 초안 변경 검토 후 적용 | generationAdapter, ProjectWizard |
| R03 | 기존8메뉴, 완성 체크리스트, 기본/고급 설정 | Studio, ToolPanel, Inspector |
| R04 | 썸네일·최근·즐겨찾기·검색 빈 상태·목적 조합 | LibraryPanels, Workspace |
| R05 | 복제·계층·순서·이동·키보드·스타일 복사 | commands, LayerPanel, Workspace |
| R06 | 혼합값·일괄 수정·그룹 undo | EnhancedInspector, useStudio, E2E |
| R07 | 테마 상속/지정·타이포그래피·버튼·복원 | enhancements, runtime, Inspector |
| R08 | 기기별 예외·연속 너비·읽기 순서·패널 제어 | runtime styles, Workspace, E2E |
| R09 | 키보드 대안·포커스 모달·오류·움직임 감소 | EditorDialog, SiteApp, E2E; 실기기 보조기술 미검증 |
| R10 | 직접 편집·안전 문단·CMS 발행·언어별 텍스트 | ContentPanel, content, SiteApp |
| R11 | 시그니처·최적화·교체·원본·사용처·초점·출처 | assets, LibraryPanels, imageSettings |
| R12 | 행동 대상·시험·폼 동의·완료 메시지/대상·문의 분류 | Inspector, SiteApp, siteServer |
| R13 | 열 규칙·CSV 열 매핑·수정 충돌·페이지·이력 | TableImport, content, tableHistory, tableQuery |
| R14 | 실제 표 연결 차트·단위·빈 상태 | chartBinding, SiteApp, enhancements tests |
| R15 | 범위별 AI 검토·전송 최소화·허용 필드·요청/비용 한도 | AIAssistant, proposals, generationBudget; 실제 AI 미설정 |
| R16 | 품질 영향·필드 포커스·안전 수정 검토·폭 비교 | validation, quality, ToolPanel, E2E |
| R17 | 페이지 SEO·공유·대표 주소·사이트맵·주소 이전·언어 주소 | seo, document, generator; 검색엔진 실색인 미검증 |
| R18 | 로컬/서버 상태·충돌 비교·원본 내보내기·백업 차이 | useStudio, LibraryPanels |
| R19 | 활성 lease·영속 작업/요청 키·취소·재시작·재시도 | OperationsStore/Service, operations tests |
| R20 | 생성/운영 저장 분리·온라인 백업·복원·디자인 롤백·가역 보존 | OperationsService, RetentionService, retention tests |
| R21 | 구성/버전/품질/상태·독립 소스 재빌드 | generator, build-generated, verify-delivery |
| R22 | 종료 사이트 문의·검색·상태·태그·메모·CSV·마스킹 | OperationsPanel, OperationsService |
| R23 | 배포 준비/시험·HTTPS 주소·릴리스/버전/해시·롤백 | DeploymentService/Panel, Docker 파일; 원격/Docker 미검증 |
| R24 | 회원·로그인/로그아웃·일회용 복구·역할·소유권·초대 | platform/auth, PlatformWidgets, platform tests |
| R25 | 변경 감사·버전 충돌·검토 댓글·자기 승인 차단 | platform/reviews, PlatformPanel; 편집기 공개 협업은 로컬 범위 밖 |
| R26 | 허용 호스트·비밀 참조·연결 시험·중지·재시도 | platform/connections, PlatformPanel |
| R27 | 저장 후 outbox·공급자 수락 구분·데이터 매핑/캐시/표 검토 적용 | connections, siteServer, ExternalDataImport |
| R28 | 상품/재고·서버 주문·서명 이벤트·취소/부분 환불·대사 | platform/business; 실제 결제 미설정 |
| R29 | UTC 자원/슬롯·정원·중복·취소 | platform/business, PlatformWidgets, browser/API tests |
| R30 | 사이트 거래와 플랫폼 구독 분리·로컬 플랜·실제 사용량 | platform/billing, generation/storage limits; 실제 청구 미설정 |
| R31 | 실제 제작 이벤트·생성 성공률·시간·운영 수치·개인정보 제외 | telemetry, operations metrics, OperationsPanel |
| R32 | 환경 예제·추가 migration·문서·프로덕션 빌드·독립 검증 | .env.example, migrations0002~0004, docs, scripts |

## 검증 범위

타입·린트·단위/통합·Chromium E2E·프로덕션 빌드·독립 결과물 검증의 최종 결과는 아래에 기록한다. 중간 테스트 실행을 최종 완료로 간주하지 않는다. 스크린샷은 데스크톱 편집 구조와 작은 화면 패널, 모바일 CMS 레이아웃을 확인한다.

자동 검사에는 populated v1 DB 마이그레이션과 업그레이드 전 백업, 영속 작업 재시작, 문의 저장 후 재생성/과거 실행/종료 조회/운영 복구, 권한·CSRF·SSRF·회원 HTML 비노출·로그아웃 제거, 주문 금액·재고·이벤트 중복/역순·환불·예약 경합, 표 고유/읽기 전용·수정 충돌/이력, 보존 경로/가역 복구, 배포 멱등성과 실제 헬스 불일치를 포함한다.

공급자 transport 테스트는 계약을 검증하며 실제 AI 품질·메일 수신·CRM 반영·결제 정산·플랫폼 청구·공개 배포 성공의 증거가 아니다. 수동 휴대폰·스크린리더·실사용자·검색엔진·장기 운영/복구 훈련은 미검증이다. 보존 격리는 영구 삭제하지 않아 물리 용량을 줄이지 않는다.

## 최종 실행 결과

Windows · Node v22.22.3에서 2026-10-07 최종 통합 검증을 실행했다. 마지막 outbox lease 경쟁 수정까지 포함한 결과다.

| 명령 | 결과 |
|---|---|
| `npm.cmd run typecheck` | 성공 |
| `npm.cmd run lint` | 성공 |
| `npm.cmd test` | 93/93 성공, 실패·건너뛰기 0 |
| `npm.cmd run build` | 성공, 편집기와 독립 서버 프로덕션 빌드 |
| `npm.cmd run test:e2e` | Chromium 17/17 성공, 29.0초 |
| `npm.cmd run verify:delivery` | 성공, 별도 결과물 설치·타입·린트·테스트·재빌드·포함 Node 독립 실행·페이지 경로·실제 폼 저장 |
| `npm.cmd audit --audit-level=high` | 알려진 취약점 0 |
| `git diff --check` | 성공 |

최종 독립 결과물은 `exports/verified-delivery/b5448271-34b4-45ed-92f6-c1c126637cac/`이다. 생성 검증 시각은 `2026-10-07T13:03:08.197Z`이며 상세 명령 결과는 `.data/delivery-verification.json`에 기록했다. 전체 테스트·브라우저·독립 패키지 로그는 각각 `.data/upgrade-test.log`, `.data/upgrade-e2e.log`, `.data/upgrade-delivery.log`에 있다. 브라우저 보고서는 `test-results/playwright-report/`, 작은 화면 속성 패널 확인 이미지는 `test-results/editor-upgrade-narrow.png`이다.

기존 운영 DB는 초기화하지 않았다. 새 migration 0002~0004는 시작 시 기존 기록 뒤에 적용하며, 데이터가 있는 기존 DB는 적용 전 SQLite 백업을 만든다. populated v1 이전·백업 보존은 임시 DB 통합 테스트로 검증했다. 실제 사용자 DB의 마이그레이션 실행 여부와 별개다. 새로운 의존성·lockfile 변경은 없다.

이 PC에 Docker 실행기가 없어 실제 컨테이너 실행은 미검증이다. GitHub 원격 CI, 실제 공급자, 공개 HTTPS 배포 및 위에 명시한 실기기·장기 운영 검증은 실행하지 않았다. 외부 공급자를 정한 뒤 문서의 계약·환경 변수로 연결하고 실환경에서 확인해야 한다.
