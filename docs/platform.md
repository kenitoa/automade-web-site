# 사이트 서비스와 외부 연결

Studio의 운영 패널 > 사이트 서비스에서 계정, 팀 권한, 검토, 외부 연결, 발송 대기함, 상품·주문, 예약, 로컬 플랜 한도를 관리합니다. 기존 편집기와 독립 사이트 실행 구조를 유지합니다.

## 저장과 권한

계정·업무 데이터는 선택한 사이트의 canonical SQLite 저장소에 저장됩니다. Studio API 요청에는 `?projectId=<프로젝트ID>`를 항상 포함합니다. 독립 사이트 서버는 시작 시 정해진 프로젝트 ID를 사용하므로 요청의 다른 ID로 사이트를 바꿀 수 없습니다.

사이트별 HttpOnly·SameSite=Strict 세션 쿠키를 사용합니다. 세션은 8시간, 비밀번호 복구 토큰은 15분·1회, 초대는 7일입니다. 비밀번호는 무작위 salt와 scrypt로 해시합니다. 복구 완료 시 기존 계정 세션을 모두 폐기합니다. CSRF 토큰은 브라우저에서는 메모리에 보관하며 서버 세션에는 SQLite에 저장합니다.

`GET /api/platform/session?projectId=...`의 `csrf`를 `X-Platform-CSRF`에 담고, 변경 요청의 Origin은 서버 origin과 같아야 합니다. Studio는 기존 로컬 소유자 세션과 CSRF 검증을 통과한 요청만 관리 권한으로 인정합니다. Loopback 독립 사이트의 관리 기능은 로컬 소유자 정책을 유지합니다. 인터넷 서비스에서는 실제 계정 로그인·권한이 필요합니다.

owner는 사이트 관리, editor는 검토 요청, reviewer는 검토 결정, operator는 운영·연결·상품·예약, visitor는 본인의 주문·예약을 사용할 수 있습니다. 마지막 owner 제거와 자기 검토 승인을 차단합니다. 관리자 UI를 숨기는 것과 별도로 서버에서 권한과 프로젝트·리소스 소유권을 검사합니다.

회원 페이지·회원 콘텐츠는 공개 HTML과 초기 JSON에 실제 내용을 포함하지 않습니다. 공개 페이지에는 로그인용 안전한 빈 shell과 제목·경로만 포함하며, 로그인한 계정의 `GET /api/platform/member-project`로 공개·회원 콘텐츠를 받습니다. 미발행·숨김 콘텐츠는 이 응답에도 포함하지 않습니다.

## API

응답은 기존 `{data,error,meta:{requestId}}` 계약입니다. 아래 경로는 `/api/platform` 기준입니다. Studio에서는 모든 경로에 projectId query를 붙입니다.

| 메서드 | 경로 | 주요 입력 또는 결과 |
|---|---|---|
| GET | /session | account, csrf, localOwner |
| POST | /accounts | email, password(12~128자), displayName |
| POST | /login | email,password → account,csrf |
| POST | /logout | 세션 폐기 |
| POST | /password-reset/request | email → 고정 안내; 로컬 소유자만 localRecoveryToken |
| POST | /password-reset/confirm | token,password → 기존 계정 세션 폐기 |
| GET | /capabilities | role,canManage,commerce,booking,paymentConfigured,paymentConnectionId |
| GET | /member-project | 로그인한 계정에게만 회원 콘텐츠 |
| GET | /access | 사이트 구성원·초대 목록, owner 권한 |
| DELETE | /access/:accountId | 접근 회수, 마지막 소유자 보호 |
| POST | /invites | email,role → 7일 단회 초대 token |
| POST | /invites/accept | token, 로그인 계정의 이메일 일치 필요 |
| POST | /invites/:id/revoke | 대기 초대 취소 |
| GET/POST | /reviews | 목록 / revision 검토 요청 |
| POST | /reviews/:id/comments | body, 최대 2000자 |
| POST | /reviews/:id/decision | status: approved 또는 changes_requested |
| GET/PUT | /connections | 연결 목록 / name,kind,endpoint,allowedHost,secretRef,webhookSecretRef,mapping,paused |
| POST | /connections/:id/test | GET 응답 도달 확인; 실제 전달 완료 증거는 아님 |
| POST | /connections/:id/pause | paused:boolean |
| GET | /connections/:id/data | 외부 데이터 매핑·5분 캐시, refresh=true로 갱신 |
| GET/POST | /outbox | 상태 목록 / connectionId,eventKey,payload |
| POST | /outbox/process | 준비된 발송 이벤트 최대 10개 처리 |
| POST | /outbox/:id/retry | 실패한 이벤트의 제한된 재시도 예약 |
| GET/PUT | /catalog | 상품 목록 / name,priceMinor,currency,inventory,active |
| GET/POST | /orders | 본인 또는 관리자 목록 / items[{productId,quantity}],idempotencyKey |
| POST | /orders/:id/cancel | 결제 전 주문 취소·재고 복원 |
| POST | /orders/:id/checkout | connectionId → checkoutUrl,verifiedPaid; 공급자 확인 전 false, 이미 확인된 웹훅 상태가 있으면 해당 DB 상태 반영 |
| POST | /orders/:id/refund | amountMinor,idempotencyKey; 공급자 확인 전 requested |
| POST | /orders/:id/reconcile | 서버 공급자 API로 상태 확인 |
| POST | /webhooks/:connectionId | 아래 HMAC 계약 |
| GET/PUT | /booking/resources | 목록 / name,capacity,active |
| GET/POST | /booking/slots | 목록 / resourceId,startsAt,endsAt,capacity |
| GET/POST | /bookings | 본인 또는 관리자 목록 / slotId,quantity,idempotencyKey |
| POST | /bookings/:id/cancel | 예약 취소·정원 회복 |
| GET/PUT | /billing | 로컬 plan,limits; 외부 구독 확인 상태와 분리 |
| GET/PUT | /billing/connection | owner 전용 구독 공급자 connectionId,planCode,priceMinor,currency,periodDays |
| GET/POST | /billing/subscription | owner 전용 상태 / action:start\|cancel\|reconcile,idempotencyKey |
| GET | /billing/invoices | owner 전용 실제 청구서 최근 100건 |
| POST | /billing/webhooks/:connectionId | 플랫폼 구독 전용 namespace와 HMAC 계약 |
| GET | /usage | UTC 월별 실제 사용량 |

상품 수정에는 id와 `expectedUpdatedAt`이 필요합니다. 금액은 최소 통화 단위의 정수입니다. KRW는 원, USD는 센트입니다. 주문 금액·통화·재고는 서버 상품에서 계산하며 클라이언트 결제 완료 표시를 신뢰하지 않습니다. 주문·예약 생성 및 수량 차감은 트랜잭션 안에서 처리하고 동일 요청 키의 다른 내용은 409입니다.

예약 시간은 미래 UTC ISO 시각의 `Z` 형식을 사용합니다. 자원별 겹치는 시간과 정원 초과를 차단합니다. 취소하면 확정 예약 점유가 해제됩니다.

## 외부 공급자 계약

특정 메일·CRM·결제 공급자 가입 또는 원격 배포는 수행하지 않습니다. 아래 공통 JSON 계약을 지원하는 서버 어댑터를 연결해야 합니다. 공급자 고유 API와 다르면 공급자용 어댑터를 먼저 구현·검증해야 합니다.

서버 환경 변수 `PLATFORM_ALLOWED_HOSTS`는 쉼표로 구분한 정확한 호스트 허용 목록입니다. 설정에는 실제 비밀값 대신 `secretRef`와 `webhookSecretRef`의 환경 변수 이름만 저장합니다. 서버 시작 전에 해당 환경 변수를 설정하세요. 비밀값은 공개 Project·프런트엔드 번들·ZIP·로그에 넣지 않습니다. URL에 credential이나 비밀 query를 넣을 수 없습니다.

HTTPS 443, 허용 호스트, 공개 DNS 주소를 검사하고 검사한 DNS 주소로 연결을 고정합니다. Redirect를 따르지 않습니다. HTTPS 요청은 10초 제한이며 사전 DNS 조회 시간은 별도입니다. 응답은 1MB로 제한합니다. 인증은 `Authorization: Bearer <서버 환경 변수>`이며 요청 ID와 Idempotency-Key를 전송합니다.

메일·CRM 연결은 다음 POST를 받아야 합니다.

```json
{"eventId":"...","eventKey":"submission:...","payload":{"type":"form.submitted","submission":{"id":"...","blockId":"...","values":{}}}}
```

문의 저장과 발송 이벤트 enqueue는 같은 DB 트랜잭션입니다. 사이트 실행 중 worker가 5초마다 준비된 이벤트를 처리합니다. 사이트 종료 상태에서는 운영 화면의 대기 발송 처리 기능을 사용할 수 있습니다. 연결 중지 시 이벤트를 보존하고 보내지 않습니다. 429/5xx·연결 오류는 지수 대기로 최대 5회 시도합니다. Lease 만료된 sending 이벤트는 복구합니다. 공급자는 Idempotency-Key로 중복 업무를 방지해야 합니다. `sent`는 2xx API 수락이며 최종 이메일 수신·CRM 업무 완료 증거가 아닙니다. 원격 결과가 불명확하면 공급자 로그를 확인하고 같은 키로 재시도합니다.

비밀번호 복구 이벤트는 `type: account.password_reset`, email, token, expiresMinutes, expiresAt를 포함합니다. 검증 테이블에는 토큰 해시만 저장하지만 발송 대기 payload에는 원본 토큰이 일시적으로 필요합니다. 발송 수락·영구 실패·만료 후 원본 토큰을 제거합니다. worker는 중지된 연결의 만료 토큰도 제거하며, 만료·사용·제거된 안내를 재전송하지 않습니다. 제거된 안내의 재시도에는 새 비밀번호 복구 요청이 필요합니다. 공개 outbox API는 payload를 반환하지 않습니다. 이전 백업에 남은 토큰은 복원되어도 서버의 15분 만료와 1회 사용 검사를 통과해야 합니다. OS 계정·디스크 권한과 DB 백업 접근을 보호하세요. 메일 연결이 없으면 공개 사용자에게 복구 성공을 가장하지 않고 고정 안내만 반환합니다. 로컬 소유자는 인증된 관리 화면에서 복구 토큰을 받을 수 있습니다.

데이터 연결의 GET 결과는 배열 또는 `{data:[...]}`입니다. 최대 1000행, 매핑된 scalar 값만 캐시에 저장합니다. `mapping: {"name":"customer.name"}` 형태로 원격 응답의 필드를 선택합니다. prototype 경로를 거부합니다. 읽기 연결이며 임의 원격 데이터 수정은 제공하지 않습니다.

결제 연결은 다음 POST 작업을 지원해야 합니다.

- checkout: orderId,amountMinor,currency,items → checkoutUrl,paymentId
- refund: orderId,paymentId,amountMinor → 요청 수락 JSON
- status: orderId,paymentId → 아래의 권위 있는 결제 이벤트 JSON

checkoutUrl도 HTTPS 허용 호스트로 제한합니다. 환불 API 응답만으로 환불 완료로 기록하지 않습니다. 서명된 웹훅 또는 서버 status 응답을 확인합니다.

웹훅은 `X-Webhook-Timestamp`(UTC epoch 초 또는 밀리초), `X-Webhook-Signature`(소문자 HMAC-SHA256 hex)를 전송합니다. 서명 원문은 `<timestamp>.<변환하지 않은 JSON 요청 원문>`이며 5분 창을 검사합니다. 웹훅은 CSRF 대신 서명·시간을 검증하지만 Host 경계는 유지합니다.

```json
{"eventId":"provider-event","orderId":"server-order","paymentId":"provider-payment","sequence":1,"amountMinor":12000,"currency":"KRW","status":"paid","refundedMinor":0}
```

sequence는 거래별 증가하는 정수이며 status는 paid/partially_refunded/refunded/cancelled/failed입니다. refundedMinor는 누적 환불 금액입니다. 같은 eventId의 다른 내용, 서버 주문과 다른 금액·통화·거래, 환불 금액 감소, 결제 완료 후 failed/cancelled 전이를 거부합니다. 더 오래된 순서의 이벤트는 저장하고 현재 상태를 되돌리지 않습니다. 부분 환불·전체 환불을 구분합니다. 결제 진행 중 주문을 로컬 판단만으로 취소하지 않습니다.

## 플랫폼 사용료 구독

고객 상품 주문과 플랫폼 사용료는 별도 데이터·명령·웹훅으로 처리합니다. 소유자가 결제 연결과 공급자 플랜 코드·최소 통화 단위의 정수 금액·통화·청구 주기를 설정합니다. 실제 공급자가 이 계약을 지원하는지 먼저 검증해야 하며, 공급자 고유 정기 결제 API에는 별도 어댑터가 필요합니다. 기존 결제 연결의 `secretRef`, `webhookSecretRef`, `PLATFORM_ALLOWED_HOSTS`를 재사용하며 비밀값을 새로 저장하지 않습니다.

공급자는 namespace `platform.subscription`과 아래 operation을 처리해야 합니다. 모든 요청에는 projectId,subscriptionId,providerSubscriptionId,planCode,amountMinor,currency,periodDays가 포함됩니다. Idempotency-Key는 DB에 저장한 명령 ID이며 같은 UI 요청 키의 재시도에도 같습니다.

- `platform.subscription.start`: providerSubscriptionId와 허용된 HTTPS checkoutUrl을 반환할 수 있습니다. 응답의 active나 paid 표시는 구독을 활성화하지 않습니다.
- `platform.subscription.cancel`: 해지를 요청하며 cancelled 응답만으로 완료하지 않습니다.
- `platform.subscription.status`: 아래 권위 있는 구독 이벤트와 같은 JSON으로 상태 대사합니다.

구독 웹훅은 `/api/platform/billing/webhooks/:connectionId`로 전송하고 고객 주문 웹훅과 같은 원문 HMAC·5분 시간창을 적용합니다.

```json
{"namespace":"platform.subscription","eventId":"subscription-paid","sequence":1,"subscriptionId":"local-subscription","providerSubscriptionId":"provider-subscription","amountMinor":12000,"currency":"KRW","status":"active","providerInvoiceId":"provider-invoice","invoiceStatus":"paid","refundedMinor":0,"validUntil":"2026-11-01T00:00:00.000Z"}
```

status는 active/cancelled/past_due, invoiceStatus는 paid/failed/void/partially_refunded/refunded입니다. 청구서 정보는 납부·환불 이벤트에서 필수이며 단순 해지 이벤트에서는 생략할 수 있습니다. 최초 active에는 서버 계약에 맞는 납부 청구서와 미래 UTC 기간이 반드시 필요합니다. 유효 기간이 지난 active는 `remoteBillingVerified:false`로 표시합니다. 확인한 청구서 납부·누적 환불을 되돌리거나, 같은 공급자 청구서 ID를 다른 구독에서 쓰거나, cancelled를 재활성화할 수 없습니다. 중복 eventId의 다른 내용은 충돌이며 오래된 sequence는 저장해도 상태를 변경하지 않습니다.

요청과 청구서는 runtime_state에 영구 저장합니다. 외부 응답이 없으면 pending/unknown을 유지하고 같은 키로 재시도하거나 상태 대사합니다. provider await 중 웹훅이 도착해도 최신 DB 상태를 다시 읽어 이벤트·청구서·확인된 명령을 보존하며 이전 구독의 늦은 응답이 새 구독을 변경할 수 없습니다. 추가 SQL migration은 필요하지 않습니다. 로컬 사용량 한도는 이 계약과 독립적이며, 공급자 검증 없이 자동으로 유료 플랜을 부여하지 않습니다.

## 공개 실행과 복구

기본은 127.0.0.1 로컬 실행입니다. 외부 주소에 바인딩하려면 `SITE_HOST`, 정확한 HTTPS origin인 `SITE_PUBLIC_ORIGIN`, `PLATFORM_ADMIN_EMAIL`, `PLATFORM_ADMIN_PASSWORD`를 함께 설정해야 합니다. `SITE_PORT`는 0~65535입니다. HTTPS TLS 프록시는 원래 Host를 보존해야 합니다. 이 설정은 실제 원격 배포·TLS 인증서·외부 접속·공급자 검증을 대신하지 않습니다.

인터넷 표 쓰기는 로그인한 owner/operator와 플랫폼 CSRF가 필요합니다. 공개 폼은 동일 Origin·입력 검증·속도 제한을 적용합니다. 계정 로그인은 release 쓰기 lease와 독립적이며, 주문·예약·폼·표 등 업무 수정은 활성 release만 허용합니다.

생성 사이트 요청 로그는 JSON으로 requestId,projectId,method,정규화한 경로,durationMs,status,errorCode를 기록합니다. query·동적 리소스 값·정적 임의 경로·본문·쿠키·이메일·복구 토큰을 기록하지 않습니다. `form.submit`과 `table.save`의 성공·실패 및 실제 처리 시간은 해당 canonical DB telemetry에 저장되어 운영 지표에 합쳐집니다. 외부 호출을 기다린 뒤에도 활성 release 쓰기 lease를 재검사합니다.

Migration 3은 추가 테이블만 만들고 기존 데이터를 초기화하지 않습니다. 적용 전 온라인 SQLite 백업을 만들고 이전 코드·백업으로 복구합니다. 이전 migration을 수정하거나 migrations 이력을 삭제하지 않습니다. Source ZIP에는 실제 DB·발송 대기 payload·계정 데이터가 없습니다. 운영 데이터 이동에는 별도의 안전한 DB 백업/복원 기능을 사용합니다.

## 검증 경계

`tests/platform.test.ts`는 scrypt/권한/초대/복구/CSRF, 서버 주문 금액·재고·멱등성, 공급자 이벤트 순서·부분 환불, 예약 정원·충돌, outbox 재시도·중지·토큰 제거, 외부 데이터 매핑·캐시와 await 중 웹훅을 검증합니다. `tests/platform-billing.test.ts`는 별도 구독 납부 확인·청구서·서명·중복/역순·알 수 없는 외부 효과·동시 웹훅·구독 교체를 검증합니다. `tests/site-observability.test.ts`는 로그에서 민감 입력 제거를 검증합니다. 공급자 호출은 테스트 인터페이스로만 대체합니다. 실제 이메일 수신·CRM 기록·상용 결제·정기 청구·환불·공개 HTTPS 운영 성공은 별도의 실환경 검증 항목입니다. 계정이나 환경 설정이 없는 연결을 완료로 보고하지 않습니다.
