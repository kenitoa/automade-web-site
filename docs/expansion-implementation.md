# E01~E32 확장 구현 기록

2026-10-07. 기존 R01~R32 고도화와 상단·8개 도구·캔버스·속성 패널을 보존하고 확장 기획 전체를 실제 저장/API/런타임/독립 결과물에 연결했다. 공급자·배포 대상은 미정이라는 사용자 선택을 유지한다. 아래 기능 구현과 실제 외부 운영 검증을 구분한다.

## 요구사항 추적

| ID | 반영한 기능 | 주요 구현/검증 근거 |
|---|---|---|
| E01 | local/managed/standalone, creator/visitor 분리 | studioConfig·studioSessions·creatorAuth, 실제 managed HTTP/HTTPS 브라우저 |
| E02 | organization/workspace/project/site/environment, 기본 DB 보존 | expansion/access·organizations·migration5, 환경 DB 분리 테스트 |
| E03 | 사이트 검색/분류·환경·복제와 선택 작업 | ExpansionWorkspacePanel·ScopeBar·BatchReleasePanel; 비밀/방문자 자료 자동복제 배제 |
| E04 | 기존 메뉴 안의 확장 UI·권한·상태 | lazy 확장 패널, 기존 frame/browser 회귀 |
| E05 | creator 계정·초대·세부 ACL·기간제 지원 | CreatorGate·ExpansionTeamPanel·CredentialService; 조직간 원본/CSV/백업 거절 |
| E06 | 기존16+타임라인 등록 블록 계약 | blockRegistry·catalog·validation·runtime·Inspector, 독립 타임라인 실행 |
| E07 | 문서/module/CMS/runtime/DB 버전·pins·preflight | packages·version·manifest·registry, 미지원 버전 차단과 원본 보존 |
| E08 | 공용 component와 연결 instance·override/detach | shared·LibraryService·SharedLibraryPanel, 영향 검토/재접속 |
| E09 | 브랜드 토큰 draft/published·선택 적용·예외 | library·브랜드 UI, 잠금/상속 예외의 실제 디자인 보존 |
| E10 | 선언형 업종 팩·설치/업데이트 검토 | PackService·PackPanel·bounded manifest; actor/CAS/검토 지문 |
| E11 | 실제 blob·권한·해시·사용처·교체/내보내기 | BlobService·BlobAssetsPanel·assets; authenticated 바이트 읽기/생성 해석 |
| E12 | typed CMS model/value/reference·보관 필드 | cms·CmsModelEditor·schema preview·unique/required/readOnly 검사 |
| E13 | 검토/승인/예약/발행/보관·자동 생성 | ReviewService·CmsServerPanel·content.publish job, 현재 검토자 권한 재검증 |
| E14 | 서버 CMS cursor/search/sort·부분 저장·CAS | queryCollection·CMS API·three-way merge;35개 레코드 실제 paging |
| E15 | BCP47·지역 언어·원문 변경·fallback·SEO | languages·localization·CmsLocalizedFields, fr-CA 독립 상세/주소 |
| E16 | 실제 외부 데이터 binding·adapter·cache 상태 | connections·AdapterPanel·DataBindingPanel·useBoundContent, API 빈/오류/retry |
| E17 | 이벤트/조건/행동 workflow·부분 실행/재시도 | WorkflowService·AutomationPanel·durable journal/outbox/checkpoints |
| E18 | v1 API·OpenAPI·scoped 키·서명/중복 웹훅 | CredentialService·ApiSecurityPanel, 발급자 회수/만료/서명 검증 |
| E19 | module/pack install/update/pause/remove | packages·PackService, 권한 변경 검토·자료 materialize 보존 |
| E20 | 제작자별 저장·presence/review·오프라인/CAS 비교 | projectMerge·useStudio·SyncReview·CollaborationPanel,3영역 충돌 검토 |
| E21 | 옵션/후처리·반복/휴일/대기/hold만료 | business·BookingExpansion·BusinessExpansionPanel·visitor waitlist |
| E22 | 목적별 AI·선택 scope·검토/허용 필드·한도 | scopedProposals·AIAssistant·generationAdapter/Budget, 권한/전송 최소화 |
| E23 | 실제 환경 DB/연결/릴리스·순차 배포·복구 | operationsService·deploymentService·BatchReleasePanel; 최신 운영 데이터 보존 |
| E24 | API/생성/자동화/serving 프로세스 분리 | generationWorker·expansionWorker·siteWorker·workerClient; 독립 실행 |
| E25 | 실제 DB export/import·정확한 schema/FK·대사 | dataPortability·DataTransferPanel·restore, 온라인 backup/원본 불변 |
| E26 | DB queue·lease/fencing·heartbeat·org공정성/한도 | WorkQueue·ResourceLeases; coordinator 경쟁/만료 child/중복/unknown 검사 |
| E27 | 사용량 reserve/commit/release·실제 이벤트/용량 | UsageService·org AI counter·generations/storage, 무비용 로컬 draft |
| E28 | scope별 작업/지연·운영 지표·복원/runbook | ExpansionOperationsPanel·metrics·reconciliation·deployment/database docs |
| E29 | 인계/폐기·마지막owner·세션/지원권한·secret audit | organizations·creatorAuth·CredentialService·SecretService |
| E30 | 독립 source/lock/hash/capability·재빌드/실행 | generator2.0·artifact.contract·build-generated·verify:delivery |
| E31 | SDK·validator CLI·유통 계약/문제 버전 차단 | extension-sdk.md·check-extension.ts·approved declarative registry |
| E32 | 실제 성과·호환/권한/경쟁/복구·검증 증거 | 기존 테스트 유지+신규 단위/통합/managed/브라우저/독립 결과물 검사 |

## 동작 경계

권한은 UI 표시와 별도로 모든 legacy API와 신규 API에서 재검증한다. query·본문·environment의 프로젝트가 다르면403이다. 원본 저장은 baseRevision CAS이고 승인/발행 상태는 서버가 정규화한다. 검토한 revision과 현재 검토자/게시자 권한이 일치해야 활성화한다. creator와 visitor 세션은 공유하지 않는다.

production의 기존 dataKey=projectId는 유지한다. 새 검수/운영 환경은 별도 canonical SQLite·connection·release를 갖는다. 생성과 자동화는 실제 child process이며 queue와 resource lease를 SQLite에 남긴다. serving worker는 매 요청 artifact/data lease를 확인한다. 복원은 자체 사이트/DB 핸들을 종료한 뒤 exclusive data 보호를 획득하고 다른 coordinator가 사용 중이면409로 거절한다. 복원 후 외부 거래 차이는 대사 전 재실행을 보류한다.

이미 실행한 manual 외부효과 작업은 취소/강제종료하더라도 결과를 unknown으로 남겨 대사 없이 재시도하지 못하게 한다. 검증된 실제 완료 결과가 돌아오면 취소 요청보다 완료 사실을 우선해 succeeded로 기록한다. 아직 시작하지 않은 대기 작업의 취소는 cancelled이다. 이 동작은 작업 취소가 이미 저장/전달한 효과를 되돌린다는 오해를 방지한다.

블록과 팩은 승인된 선언형 계약만 지원하며 임의 외부 코드를 실행하지 않는다. 큰 CMS는 API/cursor와 동적 상세 SSR을 사용하고 초기 HTML snapshot20과 별도로 모든 공개 상세/언어 URL을 사이트맵에 넣는다. 10,000URL을 넘으면 index와 shard XML을 생성한다. 실제 binding은 공개 블록이 선언한 mapping 필드만 전달한다.

## 설정과 복구

기본 로컬은 `start-site.cmd` 또는 `npm run dev`로 시작하며 기본 주소는 http://127.0.0.1:5173/ 이다. 실행기가 다른 포트를 선택하면 창의 실제 URL을 사용한다. managed는 정확한 HTTPS origin·admin bootstrap·creator 인증이 필요하다. 전체 설정은 [.env.example](../.env.example), [실행/복구](deployment.md), [서버 계약](expansion-backend.md)에 있다.

Migration5~8을 순방향 적용하고 populated DB는 적용 전 온라인 backup을 만든다. 기본 ID/운영 데이터는 초기화하지 않는다. 로컬 vault는 `.data/keys/expansion.key`를 생성·재사용하며 프로젝트/ZIP/운영 DB 패키지에 포함하지 않는다. 이 키와 중앙 blob은 DB와 별도 백업해야 한다. Windows 폴더 ACL은 운영자가 설정한다. 관리형 vault는 EXPANSION_SECRET_KEY를 주입한다.

디자인 롤백은 최신 운영 DB를 보존한 새 릴리스다. 운영 데이터 복원/이전은 선택시점 DB를 반영하므로 범위 확인과 before-restore backup을 남긴다. 이전에는 SHA·schema·FK·프로젝트·건수·결제/예약 차이를 검사하고 기존 파일을 복구용으로 보존한다. JSON DB 이전 입력은16MB 한도이며 대용량 운영 DB는 별도 online backup/download와 이관 절차를 사용한다. PostgreSQL/객체 저장소/외부 큐 전환은 실제 제공자 선택·측정·이전 검증을 거쳐야 한다.

## 검증 기록

2026-10-07 Windows · Node v22.22.3에서 아래 최종 검사를 통과했다. 이전 R 작업의93개/17개 기록은 이전 단계의 결과다. managed 서버의 실제 HTTP 경계 증거는 [확장 서버 검증](expansion-server.md), 도메인/독립 런타임 증거는 [런타임 기록](domain-runtime-upgrade.md)에 있다.

| 명령/확인 | 최종 결과 | 기록 |
|---|---|---|
| `npm.cmd run typecheck` | 성공 | `.data/expansion-final-typecheck.log` |
| `npm.cmd run lint` | 성공 | `.data/expansion-final-lint.log` |
| `npm.cmd test` | 단위/통합152/152, 실패·건너뛰기0 | `.data/expansion-final-test.log` |
| `npm.cmd run build` | 타입/Vite/서비스 성공; 진입496.58kB, 크기 경고없음 | `.data/editor-final-validation.txt` |
| `npm.cmd run test:e2e` | Chromium30/30,1.5분 | `playwright-report/index.html`, `.data/editor-final-validation.txt` |
| `npm.cmd run verify:delivery` | 별도 설치·타입·린트·테스트·재빌드·포함 Node 독립 실행·페이지 경로·실제 폼 저장 성공 | `.data/expansion-final-delivery.log`, `.data/delivery-verification.json` |
| `npm.cmd audit --audit-level=high` | 알려진 취약점0 | 최종 실행 결과 |
| `npm.cmd run extension:check -- <project.interface.json> --project --target=node` | 승인된 core1.0 계약 성공, 오류0 | 기존 결과물 계약을 새 SDK로 검사 |
| 실제 로컬 서버 재시작 | generator2.0.0·UI·local-owner 세션·기존 프로젝트 조회 성공 | `.data/expansion-live-verification.json`, `.data/studio-live-final.log` |

독립 결과물은 `exports/verified-delivery/4e30eeb7-a48e-4367-af22-cad1cbb19d24/`이며 검증 시각은 `2026-10-07T14:25:32.888Z`이다. artifact.contract의 generator2.0.0·문서schema2·DBmigration8과 복사한 런타임 소스 해시를 확인했다. 새 의존성이나 lockfile 변경은 없다.

실제 작업 공간의 기존 DB는 migration1에서1~8로 순방향 업그레이드했다. 적용 전에 `.data/studio.sqlite.before-upgrade-2026-10-07T14-17-31.300Z-020f3d91-bf1d-4202-a118-e50aac44b321.sqlite` 온라인 백업을 만들었다. 기존 프로젝트1개·제출0개와 원본 ID/revision/body 및 제출 전체의 SHA256 지문이 전후 동일했다. 증거는 `.data/expansion-live-before.json`, `.data/expansion-live-after.json`이다. 마지막 서버 교체 전에는 활성 생성·대기/실행 작업·유효 자원 lease가 모두0임을 확인했다. 서버는 http://127.0.0.1:5173/ 에서 실행 중이며 `start-site.cmd`가 실행 주소를 안내한다.

지연된 실제 CMS 상태 변경 응답이 이후 로컬 편집을 덮는 경쟁 조건은 실패하는 브라우저 검사로 재현한 뒤 수정했다. 최종30개 검사에는 응답 지연 중 추가 편집 보존/병합, 생성 시작 후 환경 변경/재접속, managed HTTPS 로그인/초대/읽기전용/로그아웃, 실제 blob 바이트와 CMS 부분 저장,35개 레코드 paging·다국어 상세·전체 공개 사이트맵·독립 재빌드가 포함된다. 좁은 화면 이미지는 `test-results/expansion-editor-narrow.png`이다. 자동 검사가 모든 실제 기기나 모든 장애 시나리오를 증명하지는 않는다.

## 외부 운영 확인이 필요한 항목

사용자가 배포 대상·도메인·공급자를 미정으로 선택했으므로 공개 TLS/클라우드 배포, 실제 AI·메일/CRM 전달·결제/구독 청구는 환경 설정 후 검증해야 한다. 로컬 provider fixture의 성공을 실제 거래/메일 도착으로 표시하지 않는다. 원격 사용자가 loopback preview URL에 접속할 수 있다는 주장도 하지 않는다. 공개 미리보기는 환경별 배포 연결·origin·TLS를 구성해 검증한다.

현재 worker/SQLite 검증은 단일 호스트의 실제 프로세스와 공유 DB 경쟁이다. multi-host cluster·PostgreSQL·장기 부하·장애 주입 운영·다른 OS/Docker·실제 휴대전화/스크린리더·외부 사용자 실험은 수행하지 않은 검증 범위다. UTC 반복 예약은 구현했고 지역 DST 기반 일정 재해석은 제공하지 않는다. SDK의 공개 마켓·판매자 정산/외부 코드 실행은 이 선언형 catalog와 별도의 사업/격리 검증이 필요하다.
