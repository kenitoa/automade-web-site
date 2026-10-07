# API

응답: `{data,error,meta:{requestId}}`. 오류는 code·message·requestId이며 스택/SQL 원문은 노출하지 않습니다.

GET /api/session의 HttpOnly·SameSite=Strict 쿠키와 csrf를 사용합니다. 변경 요청에는 정확한 Origin과 X-CSRF-Token이 필요합니다. 토큰은 메모리에만 보관합니다. 이 세션은 로컬 소유자 세션입니다.

| 메서드 | 경로 | 계약 |
|---|---|---|
| GET | /health | 서비스·상태·workspaceId |
| GET | /api/session | csrf와 세션 쿠키 |
| GET / PUT | /api/projects | 목록 / Project 저장 |
| GET | /api/projects/:id/backups | 이전 원본 |
| POST | /api/generate | {name,prompt} → {project,source} |
| POST | /api/exports | {project,idempotencyKey} → 202 {id} |
| GET | /api/exports/:id | status,stage,result,error |
| POST | /api/exports/:id/cancel | 단계 경계 취소 |
| POST | /api/exports/:id/stop | 실행 종료 |
| POST | /api/exports/:id/restart | 재실행, url |
| GET | /api/exports/:id/download | 소스 ZIP, 실제 DB 제외 |
| GET | /api/exports/:id/submissions?limit=50&offset=0 | 문의 목록, limit1..100 |
| GET | /api/operations | 통계·작업·실행·감사·공급자 |
| POST | /api/save-project | 구 저장 경로 호환, 원본만 DB 저장 |

클라이언트 files/filemap/저장 경로는 사용하지 않습니다. 현재 UI는 /api/projects입니다.

독립 사이트: GET /health, POST /api/forms/:id {values,idempotencyKey}, GET /api/tables/:id, PUT /api/tables/:id {rows,expectedVersion}. 폼의 같은 키·같은 내용은 같은 결과이며 다른 내용은409입니다. 표 버전 충돌도409입니다. 공개 블록·저장 대상·Origin을 서버에서 확인합니다. 문의 목록은 공개 사이트 API로 제공하지 않습니다.

외부 생성: POST {prompt,name,schemaVersion:2,constraints} → {project} 또는 {data:{project}}. 20초 제한, 최대32MB, 고정 요청ID/멱등성 키, 429/5xx에1회 재시도, 리다이렉트 금지.
