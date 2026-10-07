# 저장과 마이그레이션

편집기는 .data/studio.sqlite, 결과는 각 output/.site-data.sqlite를 사용합니다. 날짜는 UTC ISO, 원본은 schemaVersion2입니다.

Migration1: projects, project_backups, exports, submissions, table_data, audit와 인덱스. migrations에 적용 이력을 기록합니다. JSON/버전 체크·멱등성 고유 제약을 사용합니다. 배포된 migration1은 수정하지 말고 다음 번호를 추가하세요. 두 역할의 DB가 독립되어 일부 테이블은 사용하지 않습니다.

revision이 낮거나 같은 버전의 다른 내용이면 충돌을 반환합니다. 기존 원본은 백업합니다. undo/redo/복구도 revision을 증가시킵니다. IndexedDB는 projects/backups/evidence를 분리하고 손상 원본은 덮어쓰지 않습니다.

WAL과 5초 busy timeout을 사용합니다. 재생성은 VACUUM INTO 온라인 스냅샷으로 데이터를 보존합니다. 실행 중 .sqlite만 복사하면 WAL 변경을 놓칠 수 있습니다. 실행을 종료한 뒤 복사하거나 Store.snapshot을 사용하세요.

배포 전 DB 백업 → 새 코드 검증/빌드 → 실행 시 새 DB migration1 적용 → 헬스 확인. 롤백은 실행 종료 후 이전 코드와 DB 백업 복원입니다. 다운 마이그레이션 대신 백업 복원을 사용하며 초기화/이력 삭제를 하지 않습니다.

원래 localStorage 값과 초기 소스를 유지합니다. 구 UI는 새 DB 계약을 읽지 못합니다. 저장본과 실패 staging은 자동 삭제하지 않으므로 장기 운영에는 보존 기간·백업·산출물 정리 정책이 필요합니다. 이전 결과 재실행은 이전 데이터 분기를 엽니다.
