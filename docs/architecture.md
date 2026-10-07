# 구조와 데이터 흐름

| 책임 | 구현 |
|---|---|
| Presentation | editor UI, runtime SiteApp, HTTP 경계 |
| Application | useStudio, useGeneration, 생성 단계 조정 |
| Domain | 버전2 계약, 파서, 품질 규칙, 편집 명령, 템플릿 |
| Infrastructure | IndexedDB, SQLite, esbuild, HTTP 서버, 공급자 어댑터 |

Project는 React/DOM을 저장하지 않습니다. 외부 입력은 unknown에서 검증하고 편집 명령은 불변 상태로 처리합니다.

SiteApp은 캔버스·미리보기·생성 사이트에 공유합니다. 선택/크기 조절 UI는 decorate로 감쌉니다. document.tsx는 초기 생성과 결과 소스 재빌드에 공유합니다. publicProject는 비공개 페이지, 숨김 블록과 자손, 미사용 이미지를 공개 HTML에서 제거합니다. 원본은 파일로 유지하고 정적 서버는 dist만 제공합니다. 전역 메뉴·푸터는 pageId="*"입니다. 동작은 제목 대신 ID를 참조합니다.

생성: 원본 검증 → 오류 차단 → 고유 staging → 소스/번들 → DB 스냅샷 → 원자적 승격 → 독립 서버 → 헬스 → ready.
실패 시 이전 결과와 원본을 유지하고 staging을 실행하지 않습니다. 전체 동시 생성2개, 동일 프로젝트1개, 실행 사이트20개로 제한합니다. 취소는 단계 경계에서 확인합니다.

스냅샷 경계에서 이전 사이트 쓰기를 정지하며 실패하면 복구합니다. 성공하면 이전 사이트는 읽기 전용입니다. 독립 SQLite 쓰기는 트랜잭션·고유 제약·버전 확인을 사용합니다.

새 블록은 catalog/types, validation, 공통 runtime, Inspector와 동등성 테스트를 함께 변경하세요. 외부 공급자는 JSON Project 계약에 맞춰 교체합니다. 공용 회원/결제 서비스는 소유권·서버 인가·외부 이벤트·비밀 관리와 별도 배포 설계가 필요합니다.
