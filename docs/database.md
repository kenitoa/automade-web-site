# 저장과 마이그레이션

## 시스템 고도화의 추가 마이그레이션

Migration9는 설정/flags·감사·원장·백업·업무 이전, 10은 indexed CMS·불변 발행본·참조·이전 checkpoint, 11은 MFA/일회용 추가 인증·기계 계정·키 버전·지원 세션, 12는 command receipts/outbox/inbox·환경 탐색·큐 예산·추적·승격·실험, 13은 작업 문맥·단계 예산·알림 CAS·저장소 이전, 14는 파일 격리/변형·사용량 관측·개인정보 복원 marker, 15는 IANA 시간대/예약 검토 메타데이터를 추가합니다. 이미 적용한1~8은 수정하지 않습니다.

CMS의 작업본·발행본은 중앙 indexed 저장소가 원본이며 Project JSON은 호환 snapshot입니다. 사이트의 `project:cms`는 publication sequence와 outbox/inbox로 전달합니다. 같은 event ID의 다른 내용과 역순 발행은 거절합니다. 변경과 event, command와 ACK는 각각 같은 로컬 트랜잭션입니다.

저장소 이전의 활성 pointer와 이전 상태는 같은 중앙 트랜잭션으로 전환합니다. 역이전은 활성 DB의 최신 쓰기를 복사·해시 대사하고 이동 전 journal을 남깁니다. 이전 원본과 새 파일을 보존하며 DB를 초기화하지 않습니다. 실제 공급자가 없는 현재는 로컬 SQLite 대상으로 검증합니다. [전체 복구 경계](system-implementation.md)를 참고하세요.

편집기는 .data/studio.sqlite, 운영은 .data/sites/<dataKey>/site.sqlite, 운영 백업은 .data/backups/<projectId>/, 독립 결과는 output/.site-data.sqlite 스냅샷을 사용합니다. 기존 기본 운영 환경은 dataKey=projectId를 유지하며 새 환경은 별도 dataKey를 사용합니다. 공개 실행은 SITE_DATA_FILE의 영속 볼륨을 사용합니다. 날짜는 UTC ISO, 편집 원본은 호환되는 선택 필드가 추가된 schemaVersion2입니다.

Migration1~4의 적용 파일은 유지합니다. Migration2는 영속 생성 작업/활성 릴리스/런타임 상태/문의 처리/운영 백업/보존 정책/성과 이벤트, Migration3은 회원/팀/검토/외부 연결/outbox/데이터 캐시/상품·주문·결제·예약·사용량, Migration4는 표 변경 이력입니다. 추가 Migration5는 제작자·조직/작업공간/사이트/환경·ACL·공유 라이브러리·blob·비밀 저장소·API·자동화·예약 사용량, Migration6은 작업 큐/lease/로컬 세션, Migration7은 예약 대기·반복·휴일·상품 옵션/후처리, Migration8은 credential 발급자/폐기·웹훅 비밀·자동화 실행 스냅샷을 추가합니다. migrations 적용 이력, JSON 체크·외래 키·버전·멱등성 제약을 사용합니다. 기존 DB에 새 마이그레이션이 있으면 VACUUM INTO로 `.before-upgrade-<UTC>-<ID>.sqlite` 백업을 먼저 만듭니다. 실패 시 해당 마이그레이션을 롤백하며 DB를 초기화하지 않습니다.

revision이 낮거나 같은 버전의 다른 내용이면 충돌을 반환합니다. 기존 원본은 백업합니다. undo/redo/복구도 revision을 증가시킵니다. IndexedDB는 projects/backups/evidence를 분리하고 손상 원본은 덮어쓰지 않습니다.

관리형 원본 저장은 `{project,baseRevision}` CAS 계약이며 신규는 -1입니다. 제작자별 IndexedDB와 서버/로컬/base의 ID 기반 병합 검토를 사용합니다. 승인 상태는 서버가 확정하므로 전체 원본 PUT으로 승인/발행을 위조할 수 없습니다. CMS 실제 운영 스냅샷은 사이트 DB의 `project:cms`에 반영합니다.

WAL과 5초 busy timeout을 사용합니다. 재생성은 VACUUM INTO 온라인 스냅샷으로 데이터를 보존합니다. 실행 중 .sqlite만 복사하면 WAL 변경을 놓칠 수 있습니다. 실행을 종료한 뒤 복사하거나 Store.snapshot을 사용하세요.

배포 전 DB 백업 → 새 코드 검증/빌드 → 이전 쓰기 종료 → 시작 시 미적용 번호만 순서대로 트랜잭션 적용 → 헬스 확인. 다운 마이그레이션을 제공하지 않으며 적용 파일·기록을 수정하지 않습니다. 이전 앱이 추가 필드를 보존하지 못할 수 있으므로 앱 버전 롤백은 백업과 별도 환경에서 먼저 검증합니다. 정상 디자인 롤백은 최신 코드로 이전 디자인의 새 릴리스를 생성하며 최신 운영 DB를 유지합니다.

운영 백업 복원은 현재 데이터의 before-restore 온라인 백업 → 모든 사이트/worker 연결 종료 → 선택 백업 quick_check → 임시 스냅샷 → WAL checkpoint → 파일 교체 → 활성 릴리스 복원 순서입니다. 기존 파일은 `.before-<ID>`로 유지하며 교체 실패는 기존 파일로 되돌립니다. 복원 후 실행 사이트를 운영 화면에서 다시 실행합니다. 데이터 백업에는 회원·주문 등 개인정보가 포함될 수 있습니다.

복원/이전은 SHA256·연속 migration1~8·정확한 테이블/제약·foreign_key_check·프로젝트 귀속·실행 SQL 배제까지 검증합니다. 원본 백업은 변경하지 않습니다. DB 이전의 JSON 패키지는 최대16MB 입력을 지원합니다. 복원 후 주문·결제·환불·예약 건수/차이를 기록하며 차이가 있는 거래는 공급자 대사 완료까지 결제·환불·후처리를 막고 알림을 보류합니다. 여러 로컬 coordinator가 같은 DB를 사용하면 각 serving/DB 핸들의 공유 lease를 먼저 해제해야 파일 교체가 가능합니다. 다른 프로세스가 사용 중이면409로 거절합니다.

운영 DB 이전에는 중앙 제작자 세션·비밀 저장소·암호화 키를 포함하지 않습니다. blob은 중앙 파일 저장소에 남으며 독립 생성 전에 실제 바이트로 해석합니다. 암호화 키 `.data/keys/expansion.key`와 중앙 blob 디렉터리는 DB 백업과 별도로 보호/백업합니다. PostgreSQL 전환은 실제 공급자 선정과 이전/장애 검증을 거친 다음 단계이며 현재 구현은 SQLite입니다.

원래 localStorage 값과 초기 소스를 유지합니다. 보존 정책은 후보·용량 경고와 가역 격리를 지원합니다. 활성/실행/생성 중 결과와 최신2개 결과·백업은 보호합니다. 영구 삭제나 DB 원문 삭제는 수행하지 않습니다. 격리는 물리 디스크 사용량을 줄이지 않으므로 별도 검토 후 운영자가 보관·삭제 정책을 정해야 합니다. [보존](retention.md)을 참고하세요.
