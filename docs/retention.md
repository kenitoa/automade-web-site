# 보존·격리와 표 변경 이력

운영 > 백업의 보존 관리에서 오래된 결과·실패 작업 폴더·데이터 백업을 검사하고 격리·복원할 수 있습니다. 영구 삭제나 운영 DB 레코드 삭제를 하지 않습니다. 격리는 같은 저장소의 `.quarantine/<프로젝트>/<격리ID>/`로 이동하므로 실제 디스크 공간을 줄이지 않습니다. 디스크 경고는 별도 안전한 데이터 이전·보관 검토를 위한 안내입니다.

## 보존 정책과 보호 범위

`automaticCleanup` 기본값은 false입니다. 켜서 저장하면 즉시 안전한 후보를 격리하고, 실행 중 1분마다 정책을 확인합니다. 자동 정리는 파일 검사·보호 확인·가역 격리만 수행합니다. 실패한 이동을 무한 자동 반복하지 않으며 운영자가 원인을 해결한 뒤 미리보기에서 다시 선택할 수 있습니다.

보호하는 항목은 활성 릴리스, 실행·생성·다운로드·배포 사용 중 예약된 릴리스, 현재 사이트 DB, 실제 파일이 존재하는 최신 정상 결과 2개와 최신 백업 최소 2개입니다. 생성 중인 프로젝트는 정리하지 않습니다. 파일이 사라진 백업 메타데이터를 정상 백업 개수로 세지 않습니다. 문의·감사 기록은 기간을 기준으로 검토 개수를 표시하고 원문을 삭제하지 않습니다.

exports/<releaseId>, exports/.<jobId>.staging, DATA_DIR/backups/<projectId>/<backupId>.sqlite의 이미 기록된 경로만 검사합니다. 허용 저장소 내부의 realpath와 예상 위치가 일치해야 하며 symlink·junction·외부 경로·루트 자체를 이동하지 않습니다. client가 보내는 절대 경로나 파일 경로는 사용하지 않습니다. 이동 직전 활성·실행 보호를 다시 검사합니다.

이동 상태는 runtime_state에 moving/quarantined/restored/failed로 기록합니다. 재시작 시 moving 기록과 실제 격리 파일을 대조합니다. 복원은 원래 위치가 비어 있을 때만 허용하고 기존 파일을 덮어쓰지 않습니다. 이미 격리된 릴리스는 실행·다운로드 전에 명확한 상태 오류를 반환하고 복원을 안내합니다.

## API

기존 Studio 로컬 소유자 세션과 CSRF 보호 안에서 호출합니다.

| 메서드 | 경로 | 계약 |
|---|---|---|
| GET/PUT | /api/projects/:id/retention | 현재 정책 / 기간·경고 용량·automaticCleanup 저장 |
| GET | /api/projects/:id/retention/preview | 안전한 후보, 보호 수, 실제 용량, 기간 검토 건수, 경로 오류 |
| POST | /api/projects/:id/retention/quarantine | {candidateIds:["artifact:...","backup:..."]}, 최대 100개, 서버 재검사 |
| GET | /api/projects/:id/retention/quarantines | 경로 비밀값이 없는 격리·복원 이력 |
| POST | /api/projects/:id/retention/quarantines/:quarantineId/restore | 원래 위치로 복원, 덮어쓰기 금지 |

정책이 바뀌거나 대상이 보호 상태로 바뀌면 오래된 미리보기 선택을 그대로 실행하지 않고 제외합니다. 데이터 원문과 SQL migration 이력을 변경하지 않습니다.

## 표 변경 이력

독립 사이트의 표 PUT은 버전 확인·열 규칙 검사·현재 행 저장·이전/새 행·변경자·UTC 시각 이력 저장을 같은 트랜잭션으로 처리합니다. 충돌·읽기 전용 열 위반·활성 릴리스 위반이면 현재 행과 이력을 모두 유지합니다. 기존 GET/PUT 표 계약은 호환됩니다.

`GET /api/tables/:blockId/history?limit=10&beforeVersion=<cursor>`는 owner/operator 또는 로컬 소유자에게만 제공합니다. `items`는 version,previousRows,rows,actorId,createdAt이고 nextCursor로 이전 페이지를 조회합니다. 기본 10개·최대 50개이며 약 8MB 기준으로 페이지를 나눕니다. 첫 변경 기록 하나가 기준보다 크면 해당 기록은 온전히 반환합니다. 기존 버전0 저장본은 첫 실제 수정의 previousRows로 보존합니다. 공개 방문자에게 변경 전 원문을 노출하지 않습니다.

표 조회에 `?limit=1..100&offset=0&query=검색어&sortColumn=열ID&direction=asc|desc`를 지정하면 서버가 검색·숫자/날짜/텍스트 정렬·페이지네이션을 수행하고 `{version,rows,total,limit,offset}`를 반환합니다. limit이 없으면 기존 `{version,rows}` 전체 조회를 유지합니다. 검색어는 최대 200자이며 열 ID와 정렬 방향을 검증합니다. 같은 값은 원래 행 순서를 유지하고 빈값은 뒤에 정렬합니다. 현재 런타임의 기본 표 UI는 기존 최대 행수로 제한된 전체 조회와 클라이언트 페이지네이션을 사용하며, 이 API로 무제한 외부 데이터 처리를 가장하지 않습니다.

Migration 4는 table_history를 추가하고 기존 표·DB 데이터를 초기화하지 않습니다. 백업에 이력을 함께 포함합니다. 이전 코드로 롤백하려면 실행 종료와 migration 적용 전 안전 백업을 사용하며 적용된 migration 파일을 수정하거나 기록을 지우지 않습니다.

`tests/retention.test.ts`는 보호 범위, 실제 백업 최소 개수, 자동 격리 동작, 가역 복원·덮어쓰기 방지, 외부 경로/junction 거부, 표 변경 전·후 원자성·충돌·cursor를 검증합니다.
