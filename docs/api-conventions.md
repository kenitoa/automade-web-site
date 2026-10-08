# API

응답: `{data,error,meta:{requestId}}`. 오류는 code·message·requestId이며 스택/SQL 원문은 노출하지 않습니다.

local에서는 GET /api/session의 HttpOnly·SameSite=Strict 쿠키와 csrf를 사용합니다. 변경 요청에는 정확한 Origin과 X-CSRF-Token이 필요합니다. 토큰은 메모리에만 보관합니다. managed의 같은 경로는 creator/anonymous를 반환하며 local-owner 세션을 발급하지 않습니다. 중앙 creator는 `/api/expansion/session`/login과 X-Creator-CSRF를 사용합니다. [확장 API 계약](expansion-backend.md)을 참고하세요.

| 메서드 | 경로 | 계약 |
|---|---|---|
| GET | /health | 서비스·상태·workspaceId |
| GET | /api/session | csrf와 세션 쿠키 |
| GET / PUT | /api/projects | 허용 목록 / {project,baseRevision} CAS 저장 → {revision,project}; 신규 -1, managed 필수 |
| GET | /api/projects/:id/backups | 이전 원본 |
| POST | /api/generate | {name,prompt,template,mode,purpose,audience,primaryGoal,tone,materials} → {project,source} |
| GET | /api/generate/settings | configured,host, UTC월 요청/예상 비용 한도 (실청구 미검증) |
| POST | /api/generate/proposal | {project,instruction,operation,blockId?} → 제한 범위 project 제안, 저장은 검토 후 |
| POST | /api/exports | {project,idempotencyKey} → 202 {id} |
| GET | /api/exports/:id | status,stage,result,error |
| POST | /api/exports/:id/cancel | 단계 경계 취소 |
| POST | /api/exports/:id/stop | 실행 종료 |
| POST | /api/exports/:id/restart | 재실행, url |
| POST | /api/exports/:id/retry | 실패·취소·중단 작업 새 요청으로 재시도 |
| POST | /api/exports/:id/design-rollback | 이전 디자인의 새 릴리스, 최신 운영 데이터 보존 |
| GET | /api/exports/:id/download | 소스 ZIP, 실제 DB 제외 |
| GET | /api/exports/:id/submissions?limit=50&offset=0 | 문의 목록, limit1..100 |
| GET | /api/exports/:id/submissions?includeMeta=1 | {items,total,limit,offset}; query,status,blockId,from,to 필터 |
| PATCH | /api/exports/:id/submissions/:submissionId | status,tags,note,assignee,action:mask 또는 archive |
| GET | /api/exports/:id/submissions.csv | 검증된 필터, 셀 공식 실행 방지 CSV |
| GET / POST | /api/projects/:id/data-backups | 운영 백업 목록 / 온라인 백업 |
| GET | /api/projects/:id/data-backups/:backupId/download | 제한된 운영 DB 다운로드 |
| POST | /api/projects/:id/data-backups/:backupId/restore | {confirm:true}; 직전 백업, 연결 종료, 무결성 검사 후 복구 |
| GET / PUT | /api/projects/:id/retention | 검증된 보존·용량 정책 |
| GET / POST | /api/projects/:id/retention/... | [보존 후보·격리·복원 계약](retention.md) |
| GET | /api/projects/:id/releases | 작업 상태·활성 릴리스·실행·버전 |
| GET | /api/projects/:id/metrics | operation/status 별 실제 count·평균 시간 |
| POST | /api/telemetry | {projectId,operation,status,durationMs}; 제한 이벤트만, 개인정보 금지 |
| GET | /api/operations | 통계·작업·실행·감사·공급자 |
| POST | /api/save-project | 구 저장 경로 호환, 원본만 DB 저장 |

클라이언트 files/filemap/저장 경로는 사용하지 않습니다. 현재 UI는 /api/projects입니다.

독립 사이트: GET /health, POST /api/forms/:id {values,idempotencyKey}, GET /api/tables/:id, PUT /api/tables/:id {rows,expectedVersion}, GET /api/tables/:id/history?limit=10&beforeVersion=N. 폼의 같은 키·같은 내용은 같은 결과이며 다른 내용은409입니다. 필수 동의는 values.__consent='true'이며 서버에서 다시 검사합니다. 표 변경은 역할·열 규칙·이전 행·버전409를 검사하고 이력을 같은 트랜잭션에 저장합니다. 표 이력은 operator/owner만 조회합니다. 공개 블록·회원 콘텐츠 접근·Origin을 서버에서 확인하며 문의 목록은 공개 사이트 API로 제공하지 않습니다.

`/api/platform/*`은 [플랫폼 계약](platform.md)의 별도 계정·세션·CSRF·프로젝트 역할을 사용합니다. 편집기에서는 `?projectId=...`를 지정하고 local-owner 세션과 X-CSRF-Token을 사용합니다. 사이트는 자신의 projectId에 한정됩니다. 주문·예약·계정은 서버 소유권 검사로 보호됩니다. `/api/projects/:id/deployment`와 readiness/test/publish/rollback/verify는 [배포 계약](public-deployment.md)을 참고하세요.

외부 생성: POST {prompt,name,schemaVersion:2,template,mode,brief?,operation,baseProject,targetBlockId?,constraints} → {project} 또는 {data:{project}}. 20초 제한, 최대32MB, 고정 요청ID/멱등성 키, 429/5xx에1회 재시도, 리다이렉트 금지. template 유지 및 proposal은 ID·블록종류·페이지경로·부모 관계 구조를 변경하지 못합니다. 제안은 전달 데이터 최소화와 허용 필드 투영을 적용해 회원/권한/운영 데이터/폼 규칙을 보존합니다. 요청 한도와 예상 비용은 공급자 실제 청구액과 구분합니다.

## 확장 경계

기존 경로를 유지하면서 보호된 요청은 서버가 조직/작업공간/프로젝트/환경 귀속과 capability를 확인합니다. 환경은 `?environmentId=...`, 프로젝트는 `?projectId=...`로 지정하며 본문 프로젝트와 다르면403입니다. managed 원본 CAS가 없으면400, 최신 base와 다르면409입니다. 서버가 반환한 정규화 Project를 저장 기준으로 사용하세요. 전체 PUT으로 CMS 승인/발행을 지정할 수 없습니다.

| 메서드 | 경로 | 계약 |
|---|---|---|
| GET | /api/expansion/bootstrap | 조직·workspace·site·environment·현재scope·capabilities |
| GET | /api/expansion/openapi | 공개 v1 계약 |
| GET/PUT | /api/v1/project | Bearer scoped credential, 서버 검증 원본/CAS |
| GET | /api/v1/content/:id | credential scope, CMS 공개 projection/cursor |
| POST | /api/v1/workflow-events | 허용 manual 이벤트, 실제 영속 작업 |
| POST | /api/expansion/webhooks/:credentialId | raw JSON HMAC·timestamp·dedupe, manual automation |
| GET | /api/work-items?projectId=...&environmentId=... | scope별 작업 상태; payload/result 원문 제외 |
| GET | /api/work-items/metrics?projectId=...&environmentId=... | 실제 queue/run 지연·상태별 건수 |
| GET/POST | /api/work-items/:id 또는 /:id/cancel, /:id/retry | 해당scope 권한, unknown 재시도는 서버의 동일 작업·범위 복구 근거/대사 필요; boolean만으로 승인하지 않음 |
| GET/POST | /api/projects/:id/data-transfer | backup.restore; 검증 DB 패키지/이전, POST confirm:true |
| GET | 사이트 /api/content/:collectionId | limit1~100, q/sort/language/cursor, 승인 공개 필드 |
| GET | 사이트 /sitemap.xml, /sitemaps/:page.xml | 전체 공개 CMS·언어 URL, 10000URL 단위 분할 |
| GET | 사이트 /api/platform/data/:id/binding | 공개 블록 mapping에 선언한 실제 연결 필드만, page/search/cache시각 |

Studio의 `/api/platform/webhooks/:id` 및 `/api/platform/billing/webhooks/:id`는 cookie/Origin 없는 공급자 callback을 허용하되 명시적인 project/environment 귀속과 raw body 서명·timestamp·재전송을 검사합니다. 무서명 요청은 WEBHOOK_SIGNATURE, 다른 환경은 소유 불일치로 거절합니다. 이 예외는 다른 platform 경로에 적용하지 않습니다.

초안 생성은 `workspaceId`와 project.create가 필요합니다. 제안은 project.edit 및 block/page/site/CMS scope·허용 필드 검사 후 실행합니다. 외부 AI의 DNS 조회는5초, 각 요청은20초, 최대1회 제한 재시도입니다. 실제 공급자 요청은 전역 예산과 조직 ai.requests 월 한도를 트랜잭션으로 기록하고 로컬 템플릿에는 외부 사용량을 부과하지 않습니다. 실패/미확인 응답도 이미 시도한 공급자 요청이므로 실제 청구와 따로 기록합니다.


## 시스템 API 계약

`GET /api/advancement/runtime/contracts`는 HTTP1/command1/IPC1/document2/artifact1~2/migration15와 유스케이스 정책을 제공합니다. `POST /api/projects/:id/commands`는 command ID·baseRevision·변경 목록·입력 지문을 검사하고 원본과 ACK를 원자 저장합니다. 동일 command 재접속은 저장된 ACK를 반환하며 다른 내용은409입니다.

`/api/advancement/runtime/`의 overview/operations/collaboration/observability/alerts/worker-policy/storage-migrations/experiments는 실제 scope·현재 권한을 검사합니다. 전역 큐/알림 정책과 저장소 전환은 플랫폼 관리자 또는 local-owner만 변경합니다. 실험 assignment는 서버 계정/조직 단위로 고정하고 events는 멱등 검증합니다.

릴리스 `GET releases/:id/preview`는 대상 환경 설정 revision과 `reviewFingerprint`를 반환합니다. `POST releases/:id/promote`에는 해당 지문·대상 환경·검토 revision·requestKey가 필요합니다. 산출물·flags·활성 키 버전 변경 시409로 재검토를 요구합니다. `POST releases/:activationId/reconcile`은 중단된 승격의 실제 활성 DB·artifact 해시를 확인합니다.

`POST previews`는 releaseId·projectId·environmentId·ttlMinutes(1~120)로 발급합니다. 반환된 `/preview/<token>/`은 발급 세션과 현재 권한을 매번 확인하는 정적 검수입니다. `DELETE previews/:grantHash`는 본문 없이 폐기합니다. 토큰은 원문 저장하지 않으며 no-store/noindex·스크립트/폼 차단을 적용합니다.
