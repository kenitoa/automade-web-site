# H01~H48 시스템 고도화 구현 기록

2026-10-09 최종 로컬 통합 검증: 타입·린트·227개 단위/통합·빌드·42개 Chromium·독립 결과물·1만 건 SQL fixture·4개 장애 훈련·의존성 검사 모두 통과했다. 검증 시작·종료·빌드·실제 로컬 서버의 소스 해시가 일치한다. 기존 작업 DB migration8→15 적용 전 백업 무결성을 검사했고, 기존 프로젝트/제출 건수와 원시 데이터 지문을 적용·서버 기동 뒤 보존했다. 현재 주소는 http://127.0.0.1:5173/ 이다. 명령·수치·산출물·남은 운영 조건은 [최종 검증 기록](verification.md#2026-10-09-h01h48-최종-로컬-검증)에 있다.

기존 상단·8개 메뉴·캔버스·속성 패널과 R/E 기능을 유지하면서 [승인된 시스템 기획](system-advancement-plan.md)을 반영했다. 제공자·배포 대상·도메인이 미정이라는 선택은 유지한다. 아래 구현과 자동 검사는 로컬 실행의 근거이며 실제 공급자 전달이나 공개 운영의 증거는 아니다.

## 구현 경로

| 업무 | 구현과 연결 |
|---|---|
| 계약·저장·재접속 | 빌드 소스 해시/IPC/API 계약, 유스케이스 권한, 공통 작업 문맥, 변경 단위 CAS와 동일 트랜잭션 ACK, 제작자별 IndexedDB 명령 journal·재생·충돌 검토 |
| 콘텐츠 | SQL 범위/정렬/cursor, 레코드 단위 revision, 불변 발행본, 승인·예약 worker, 영속 스키마 검토·배치 이전, 참조 그래프·언어 주소 이력·구조적 공유 변경 |
| 보안·팀 | 환경 설정 CAS·플래그, 관리형 TOTP/복구 코드와 일회용 추가 인증, 기계 계정, 버전별 환경 비밀과 키 회전, 개인정보 복원 marker, 기간·범위가 정해진 지원 세션 |
| 작업·업무 | outbox/inbox의 멱등 전달과 전체 환경 재탐색, 영속 큐의 실행 풀·공정성·기한·단계 예산, 시뮬레이션, unknown 근거 대사, 금액/사용량 원장, DST 예약 규칙과 변경 검토 |
| 검수·공개·복구 | 포함 런타임/소스/lock/배포 파일 해시, 선택적 Ed25519 서명, 불변 artifact의 로컬 환경 승격, 인증·기간·폐기가 적용된 정적 검수 주소, 공급자 조건부 승인 릴리스 파이프라인, DB/blob/key-ID/artifact 백업 집합 |
| 운영·확장 | readiness/drain, 요청·worker 추적과 OTLP 전달, scoped 장애·알림 기준, SQLite shadow 복사·검증·전환·새 쓰기를 포함한 역이전, 조직 인계/보관·catalog 승인, 실험 배정·최소 표본·오류 보호 기준 |

구현 위치와 테스트 연결은 [48개 항목별 증거 목록](system-evidence-matrix.json)에 기록한다. 상세 설명은 [콘텐츠·산출물](system-domain-implementation.md), [서버·업무·보안](system-backend-implementation.md), [편집기](system-editor-implementation.md), [승인 배포](system-release-pipeline.md)를 따른다.

## 일관성과 복구 경계

중앙 원본 변경과 outbox 등록은 같은 로컬 DB 트랜잭션이다. 다른 환경 DB 전달은 event ID·payload 해시·publication sequence와 inbox로 중복/역순을 다룬다. 중앙 DB와 환경 DB를 하나의 원자 트랜잭션으로 취급하지 않는다. 화면을 열지 않아도 영속 환경 목록과 cursor로 복구한다.

CMS의 authoritative source는 indexed 저장소이다. Project JSON은 호환 snapshot이며 임의 저장으로 승인이나 새 모델 이전을 확정하지 못한다. 기존 승인·예약 흐름은 현재 승인자·발행자 권한을 재검증하는 어댑터를 사용한다. 예정 시각이 지났다는 사실만으로 canonical 공개본을 교체하지 않는다.

승격 검토는 artifact SHA, 대상 config revision, 기능 flag revision, 활성 secret version/key ID와 지원 DB schema를 포함한다. 실제 실행 전에 같은 지문을 다시 검사한다. Node 승격은 원본 결과물의 바이트를 변경하지 않고 환경 활성화를 별도로 기록한다. 고객 DB는 최신 상태를 유지한다. 정적 결과물의 다른 공개 주소는 SEO 변형 빌드가 필요하다. 외부 배포에는 해당 공급자의 별도 활성화 manifest 계약이 필요하며 원본 release ID와 다른 별칭을 원본으로 배포하지 않는다.

로컬 저장소 역이전은 현재 활성 DB의 새 쓰기를 다시 복사한다. 이전 파일 이동 전에 복구 journal을 저장하며, 중간 종료 시 활성 shadow DB와 보관 원본을 유지한다. 백업 복원은 대상 파일 해시가 다르면 덮어쓰기를 거절한다. 키 원문은 일반 백업/ZIP에 포함하지 않으므로 별도 안전한 키 보관이 필요하다. 다른 물리 장비에서 경로/키를 복구하는 검증은 별도다.

## 실행과 증거

```bash
npm ci
npx playwright install chromium
npm run verify:system
npm audit --audit-level=high
```

`verify:system`은 타입·린트·전체 단위/통합·빌드·Chromium·독립 결과물·CMS 부하·실제 프로세스 장애 훈련을 순서대로 실행한다. 결과는 `.data/system-verification.json`, 각 명령 로그는 `.data/system-verification/`이다. 개별 실패를 숨기지 않으며 전체 성공 여부와 실행 코드/시간을 기록한다. 요구사항에 연결된 코드/테스트 파일의 존재도 확인한다.

독립 검사는 `.data/delivery-verification.json`, CMS 부하는 `.data/system-capacity.json`, 편집기 측정은 `.data/system-editor-capacity.json`, 장애 훈련은 `.data/system-drills.json`에 기록한다. 각 수치에는 fixture·기계·런타임·방법을 붙인다. 단기 로컬 부하를 운영 용량/SLA/장기 안정성으로 표시하지 않는다. SQLite quota 오류는 OS 디스크 전체 고갈과 다른 증거이다.

## 환경과 마이그레이션

기존 migration1~8은 유지하고 9~15를 순서대로 추가한다. 실제 저장소 업그레이드 전 온라인 백업과 기존 원본/제출 건수·SHA 비교를 수행한다. 새 코드 적용 뒤 15개 migration과 readiness를 확인한다. 롤백은 새 DB를 구버전 앱에 바로 연결하는 방식이 아니라 백업·지원 코드·작업 drain·외부효과 대사를 포함한다.

비밀키 ring, 선택적 artifact 서명, OTLP 수집기, 조건부 배포 게이트웨이 설정 이름은 `.env.example`에만 기록한다. 실제 값은 운영 환경에서 관리한다. 기본 로컬 실행은 http://127.0.0.1:5173/ 이며 `start-site.cmd`가 소스/빌드 해시가 다른 오래된 서버를 재사용하지 않는다.

## 별도 환경에서 확인할 사항

실제 AI/메일/CRM/결제와 provider invoice/token, 공개 HTTPS·DNS·배포 SHA, 원격 GitHub Actions 실행, Docker/Linux·다중 호스트·외부 DB/객체 저장소/큐, 물리 장비 복원, 실제 인증 앱/스크린 리더/휴대폰, 장기 soak와 운영 RPO/RTO는 현재 로컬 증거와 구분한다. 외부 악성 파일 스캐너는 별도 연결이다. 지원 한도와 기획 성능 목표는 측정 조건을 붙여 조정하며 무제한 규모나 보장 SLA를 안내하지 않는다.
