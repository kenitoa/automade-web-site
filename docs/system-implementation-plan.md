# H01~H48 구현 실행 계획

2026-10-07. 사용자가 [전체 시스템 기획](system-advancement-plan.md)의 반영을 승인했다. 기존 R/E 변경·화면·원본·운영 데이터·API를 유지한다. 제공자/도메인/배포 대상 미정 선택도 유지하며 로컬 구현과 실제 외부 운영 증거를 구분한다.

## 책임과 구현 순서

1. 현재 계약·데이터·권한을 확인하고 추가 migration9~15의 경계를 정한다. 실제 DB 적용 전 온라인 백업을 만들며 기존 migration1~8은 수정하지 않는다.
2. root는 runtime 계약·policy 연결·작업 문맥·원자 command receipts·DB간 전달/inbox·전체 환경 discovery·큐 자원배분·readiness/trace·릴리스 승격·실험·측정/장애훈련/CI를 구현한다.
3. domain 담당은 CMS indexed 레코드/발행본·모델 이전·참조/주소·시간대·번역/블록/팩 계약·artifact/runtime 무결성을 구현한다.
4. backend 담당은 변경설정·flags·MFA/stepup·service identities·env secret/keyring·감사/개인정보·workflow simulation·provider resilience·원장/사용량·backup sets·lifecycle/catalog를 구현한다.
5. editor 담당은 기존8메뉴에 실제 API 업무·durable command journal·문맥 복원·semantic review·성능/접근성·실험을 연결한다.
6. 각 담당은 관련 테스트/문서를 갱신하고 root가 전체 lint/type/test/build/E2E/독립 결과물/부하/장애 검사와 실제 기존 데이터 보존을 확인한다.

## 데이터 흐름

현재 actor/scope 검증 → 입력/CAS/stepup/flag 검사 → 원본/command receipt/event 동일 DB transaction → leased dispatcher → 목적지 inbox 멱등적용 → worker/외부결과 대사 → 공개 revision/hash 확인 → operation/metrics/UI ack. 과거 정책 version은 감사용이며 현재 권한을 대신하지 않는다.

## 영향 컴포넌트

server/advancement 및 expansion/platform usecases, Store/migrations, WorkQueue/Operations/Deployment, generator/siteServer, domain/runtime, editor/infrastructure, launcher/build/CI와 docs/tests. 실제 공유되지 않는 패키지나 무조건적인 서비스 분리는 만들지 않는다.

## 위험과 복구

- migration/데이터 이전은 additive → 복사/대사 → 읽기전환이며 초기화·기존 적용 migration 변경은 하지 않는다.
- CMS 작업본과 불변 발행본을 분리해 초안 변경이 정상 공개본을 지우지 않게 한다.
- 여러 DB는 하나의 transaction으로 가정하지 않고 outbox/inbox/sequence와 실제 재시작 복구를 검사한다.
- unknown 외부효과는 단순 boolean 확인으로 반복하지 않고 증거/대사로 재개한다.
- 비밀 원문/master key는 UI/로그/Project/일반 ZIP에 포함하지 않는다. 키 회전/백업복원은 필요한 키와 최신 폐기 기록을 보존한다.
- 디자인 복귀는 최신 고객 DB를 유지하고 데이터 복원은 별도 candidate/직전backup/대사 절차로 진행한다.
- 공개/TLS/provider/다중호스트/실기기 결과는 해당 환경에서 검증될 때만 완료다. 조건부 도입 경로·계약·설정·로컬 rehearsal은 구현한다.

## 검증과 인수

기존152unit/integration·30browser는 직전 기준선이며 최종 변경 뒤 다시 실행한다. 새 검사에는 late response/receipt replay, record CAS/publication, migration/refs/timezone, outbox 각commit간 crash, 未open환경 재시작, currentACL/stepup/revocation, master key rotation, workflow dryrun, unknown evidence, envpromote, backuprestore, load/soak/kill/disk fixture와 독립runtime hash가 포함된다. 실패/미검증은 구현 기록에 구분한다.
