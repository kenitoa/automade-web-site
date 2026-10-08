# 확장 기획 전체 구현 계획

2026-10-07. 사용자가 E01~E32 기획 전체 반영을 승인했다. 기존 상단·8개 메뉴·캔버스·속성 패널과 원본→공통 런타임→독립 산출물을 보존한다. 공급자·배포 대상 미정이라는 앞선 답변은 유지한다. 로컬에서 실제로 저장·실행·복구되는 경로와 연결 계약을 구현하고, 실제 공급자·공개 운영·부하·다중 호스트 검증은 별도 증거로 기록한다.

## 변경 목적과 책임

개인 제작에서 여러 사이트·팀·확장 모듈·콘텐츠·연결 업무를 관리할 수 있게 만든다. 조직은 소유/권한 경계, workspace는 업무 분류, project는 제작 원본, site는 운영 단위, environment는 검수/운영 저장·연결·릴리스 경계이다. 기존 projectId/사이트 DB는 default organization/workspace/site/production environment로 편입하며 ID·운영 데이터·적용된 migration은 유지한다.

Presentation: 기존 editor/runtime와 세션·확장 UI. Application: ExpansionService, OperationsService, durable work queue, adapters. Domain: 등록형 블록·버전·CMS·공유 정의·조회/병합 규칙. Infrastructure: SQLite 추가 migration·blob 저장·실행 프로세스·HTTPS 연결·독립 산출물. 현재 디렉터리를 유지하고 실제 공통 사용처 없이 새 공유 패키지를 만들지 않는다.

## 전체 요구사항과 완료 기준

| ID | 구현 범위 | 완료 기준 |
|---|---|---|
| E01 | local/managed/standalone 책임·명시적 실행 모드 | 관리형은 중앙 creator 인증 필요; 내부 IP로 local-owner 자동승격 금지 |
| E02 | organization/workspace/project/site/environment 귀속 | 기존 ID·canonical DB 보존 이전; 모든 scope 서버 확인 |
| E03 | 다사이트 목록·담당·상태·브랜드·개별 적용/복구 | 여러 사이트 실제 CRUD·검색·필터·환경 상태; 복제에 방문자/비밀값 미포함 |
| E04 | 기존 메뉴 내 확장 작업 UI | workspace/site/env와 권한·검토 상태를 표시하고 실기능 연결 |
| E05 | Studio creator와 사이트 visitor 분리·세부 ACL | 역할 회수와 다른 조직 데이터/파일/백업/작업 접근 차단 |
| E06 | 16개 기존 블록 정의 등록·승인된 새 블록 | 목록/기본값/검사/속성/렌더링/참조/공개/내보내기 계약; 새 블록 독립 실행 |
| E07 | 문서/모듈/CMS/runtime/DB 버전과 pins | unsupported preflight 원본 보존; 검토 업그레이드·호환 범위 |
| E08 | 공용 component와 연결 instance | 영향 preview·선택 apply·개별 override 보존·연결 해제 |
| E09 | brand 디자인 토큰·draft/published 버전 | 사이트별 적용 승인·예외·이전 버전 보존 |
| E10 | 검증된 업종 pack·필수자료/기능/연결 | 실제 설치검토·버전·업데이트·부분 실패 복구; 운영 비밀 자동복제 금지 |
| E11 | 실제 파일 자산 저장·공용권한·원본/변형/사용처 | blob 업로드/읽기/교체/참조·private 접근·안전경로·이동/내보내기 |
| E12 | 타입 CMS field/reference/model | additive typed values·형식/고유/필수/참조검사·삭제/변경 영향 |
| E13 | review/approved/scheduled/published/archived workflow | 담당/예약·영속 실행·대량 idempotent upsert·디자인과 콘텐츠 발행 분리 |
| E14 | 서버 목록/검색/정렬/cursor·부분저장 | bounded query·안정 ID·CAS/변경 비교·큰 목록 전체 불필요 전송 방지 |
| E15 | BCP47 언어·지역·번역 상태/원문 변경 | 언어 주소/SEO·지역표시·번역 재검토·fallback 명시 |
| E16 | data binding·adapter/capability/schema/cache | 실제 조회/쓰기검사·상태/시각·총 timeout·중복/불명확 결과 구분 |
| E17 | 이벤트/조건/동작 automation | 실제 영속 실행/검토/재시도·순환/한도·부분 성공 보존 |
| E18 | scoped v1 API·credential·OpenAPI·signed webhooks | 기존 API 호환·만료/회수/범위/페이지·중복·서명·계약 검증 |
| E19 | pack/module install/update/pause/remove | 추가 권한/영향 검토·pins·자료보존·unsupported publish 차단 |
| E20 | 필드 검토/presence·부분 CAS/오프라인 동기화 | 사용자별 로컬 저장·three-way diff·조용한 덮어쓰기 금지·승인 버전 확인 |
| E21 | 주문후처리·옵션·예약 반복/휴일/대기·hold만료 | 실제 서버규칙/트랜잭션·정원/재고·확정/불명확 상태·provider contract |
| E22 | 목적별 AI task registry·전송/필드/한도 | 승인 scope·결과 runtime검사·허용권한 자료만·제안/채택/청구 분리 |
| E23 | 환경 DB/연결/릴리스·domain/preview·일괄배포 | env별 실제 isolation·영향검토·점진 처리·rollback 최신데이터 유지 |
| E24 | 편집/API와 생성/사이트 serving 자원 분리 | worker process·공개/private cache 경계·독립사이트 동작 |
| E25 | 저장소/트랜잭션 경계·DB 전환 조건/이관 | SQLite 로컬 유지·실제 검증 export/import·참조/건수/거래대사·무손실 복구; PostgreSQL 실운영은 선택/검증 조건 |
| E26 | durable queue·lease/fencing/heartbeat·공정성 | 동시 workers/강제종료/늦은결과/재시도·tenant별 waiting/running 한도 |
| E27 | entitlements·usage reservation/commit/cancel | 실제 이벤트/물리용량·초과 새비용작업 제한·필수대사/복구 유지 |
| E28 | scope metrics·실제 restore 검증·runbooks | queue/외부unknown/백업 상태·추적 ID·복원후 중복/거래대사 |
| E29 | org 수명주기·인계·세션회수·secret audit | 고객거래보존·마지막owner·기간/범위 제한 지원접근·참조검사 |
| E30 | manifest/lock/환경별 capability·이동성 | 편집기 없이 install/type/lint/test/rebuild/run·비밀/운영DB 분리 |
| E31 | SDK/docs/CLI·승인pack catalog·유통운영 | validator/test fixtures·권한/지원/라이선스·문제버전차단·독립본업데이트안내 |
| E32 | 실제 제품/운영지표·capacity/compat/security 검증 | legacy 왕복·조직/파일누출 차단·workers 경쟁·공급자 중복/역순·실환경과자동검사 구분 |

## 구현 순서

1. 기존 타입·린트·93개 단위/통합·17개 브라우저 검증을 기준으로 확인한다.
2. 추가 migration 0005 이후와 domain 등록/버전/CMS 계약을 먼저 정의한다.
3. backend 확장 서비스와 editor 실제 사용자흐름을 공유 DTO로 연결한다.
4. root는 managed 경계·모든 legacy API scope guard·CAS·작업 process/queue·배포/스토리지 통합을 담당한다.
5. domain/runtime는 공개/회원 데이터·조회·패키지 manifest·독립 결과물로 이어진다.
6. 요구사항별 구현/설정필요/실환경 미검증을 분리하고 최종 tests/type/lint/build/E2E/delivery를 실행한다.

## 데이터 흐름

creator session → 서버 검증 organization/site/environment scope → usecase + CAS/domain 검사 → transaction + outbox/job → lease 소유 worker → 실제 결과/unknown → runtime/public/private projection → 개별 활성화 → 실제 health/버전 확인 → scoped metrics.

## 위험·이전·롤백

현재 사용자 변경을 되돌리지 않는다. 적용된 migration1~4는 수정하지 않고 새 번호만 적용한다. 기존 DB는 upgrade 전 backup을 만든다. 환경 이전은 기존 production dataKey=projectId로 유지하고 새 env만 새로운 저장소를 만든다. managed 모드는 origin/TLS/admin/auth 설정 누락 시 조기 실패한다. scope 없는 protected query와 unsupported package의 publish는 실패한다.

문서/모듈 업그레이드는 원본 복제+검토를 거치고 이전 문서를 남긴다. 운영 rollback은 최신 데이터를 보존한다. DB restore는 실행중 쓰기를 막고 이전 online backup을 확보하며 실제 무결성/대사 뒤 재개한다. 큐 실패/늦은 worker는 소유 lease 조건 없이 최신 결과를 변경하지 못한다. 외부실행코드는 검증된 내부 모듈 외에 허용하지 않으며 향후 격리검증을 조건으로 둔다.

## 검증

순수 등록/형식/참조/공개/병합·DB legacy migration·조직별 API/다운로드/CSV/백업/credential·creator/visitor경계·CAS/오프라인충돌·worker race/restart·automation partial/error·hold/대기/일정·package install/upgrade/rollback·real blob path·CMS serverpaging/SEO·검수 env isolation·독립 산출물 source/rebuild/node를 검증한다.

실제 인증·메일/CRM·AI·판매자결제·구독·관리형 DB/객체저장/큐·publicdomain/TLS와 장기부하/실사용자는 공급자 선택 및 해당 환경 접근 뒤 검증한다. 로컬 계약 테스트가 외부운영 성공을 증명하지 않는다.
