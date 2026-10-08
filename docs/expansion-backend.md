# 확장 백엔드 계약

E01~E32 전체 범위와 도입 순서는 [확장 계획](expansion-plan.md)을 따른다. 이 문서는 `server/expansion/`, 기존 `server/platform/`와 중앙 운영 서비스 사이의 실제 계약을 설명한다. 임의 JavaScript 플러그인 실행이나 특정 공급자의 상용 서비스 가입을 제공하는 문서는 아니다.

## 데이터와 계정 경계

- 중앙 `studio.sqlite`: 제작자 계정·조직·작업공간·프로젝트 귀속, 멤버 권한, 브랜드/라이브러리 버전, blob 참조, vault, API credential, 검토/댓글/presence, 자동화 정의/실행, 사용량 예약을 저장한다.
- 사이트/환경 canonical SQLite: 방문자 계정, 제출·표·주문·결제·예약, 실제 연결/outbox, CMS 발행 snapshot을 저장한다. 같은 이메일의 제작자와 방문자는 별개 계정이다.
- 기존 프로젝트는 `local` 조직/작업공간, 기존 projectId 사이트 및 `<projectId>-production` 환경에 편입한다. 기존 운영 dataKey는 projectId 그대로 유지한다. 추가 환경은 `env-<environmentId>` dataKey를 사용한다. 추가 production 환경을 만들더라도 projectId만 전달한 기존 요청의 기본 DB가 바뀌지 않는다.
- environmentId를 지정하면 조직→작업공간→프로젝트→사이트→환경→dataKey 관계를 서버가 재검증한다. 브라우저에서 보낸 organizationId나 dataKey를 소유권 증거로 사용하지 않는다.
- 자산은 실제 이미지 bytes를 `DATA_DIR/blobs/<hash-prefix>/<sha256>`에 저장하고 프로젝트별 참조를 별도로 둔다. 참조 제거는 원본 bytes를 영구 삭제하지 않는다. 서버가 참조 귀속, realpath 포함 관계, bytes hash를 확인한다.
- Project 저장 경계의 `validateProjectAssets(project,actor,localOwner)`는 blobRef.projectId/sha256, 저장된 MIME·선택 크기, 실제 bytes 무결성과 현재 제작자의 읽기 권한을 검사한다. filesystem await 뒤에도 활성 계정/권한을 다시 확인하며 bytes를 클라이언트에 반환하지 않는다. inline 원본을 함께 넣으면 저장된 bytes와 같아야 한다.

## 인증과 권한

`automade-creator` 쿠키는 HttpOnly, SameSite=Strict, 8시간 만료이며 HTTPS origin에서는 Secure를 포함한다. GET `/api/expansion/session`이 익명 CSRF nonce를 만들고, 로그인 시 session과 nonce를 교체한다. 변경 요청에는 `X-Creator-CSRF` 또는 `X-CSRF-Token`과 허용 Origin이 필요하다. 토큰을 localStorage에 보관하지 않는다.

조직 역할은 owner/admin/billing/member이다. member는 workspace/project의 명시 capability로 작업한다. admin에게 org.manage, billing.manage, secret.rotate가 자동 부여되지 않는다. 마지막 owner 제거를 막고 인계 대상은 해당 조직의 활성 멤버로 제한한다. 초대는 이메일·만료·회수·일회 사용을 검사하며, 비공개 가입에서도 받은 초대의 `inviteToken`으로 동일 이메일의 계정 생성과 수락을 한 트랜잭션으로 처리한다.

공개 API credential은 최대 90일, resource scope와 capability에 한정된다. 발급 원문과 webhookSecret은 생성 응답에서 한 번 표시한다. 이후 응답에는 비밀 원문이 없다. 매 요청과 worker 실행에서 제작자의 활성 상태와 현재 권한을 다시 확인하므로 멤버 권한 회수 후 credential이나 이전 작업으로 권한을 유지할 수 없다. 사이트 방문자 세션으로 Studio 제작자 권한을 얻을 수 없다.

비밀번호는 scrypt로 저장한다. 복구 토큰은 검증용 hash, 15분 만료, 일회 사용이며 사용 시 기존 sessions를 폐기한다. 실제 메일이 구성된 경우 전달 대기 outbox에는 단기 raw token이 필요하다. 전송 성공·최종 실패·만료 후 token을 제거하며 만료/제거된 복구 안내를 수동 재전송하지 않는다. 미구성 응답은 `delivery: not-configured`이다. `pending`은 메일 도착 확인을 의미하지 않는다.

## HTTP 계약

응답은 `{data,error,meta}` envelope이다. 타입은 `src/domain/expansion.ts`를 공유한다. 아래 `/api/expansion/` 리소스는 프로젝트 기능이면 `projectId`와 선택 `environmentId`, 조직 기능이면 `organizationId`를 입력한다. 조직·작업공간·환경 귀속은 DB에서 다시 확인한다. 현재 일반 목록은 명시된 상한까지만 반환하며 모든 목록에 cursor가 구현된 것은 아니다.

| 경로 | 메서드 | 입력/동작 |
|---|---|---|
| session, bootstrap | GET | 계정/CSRF 및 접근 가능한 조직·작업공간·사이트·환경·현재 capability |
| accounts | POST | email,password,displayName, 선택 inviteToken |
| login, logout | POST | 중앙 제작자 로그인/세션 폐기 |
| password-reset/request, password-reset/confirm | POST | email / token,password |
| organizations, workspaces, sites, environments | GET, POST | 실제 목록과 생성; site 생성은 기존 projectId·workspaceId 필요 |
| organizations/:id, workspaces/:id, sites/:id, environments/:id | PUT | 검증된 이름/설정/보관 변경; 환경 config는 baseVersion CAS |
| organizations/:id/transfer | POST | accountId, 마지막 owner 보호/인계 |
| members, members/:id | GET / PUT, DELETE | 조직 멤버·workspaceGrants·projectGrants |
| invites, invites/accept, invites/:id | POST / POST / DELETE | 초대 발급·수락·회수 |
| brands, brands/:id | GET, POST / PUT | 전체 domain Theme, baseRevision CAS |
| brands/:id/versions, brands/:id/publish | GET / POST | 불변 이전 버전 / 현재 브랜드 revision 승인 marker |
| library, library/:id, library/:id/versions | GET, POST / PUT / GET | theme/component/pack, 전체 SharedComponent `{id,name,version,blocks}` |
| blobs, blobs/:id/content, blobs/:id | GET, POST / GET / DELETE | dataUrl·alt·source·license / 권한 검사된 bytes / 참조 제거 |
| secrets, secrets/:id, secrets/audit | GET, POST / PUT, DELETE / GET | metadata·원문 등록/회전·비활성화·사용 감사 |
| credentials, credentials/:id | GET, POST / DELETE | scope/capability/expiresAt 발급·회수 |
| adapters, adapters/:id, adapters/:id/execute | GET, POST / PUT / POST | generic-json kind/mapping, baseVersion, 실제 data 조회 또는 mail/CRM outbox |
| workflows, workflows/:id, workflows/runs | GET, POST / PUT / GET | 조건/동작·CAS·활성화·실행 상태 |
| workflows/events | POST | trigger,payload,key → 중앙 durable job 참조 |
| reviews, reviews/:id | GET, POST / PUT | 현재 revision 검토 요청/다른 제작자 승인·수정 요청 |
| comments, comments/:id, presence | GET, POST / PUT / GET, POST | revision/targetPath 댓글·해결; 60초 presence |
| cms/:collectionId/records | GET, PUT | bounded cursor/limit/q/sort; baseRevision+record 부분 upsert |
| cms/transitions | POST | collectionId,recordId,baseRevision,state,publishAt |
| packs, packs/catalog, packs/preview, packs/apply | GET / GET / POST / POST | 선언형 manifest·mode·baseRevision → approvalFingerprint → 검토된 Project 적용 |
| usage, usage/limits, usage/reservations | GET / POST / POST | 실제 월별 budget 및 metric/amount/key 예약 |
| usage/reservations/:id/settle, :id/release | POST | 실제 사용량 정산/보류 해제, 중복 요청 멱등 처리 |
| booking/rules, booking/rules/:id | GET, POST / PUT | UTC 반복 규칙·기간·weekday·duration·capacity·enabled |
| booking/rules/:id/materialize, booking/waitlist/offers | POST | 중앙 durable job 발행 |
| booking/holidays, booking/waitlist | GET, POST, DELETE / GET | 휴일·실제 대기/제안 상태 |
| orders/fulfillments, orders/:id/fulfillment | GET / PUT | 공급자 확인된 주문의 후처리 상태·tracking·notes |
| openapi, webhooks/:credentialId | GET / POST | v1 계약 / 원문 HMAC·timestamp·eventId 중복 검사된 manual 이벤트 |

중앙 작업 목록/상태/취소/재시도는 `/api/work-items`, `/:id/cancel`, `/:id/retry`, `/metrics`를 사용한다. 재시도 body의 `confirmedUnknown`은 불명확한 외부 효과를 확인한 운영자의 명시 입력이며 자동 성공으로 바꾸지 않는다.

공개 v1 API는 cookie 대신 Bearer scoped credential을 사용한다. GET/PUT `/api/v1/project`, GET `/api/v1/content/:collectionId`, POST `/api/v1/workflow-events`가 구현되어 있다. 데이터 조회는 published projection을 사용한다. signed automation webhook은 manual 이벤트만 받으며 `order.paid`를 위조하는 결제 통로가 아니다.

방문자 대기 예약은 사이트 `/api/platform/bookings/waitlist` GET/POST, `/:id/accept`, `/:id/cancel` POST이다. 제안은 10분 capacity hold이며 수락은 실제 예약 생성과 같은 트랜잭션이다. 제안 생성 job과 메일 전달은 별개다. 자동 이메일 알림을 구성하지 않아도 사이트에서 본인 제안을 조회/수락할 수 있다.

## 콘텐츠·팩·자동화 처리

CMS 조회는 최대 100개/페이지, 200자 검색, 검증된 schema field 정렬, 문서/검색 지문을 포함한 cursor를 사용한다. 오래된 cursor에는 409를 반환한다. 부분 저장은 domain schema/required/unique/readOnly를 확인하고 변경된 콘텐츠를 draft로 돌린다. client가 전달한 approved/published 상태로 서버 승인 절차를 우회할 수 없다.

콘텐츠 승인에는 제출자와 다른 검토자가 필요하다. 승인 내용의 fingerprint와 contentRevision을 저장한다. 예약 발행은 예정 시각, 동일 내용/revision, 게시자의 현재 권한과 승인 검토자의 현재 review.approve 권한을 다시 확인한다. canonical runtime_state `project:cms`의 `{revision,collections}`가 실제 사이트 조회/SSR에 사용된다. 발행 작업의 결과가 생성 job을 반환하면 실제 생성·활성화 결과는 그 job을 확인해야 한다. 작업공간 requireApproval 정책은 정확한 전체 Project revision/fingerprint 검토도 요구한다.

팩은 `protocol:1` 선언형 manifest만 지원한다. SHA-256 integrity를 확인하며 기존 JavaScript를 실행하지 않는다. preview는 15분 동안 actor/scope/CAS에 묶인 검토 Project와 approvalFingerprint를 보존한다. apply는 같은 block ID를 사용한다. 업그레이드는 local override를 보존하고 사용 중 definition 제거/호환되지 않는 template 변경을 막는다. remove는 기존 콘텐츠를 지원 block type으로 materialize하여 보존하고, pause는 보존된 block을 숨긴다.

자동화는 form.submitted/order.paid/booking.created/manual 이벤트를 받는다. 조건은 equals/contains/greaterThan, 동작은 submission.update 또는 mail/CRM connection.enqueue이다. 최대 20조건/20동작, 이벤트 100KB 제한이며 arbitrary code 실행은 없다. 실제 이벤트를 canonical journal에 기록하고 중앙 polling으로 durable queue에 연결한다. 실행은 정의 snapshot·행동별 checkpoint·권한/lease 확인 및 action별 outbox 멱등성 키를 사용한다. 실행 완료는 outbox 전달 완료를 의미하지 않는다. 전달은 별도 상태로 확인한다. 실행 payload에는 필요한 form 값이 저장될 수 있으므로 운영 보존 정책에서 중앙 DB도 포함해야 한다.

반복 예약 생성은 UTC, 최대 180일 기간, 중복 생성 멱등성, 교차 시간·정원·휴일 검사를 사용한다. 한국 외 현지 시간대와 DST 기반 재해석 기능을 제공한다고 주장하지 않는다. 확정 예약이 있는 날을 휴일로 바꾸는 요청은 실패한다.

## 비밀·외부 연결·과금 경계

managed 연결 참조는 해당 조직/작업공간의 활성 `TENANT_*` vault 값만 사용한다. AES-256-GCM 키는 중앙 `EXPANSION_SECRET_KEY`이고 복호화 키를 API/Project/ZIP에 넣지 않는다. local 모드는 승인된 서버 env fallback을 지원하되 Studio/admin/배포/DB용 reserved secret 참조를 사이트 공급자에 전달하지 않는다. 사이트 child worker에는 해당 scope의 실제 connection refs만 전달한다.

외부 요청은 승인된 HTTPS host, DNS public-address 검증 및 pinned 주소, DNS/TCP/TLS/body를 포함한 총 10초 deadline, request/response 1MB 상한, redirect 차단을 사용한다. outbox는 한 번에 최대 10개를 순차 처리하지만 claim은 메시지별로 하고 claim lease 소유자만 결과를 갱신한다. retry는 제한된 retryable 오류만 최대 5회이다. pause는 아직 시작하지 않은 전달을 보류한다.

사이트 고객 주문/환불과 플랫폼 구독은 서로 다른 operation namespace·state·webhook 경로이다. 사용량 예약/정산은 조직 budget 통제이며 실제 카드 청구 증거가 아니다. 공급자 미설정 상태는 not-configured이며 서명된 webhook 또는 서버 상태 조회 없이 paid로 바꾸지 않는다. 결제 이벤트 중복·역순·누적 부분 환불을 검증한다.

## 마이그레이션과 복구

새 migration은 0005(expansion), 0007(업무/검토/CMS), 0008(credential issuer/암호화 서명키/자동화 checkpoint)이다. 중앙 queue의 0006은 별도 운영 서비스가 소유한다. 이전 적용 migration 1~4를 변경하거나 데이터베이스를 초기화하지 않는다. 앱 시작 때 forward migration을 적용하므로 배포 전 현재 중앙 DB·사이트 DB·blob bytes·vault 키를 함께 백업하고 구버전은 이전 백업으로 복구한다. 새 스키마에 구버전 앱을 그대로 기동하는 방식의 SQL down migration은 제공하지 않는다.

운영 DB 복구는 현재 원본 snapshot을 별도 보존한 후 before/candidate 실제 주문·결제 이벤트·환불 명령·예약·재고를 비교한다. 보고서는 ID·상태·변경 사유·개수만 담으며 PII 원문을 포함하지 않는다. 이전 provider transaction/sequence watermark와 미확인 환불 명령을 서버용 journal로 보존한다. divergent 주문은 새 checkout/refund/fulfillment를 차단하고 provider status로 실제 거래와 command ID·금액·누적 환불이 확인될 때만 주문 hold를 해제한다. 예약/재고 차이는 운영 검토 대상이므로 주문 hold 해제를 전체 복원 완료라고 표현하지 않는다.

## 검증 범위와 실환경 선택

`tests/expansion.test.ts`는 실제 SQLite/auth/CAS/blob bytes/vault/credential/workflow/CMS/pack/예약/usage 경계를 검증한다. `tests/expansion-reconciliation.test.ts`는 실제 이전 snapshot 복구와 provider adapter 응답을 이용한 거래 hold/환불 원장 대사를 검증한다. 공급자 adapter의 테스트 응답은 계약 검증이며 실제 과금/메일 도착 증거가 아니다. 중앙 HTTP 경계의 별도 검증은 [확장 서버 검증](expansion-server.md)에 기록한다.

실환경에서는 TLS proxy/도메인, 스토리지 volume·백업 위치, 메일/CRM/결제/배포 provider, 보존 기간, 지원 시간대, vault 키 관리·복구·회전, 실제 부하 기준을 정해야 한다. Postgres 전환 및 multi-node 운영은 이 SQLite 구현과 로컬/단일 호스트 테스트만으로 검증되지 않는다. 운영자 OS/DB 접근 권한과 child process 자체는 별도 인프라 보안 경계다.
