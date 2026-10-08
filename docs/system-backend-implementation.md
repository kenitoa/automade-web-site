# 시스템 고도화: 운영·보안·업무 서버 구현 기록

2026-10-08. [H01~H48 기획](system-advancement-plan.md)의 운영 서버 범위 구현과 검증을 기록한다. 전체 제품의 인수 근거는 [검증 행렬](system-evidence-matrix.json)과 다른 담당 영역의 기록을 함께 확인한다. 제공자·배포 대상·도메인은 미정이다.

## 구현 경계

| 요구 | 실제 동작과 저장 위치 |
|---|---|
| H04·H05 | `ConfigService`가 환경 설정 검토·지문·CAS와 기능 플래그를 저장한다. 현재 범위·권한 검사 뒤 API에서 제한하고 isolated worker도 현재 lifecycle/flag를 다시 확인한다. 공개 읽기와 복구·대사는 유지한다. |
| H13 | 관리형 고위험 작업은 비밀번호와 TOTP 또는 일회용 복구 코드로 발급한 proof를 요구한다. proof는 제작자·세션·method·path·scope·본문 지문·5분 만료에 묶이며 한 번만 소비한다. 조직·workspace·권한·키·복원·배포·결제 연결·환불·운영 정책 변경에 적용한다. local-owner 사용은 유지한다. |
| H14 | 조직 service identity와 개인 발급자 연동 credential을 구분한다. service identity에는 승인된 capability·환경·만료·폐기·새/구 키 전환 기간이 있다. HTTP/v1와 작업 실행에서 현재 권한을 검사한다. |
| H15 | 암호문에 keyId를 기록하고 master key 재암호화를 제한된 transaction 배치로 재개한다. 기존 secret·웹훅 키·활성/등록 중 MFA 키도 포함한다. 환경 비밀은 등록→해당 연결 시험→활성화로 진행하며 등록됐지만 inactive인 참조는 legacy/process 환경 변수로 돌아가지 않는다. |
| H16 | 새 blob은 격리/private다. Sharp 0.35.5의 격리 worker가 PNG/JPEG/GIF/WEBP 실제 픽셀과 모든 프레임을 디코딩한다. 8MB·총 4천만 픽셀·128프레임·한 변 16000·시간 제한을 적용한다. 서버 PNG/WEBP 변형은 원본 불변·메타데이터 제거·첫 프레임 정적 출력이며 새 격리 검토를 받는다. 요청 receipt/lease로 동시 변형과 재전송의 중복 작업을 차단한다. 공개 해석은 approved/public만 허용한다. |
| H17 | 회원 export/비식별화 요청과 범위·건수·보류 사유를 기록한다. 세션·복구 토큰을 회수하고 정확한 환경의 삭제 marker를 복원 뒤 재적용한다. 거래 보존과 비정형 payload 검토를 별도 보류로 남긴다. |
| H18 | 기간·사유·capability·환경이 있는 지원 세션을 조회/종료한다. 만료·회수 또는 승인자의 권한 상실은 다음 요청에서 차단한다. 조직 범위 감사 목록과 로컬 hash checkpoint를 제공한다. |
| H22 | 시뮬레이션은 조건·예상 action만 계산한다. 실제 실행에는 검토한 workflow revision과 입력 지문을 적용한다. pending 실행 재탐색에서 회수된 actor의 실행은 실패로 기록하고 다음 정상 실행을 계속 발견한다. |
| H23·H24 | 실제 providerRequest에 전체 deadline·동시 claim·Retry-After·jitter·회로 상태를 적용한다. POST 재시도는 선언한 멱등성 능력이 있어야 한다. 비멱등 전달의 응답 유실/lease 만료는 unknown으로 보류하며 일반 재시도 API로 보내지 않는다. 상태조회 adapter의 서버 증거가 필요하다. |
| H25 | 고객 주문과 플랫폼 구독의 금액 원장을 분리한다. authoritative 부분/전체 환불이 먼저 도착해도 결제 확인금액과 환불 증가분을 별도 기록한다. 중복 이벤트는 추가 원장을 만들지 않고 오래된 이벤트는 현재 상태를 되돌리지 않는다. |
| H26 | 반복 규칙의 IANA 시간대·wall time·DST 선택과 생성 슬롯의 UTC·offset·rule revision·resolver·ICU/tzdata 버전을 저장한다. 기존 규칙은 UTC로 이전하며 생성된 슬롯 시각은 다시 해석하지 않는다. 정원/휴일/규칙 변경은 확정 예약·offer·대기·슬롯 snapshot에 묶인 검토 후 적용한다. |
| H27 | reservation/commit/release와 실제 관측·추정비용·공급자 청구 근거를 분리한다. operation/env/metric 중복 관측을 제한하고 만료 예약도 측정 근거로 복구한다. generation은 누적 횟수, storageBytes는 환경별 최신 물리 gauge다. 생성·확장·이미지 worker는 성공/실패 최종 메시지에 process.cpuUsage 실제 CPU 마이크로초와 별도 단조 경과 시간을 보내며 CPU는 밀리초 원장에 기록한다. |
| H40 | 선택 환경을 freeze한 상태에서 중앙/환경 DB를 snapshot하고 캡처된 중앙 DB의 blob 참조·암호문 keyId·scoped 릴리스 목록으로 immutable bytes를 복사한다. artifact shared lease, 경로/symlink·디스크 예산과 파일 SHA를 검사한다. runtime Node를 포함한 릴리스 bytes도 보존하며 실제 비밀 파일·node_modules·방문자 DB는 제외한다. 격리 rehearsal은 DB FK·quick_check·복호화와 artifact 복원을 검사한다. 일반 환경 복원에서는 없는 exports만 복구하고 기존 bytes가 다르면 덮어쓰지 않는다. |
| H46·H47 | 소유권 제안/수락, 조직 보관/closing, credential·기계/지원 접근 폐기를 구현한다. catalog에는 제출자·라이선스·지원 연락·근거·관리자 검토/회수를 기록하고 회수된 알려진 팩의 신규 설치/발행을 차단한다. |

## API와 업무 순서

기존 `/api/expansion`, `/api/platform`, `/api/v1` 계약은 유지한다. 아래 요청에는 정확한 `projectId`와 필요한 `environmentId`를 본문 또는 query로 지정한다. 제작자 쿠키 요청은 CSRF를 요구하며 고위험 요청에는 `X-Step-Up-Token`을 추가한다. 서버는 proof 발급 시와 실행 시 현재 권한을 다시 확인한다.

| 요청 | 계약 |
|---|---|
| `POST /api/advancement/security/enrollment` | 현재 비밀번호로 등록한다. 이미 활성화된 MFA의 교체에는 기존 MFA 증거도 필요하다. 반환 secret/otpauth와 일회용 복구 코드를 개인 인증 앱·안전한 별도 위치에 보관한다. |
| `POST /api/advancement/security/enrollment/confirm` | 현재 TOTP로 확인한다. |
| `POST /api/advancement/security/step-up` | 대상 `method`, `path`, 실제 `payload`, 범위와 비밀번호·MFA 증거를 보내 proof를 발급한다. 조직 수준 요청의 proof에는 프로젝트 scope를 묵시적으로 넣지 않는다. |
| `POST /api/advancement/config/changes`, `POST /config/changes/:id/apply` | 현재 config revision으로 검토하고 반환한 approvalFingerprint로 적용한다. |
| `POST /api/advancement/secrets/versions`, `POST /secrets/versions/:id/test`, `POST /secrets/versions/:id/activate` | 환경 비밀을 등록하고 실제 연결을 시험한 뒤 활성화한다. 연결 변경/시험 만료 시 재시험한다. |
| `GET /api/advancement/keyring`, `POST /keyring/rotations` | 중앙 운영 관리자에게 활성 keyId와 회전 이력을 제공한다. 동일 회전 `id`와 목표 keyId로 배치를 재개한다. |
| `POST /api/expansion/blobs/:id/approval` | `baseRevision`, `state: approved/rejected`, `visibility: private/public`, `reason`을 지정한다. 다른 사이트 복사본은 새 검토 상태를 갖는다. |
| `POST /api/expansion/blobs/:id/variants` | `{width,height,format:'png' 또는 'webp',requestKey}`. asset.manage와 동일 프로젝트 원본을 검증한다. 각 크기는 원본 이하이며 fit-inside로 생성한다. 같은 키·설정은 기존 결과, 진행 중은 409, 설정 변경은 ASSET_VARIANT_CONFLICT다. 새 결과도 격리/private로 저장한다. |
| `POST /api/expansion/booking/reviews` | `{kind:'resource'|'rule'|'holiday',targetId,input}`으로 예약 영향과 충돌을 조회한다. |
| `POST /api/expansion/booking/reviews/:id/apply` | 반환한 approvalFingerprint를 보낸다. 예약/offer/대기/설정이 바뀌거나 15분이 지나면 재검토한다. 휴일 제거 입력은 `{date,remove:true}`다. |
| `GET /api/advancement/usage` | 실제 `actual` 관측 목록, `aggregate` 집계, 별도 `costs`, 예산과 예약을 제공한다. providerBilling 미설정 상태를 실제 청구 금액으로 표시하지 않는다. |
| `POST /api/advancement/usage/reconcile` | 같은 환경·단위·작업의 실제 관측 근거에 연결된 예약만 확정한다. |
| `POST /api/advancement/reconciliation/:id/verify` | 결제 서버 상태조회 또는 구성한 다른 외부 status adapter를 사용한다. 확인용 boolean은 외부 결과 증거가 아니다. |
| `POST /api/advancement/backup-sets`, `POST /backup-sets/:id/rehearsal`, `POST /backup-sets/:id/restore` | 중앙 운영자 권한에서 백업·격리 검사·선택 환경 복원을 수행한다. 중앙 DB 전체 복원과 일반 환경 복원은 다른 범위다. |

## 마이그레이션과 복구

추가 migration9~15를 사용한다. 이 범위의 migration14는 asset 검토/receipt, 환경 privacy marker와 실제 사용량 원장을 추가한다. migration15는 예약 timezone·해석 provenance·영속 영향 검토를 추가한다. 기존 UTC 규칙을 UTC로 backfill하고 기존 blob 참조에는 `legacy-metadata-validation`과 `malwareScan:not-configured`를 기록해 이전 참조 호환성을 유지한다. 기존 migration1~8은 수정하지 않는다.

배포 전 현재 코드 검증→온라인 백업과 키 별도 보관→기존 핸들 안전 종료→새 코드의 additive migration→범위·auth·공개 읽기 검증 순서로 진행한다. 구 앱으로 새 DB를 직접 다운그레이드하지 않는다. 복구가 필요하면 대응 코드와 선택한 검증된 snapshot을 함께 사용하고 최신 권한 회수/삭제 기록을 재적용한다.

`EXPANSION_SECRET_KEYS`는 서버 비밀 관리에서 keyId→64자리 hex master key의 JSON map으로 주입하고 `EXPANSION_ACTIVE_KEY_ID`로 새 쓰기 키를 선택한다. 기존 `EXPANSION_SECRET_KEY`는 legacy key다. 로컬 자동 키 파일을 보존한다. 회전 완료 후에도 과거 백업 manifest가 요구하는 구 키는 별도 보호된 보관에서 유지한다. 실제 키는 `.env.example`, 프로젝트 원본, 일반 ZIP 또는 이 문서에 넣지 않는다.

portable 방문자 DB 검증은 지원 migration1~15의 연속성·schema/제약·FK·scope를 검사한다. creator·세션·MFA·service identity·중앙 키 회전/비밀 realm의 행이 있으면 거부한다. migration 소유의 비활성 local 조직/workspace seed만 정확한 기본값에서 허용한다. worker DB 포인터는 dataRoot 내부 absolute SQLite 경로·실제 파일·각 상위 경로의 symlink를 검사한다.

## 검증 근거와 남은 조건

`tests/system-backend.test.ts`의 21개 테스트는 실제 임시 SQLite 파일을 사용한다. TOTP는 [RFC6238](https://www.rfc-editor.org/rfc/rfc6238)의 59초 SHA1 벡터, replay·만료·proof scope와 복구 코드 소모를 검사한다. artifact backup 통합 fixture는 캡처·격리 복원·없는 exports 복원·동일 hash 보존·충돌/tamper 차단을 검사한다. fixture의 runtime bytes는 실제 Node 실행 증거가 아니다. 테스트용 provider transport도 실제 메일·거래·원격 배포 성공의 증거로 사용하지 않는다.

2026-10-08 선택 검증에서 `system-backend`, `managed-studio`, `expansion`, `expansion-integration`, `platform` 합계55개가 통과했다. 이후 최종 통합 검증은 루트 구현 기록에서 확인한다. managed HTTP 테스트는 실제 compiled server에 MFA 등록·TOTP 확인·일회용 proof로 권한 변경/결제 연결을 요청한다. 운영 서버 범위 lint도 통과했다.

다음 조건은 별도 검증 또는 제공자/운영 정책이 필요하다.

- TOTP 프로토콜과 서버 검사는 로컬 검증했고 실제 사용자의 인증 앱/기기 등록·분실 대응 훈련은 운영 도입에서 수행한다. WebAuthn은 이번 선택 구현에 포함하지 않는다.
- 실제 픽셀 디코딩·서버 변형과 검토 상태는 로컬 구현/검증했다. 악성 검사 공급자는 `not-configured`이며 CDN·백신 실전사는 공급자 선정 후 검증한다. 원본 바이트와 메타데이터는 보존하므로 공개 시 메타데이터 제거가 필요하면 변형본을 승인한다.
- retention 기간·법적 보존·비정형 payload와 외부 공급자 자료 삭제는 담당 검토와 실제 사업 기준이 필요하다. held 개인정보 요청을 전체 삭제 완료로 표시하지 않는다.
- 구성되지 않은 deployment/work/restore 외부 조회는 `EVIDENCE_PROVIDER_REQUIRED`로 보류한다. fixture의 증거를 실제 공급자 조회 성공으로 표시하지 않는다.
- 실제 공급자 invoice 수집·가격/환율/세금 계산과 token 실사용 관측은 해당 adapter 연결이 필요하다. 연결된 관측은 generation 횟수, 물리 storage gauge와 worker 프로세스/스레드 CPU다. 별도 프로세스로 실행되는 esbuild·장기 site serving CPU는 포함하지 않는다. hard kill/OS crash 전 최종 메시지가 없으면 CPU를 0이나 완전한 측정으로 만들지 않으며 관측 누락으로 남긴다.
- 로컬 hash checkpoint는 같은 서버 관리자가 모든 파일을 바꿀 수 있는 환경에서 변조 불가능성을 보장하지 않는다. 외부 서명 보관·새 물리 장비의 복구와 실제 운영 RPO/RTO는 별도 인수 증거가 필요하다.
- 공개 marketplace·판매자 정산·임의 외부 JavaScript 실행은 이번 관리자 승인 선언형 catalog 범위에 포함하지 않는다.

이미지/CPU 추가 검증: `tests/image-processing.test.ts` 5개는 네 형식의 실제 decode, 손상 입력, 애니메이션 전체 decode, 크기/프레임/바이트 제한, 메타데이터 제거, 원본 불변, 동시/재전송 receipt와 환경 원장을 검증한다. `tests/worker-usage.test.ts`는 실제 source generation/expansion worker의 성공·실패 CPU를 환경별 원장에 한 번 기록하는 것을 검증한다. 기존 승인 업로드 fixture의 손상된 PNG는 실제 디코딩 가능한 PNG로 교체했다. Sharp 선택·런타임·라이선스·native memory 경계는 [이미지 처리 결정](adr/0003-server-image-processing.md)에 기록한다.

저장량의 quota 반환값·`platform_usage`는 모든 프로젝트 환경의 사이트 폴더, 프로젝트 공용 legacy 백업, 귀속 메타데이터가 있는 backup-set/이전 폴더와 릴리스의 물리 합계다. 같은 realpath의 릴리스 별칭은 한 번만 센다. 환경별 실제 `storageBytes` 관측은 선택 dataKey의 사이트 폴더와 동일 조직/workspace/project/dataKey에 귀속된 릴리스·backup-set·이전 폴더, 해당 project/dataKey/environment의 `backup:scope` 근거가 있는 legacy 백업 파일만 센다. 환경 귀속 근거가 없는 공용 legacy 백업을 특정 환경 사용량으로 배분하지 않는다. 중앙 공유 DB·공용 blob은 이 gauge의 측정 범위 밖이다. `tests/storage-usage.test.ts`가 별칭 중복과 다른 환경 제외를 검증한다.
