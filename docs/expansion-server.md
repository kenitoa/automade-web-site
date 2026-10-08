# 중앙 Studio HTTP 경계 검증

검증일: 2026-10-07. 이 문서는 확장 backend의 실제 compiled entrypoint 검증을 기록한다. 최종 전체 저장소 검증 결과는 root의 최종 보고서를 따른다.

## 실행

```powershell
node scripts/build-service.mjs
npx.cmd tsx --test tests/managed-studio.test.ts
npx.cmd tsx --test tests/expansion.test.ts tests/expansion-reconciliation.test.ts
npx.cmd eslint server/expansion server/platform src/domain/expansion.ts src/editor/BusinessExpansionPanel.tsx tests/expansion.test.ts tests/expansion-reconciliation.test.ts tests/managed-studio.test.ts
npm.cmd run typecheck
```

관리형 테스트는 handler 직접 호출 대신 `dist-service/server.mjs`를 별도 Node 프로세스로 실행한다. random 임시 DATA_DIR/EXPORT_DIR과 localhost port를 사용하므로 기존 `.data`/사이트 운영 DB에 쓰거나 초기화하지 않는다. 테스트 종료 후 child process를 정지하고 이번 테스트가 만든 검증된 temp root만 제거한다.

환경은 APP_MODE=managed, STUDIO_HOST=127.0.0.1, HTTPS STUDIO_PUBLIC_ORIGIN, bootstrap 제작자 계정, 별도 EXPANSION_SECRET_KEY이다. 실제 HTTP 연결은 loopback에 보내고 node:http로 configured public Host·Origin·cookie·CSRF를 전달하여 TLS proxy 뒤 애플리케이션 경계를 재현한다. 실제 DNS/공개 TLS 인증서·proxy 배포를 검증한 테스트가 아니다. 브라우저 fetch의 Host 덮어쓰기 제한을 회피하기 위해 이 테스트는 node:http를 사용한다.

## 확인한 동작

- 관리형 `/api/session`의 익명 요청에 local owner를 부여하지 않는다.
- 위조 local owner cookie로 프로젝트에 접근하면 401이다.
- 중앙 제작자 session이 익명 nonce를 발급하며, nonce 없이 login POST는 403이고 유효 login은 session/nonce를 교체한다.
- 공개 가입이 닫힌 관리형 환경에서도 유효한 이메일 초대로 중앙 계정을 만들고 실제 멤버 권한을 받는다.
- 관리형 project PUT의 baseline 누락은 400, stale baseline은 409이다.
- 실제로 생성한 서로 다른 두 조직과 작업공간의 멤버는 허용된 프로젝트만 목록/조회한다.
- 다른 조직 프로젝트 조회·생성 export·운영 backup·export 제출 CSV는 403이다. CSV 검증에 사용한 ready export metadata는 테스트용 접근 경계 fixture이며 실제 원격 배포 성공을 뜻하지 않는다.
- 프로젝트 범위가 없는 managed platform 관리 요청은 400이다.
- 초안 생성은 workspace 누락 시 400, 해당 workspace의 project.create 권한이 없으면 403이다. 허용 프로젝트의 AI 설정 조회는 read 권한으로 가능하다.
- query의 허용 projectId와 제출한 raw Project가 다르면 PUT·legacy save·export·AI proposal을 모두 403/SCOPE_MISMATCH로 막는다.
- full Project PUT으로 CMS 내용을 변경하면서 published/approvedRevision을 위조하면 서버가 draft로 저장한다.
- 신규 CMS record가 workflow 없이 published를 보내도 managed 서버는 draft로 저장한다.
- workspace requireApproval 정책에서는 현재 문서 검토 승인 없이 export가 409/PUBLICATION_APPROVAL로 거절된다.
- child stdout/stderr에 입력한 비밀번호 원문이 없음을 확인한다. 이것만으로 전체 PII 로그 감사를 대체하지 않는다.
- 실제 vault secret 등록과 payment 연결 구성 후 cookie 없는 unsigned callback은 401/WEBHOOK_SIGNATURE로 거절한다. 정상 HMAC callback은 200이며 실제 canonical order가 paid로 전이된다. 다른 프로젝트의 environment를 섞은 callback은 403이다. 공급자 접속은 fixture transport이고 실제 카드 청구가 아니다.

`tests/managed-studio.test.ts`: 1개 통과. `tests/expansion.test.ts` + `tests/expansion-reconciliation.test.ts`: 18개 통과. 확장 서버/플랫폼·공유 DTO·독립 업무 UI·위 테스트 파일의 scoped ESLint 통과. `npm.cmd run typecheck` 통과. 이후 변경이 있으면 최종 root 결과의 명령 시점/결과를 우선한다.

## 운영 설정

| 설정 | 용도 |
|---|---|
| APP_MODE | local/managed. local Studio는 loopback만 허용 |
| STUDIO_HOST, STUDIO_PUBLIC_ORIGIN | managed bind와 정확한 HTTPS origin, 별도 TLS proxy 필요 |
| STUDIO_ADMIN_EMAIL, STUDIO_ADMIN_PASSWORD | 초기 중앙 제작자 관리자, managed에서 필수 |
| STUDIO_ALLOW_REGISTRATION | true인 경우 공개 제작자 가입. 기본 닫힘; 유효 초대 가입 허용 |
| EXPANSION_SECRET_KEY | 64hex AES vault key. managed 명시 설정, 복구 시 같은 키 필요 |
| STUDIO_MAIL_ENDPOINT, STUDIO_MAIL_ALLOWED_HOST, STUDIO_MAIL_SECRET_REF | 중앙 제작자 reset 실제 mail provider 설정. 3개 함께 필요 |
| AUTH_* | 중앙 mail secret 참조 원문은 서버 env만 사용. 사이트 TENANT_*와 분리 |
| PLATFORM_ALLOWED_HOSTS | provider HTTPS host 허용 목록. 중앙 메일 host도 포함 |
| DATA_DIR, EXPORT_DIR | 지속 저장/실제 blob 및 생성 artifact 위치 |

메일 미설정 시 일반 reset 요청은 `{requested:true,delivery:'not-configured'}`를 반환한다. 구성되면 actual outbox enqueue 결과인 `pending`을 반환하고 delivery 상태는 별도로 확인한다. 등록되지 않은 이메일에도 동일 공개 응답을 사용한다. 승인된 local owner의 localRecoveryToken은 개발/로컬 복구 경로이며 managed에서는 반환하지 않는다.

클라우드 게시, 실제 메일 수신, 실제 결제/환불, 공개 TLS·DNS·다중 호스트/Postgres 부하·외부 사용자 검증은 이 테스트에서 수행하지 않았다.
