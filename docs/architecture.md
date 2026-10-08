# 구조와 데이터 흐름

| 책임 | 구현 |
|---|---|
| Presentation | editor UI, runtime SiteApp, HTTP 경계 |
| Application | useStudio/useGeneration, OperationsService, DeploymentService, 플랫폼 유스케이스 |
| Domain | 버전2 계약, 품질 규칙, 콘텐츠/CMS, 편집 명령, 제안 범위, SEO |
| Infrastructure | IndexedDB, SQLite, 영속 작업, esbuild, 제한된 HTTPS 공급자, outbox |

Project는 React/DOM을 저장하지 않습니다. 외부 입력은 unknown에서 검증하고 편집 명령은 불변 상태로 처리합니다.

SiteApp은 캔버스·미리보기·생성 사이트에 공유합니다. 선택/크기 조절 UI는 decorate로 감쌉니다. document.tsx는 초기 생성과 결과 소스 재빌드에 공유합니다. publicProject는 비공개 페이지, 숨김 블록과 자손, 미사용 이미지를 공개 HTML에서 제거합니다. 원본은 파일로 유지하고 정적 서버는 dist만 제공합니다. 전역 메뉴·푸터는 pageId="*"입니다. 동작은 제목 대신 ID를 참조합니다.

생성: 원본 검증 → 오류 차단 → 고유 staging → 소스/번들 → DB 스냅샷 → 원자적 승격 → 독립 서버 → 헬스 → ready.
실패 시 이전 결과와 원본을 유지하고 staging을 실행하지 않습니다. 전체 동시 생성2개, 동일 프로젝트1개, 실행 사이트20개로 제한합니다. 취소는 단계 경계에서 확인합니다.

스냅샷 경계에서 이전 사이트 쓰기를 정지하며 실패하면 복구합니다. 성공하면 이전 사이트는 읽기 전용입니다. 독립 SQLite 쓰기는 트랜잭션·고유 제약·버전 확인을 사용합니다.

편집 원본은 schemaVersion2의 선택적 필드로 확장하여 기존 파일을 읽는다. CMS 초안·브리프·저장 섹션·회원 전용 내용은 공개 HTML에서 제거하고, 회원 전용 내용은 인증된 member-project API에서만 전달한다. 표·차트·폼 검증과 SEO 문서는 편집기와 산출물에 공유한다. AI 제안은 텍스트/번역/레이아웃/모바일 허용 필드만 적용하며 운영 데이터·권한·행동 설정을 보존한다.

프로젝트 운영 DB는 생성 디렉터리와 분리한다. SQLite에 생성 요청/단계/결과/활성 릴리스를 기록하며 재시작은 interrupted 상태를 남기고 재시도한다. 데이터 스냅샷 동안 쓰기를 잠시 정지하고 활성 릴리스 전환은 DB lease로 모든 이전 런타임에 적용한다. outbox는 저장 트랜잭션에 함께 기록하고 lease·멱등성·제한된 재시도를 사용한다. 주문·예약·사용량도 서버 규칙과 트랜잭션으로 처리한다.

새 블록은 등록 계약에서 기본값·validation·속성·런타임·참조·공개 projection·버전/내보내기를 연결하며 SDK 검사와 동등성 테스트를 통과해야 한다. 임의 외부 JavaScript 실행은 허용하지 않는다. [확장 SDK](extension-sdk.md)를 참고한다. [플랫폼](platform.md)과 [공개 배포](public-deployment.md)는 실제 공급자 계약·인증·운영 경계를 설명한다.

## 확장 구조

organization은 소유/과금, workspace는 업무·승인 정책, project는 제작 원본, site는 운영 단위, environment는 연결·DB·릴리스 경계이다. 기존 ID와 기본 운영 DB는 보존한다. 명시적 managed 모드는 중앙 creator 인증·ACL·CAS를 거치며 visitor 계정과 분리한다. 원격 도메인/TLS와 실제 공급자 검증은 배포 대상 선택 후 수행한다.

ExpansionService가 등록/권한/CMS승인/라이브러리/자산/비밀/API/자동화의 usecase를 조정한다. 블록 registry·버전 pins·공유 instance·CMS type/state·BCP47·세 영역 병합은 domain으로 분리한다. 기존 메뉴는 capability에 따라 실제 서버 기능을 표시하며 새 패널을 lazy load한다.

HTTP/API coordinator → 영속 WorkQueue → fenced lease 소유의 별도 generation/expansion worker → canonical 환경 DB·outbox → serving worker → 실제 health/활성화 흐름이다. 생성2슬롯·프로젝트 exclusive 보호는 DB lease로 공유한다. serving은 artifact/data shared lease를 매 요청 확인하고 정리/복원은 exclusive 보호를 획득한다. 다른 프로세스가 DB를 사용하면 복원을409로 차단한다.

CMS 정적 HTML은 bounded snapshot을 사용하고 실제 서버는 승인한 최신 `project:cms`를 조회한다. 목록은 cursor/검색/정렬, 상세는 snapshot 밖의 레코드도 SSR하며 sitemap은 전체 공개 URL을 분할한다. 회원/초안/비공개 필드는 공용 응답에서 제거한다. data binding은 실제 연결의 허용 mapping만 public projection에 전달한다.

독립 결과는 generator2.1의 protocol2 source/manifest/hash/lock과 실제 서버 소스를 포함한다. 재빌드가 client HTML과 copied server를 모두 다시 컴파일한다. 중앙 creator DB/키/실제 운영 DB는 일반 소스 ZIP에 포함하지 않는다. DB 이전은 별도 권한과 스키마/소유/해시/거래 대사를 사용한다.

## 시스템 고도화 경계

HTTP와 작업은 공통 operation 문맥을 사용한다. 원본 변경/ACK/outbox는 중앙 저장소에서 원자 저장하고, 환경 전달은 inbox와 publication sequence로 멱등 적용한다. 등록된 모든 환경을 재탐색하므로 화면이나 메모리에 열린 DB 목록에 복구를 의존하지 않는다. 큐는 DB에 공유한 실행 풀·기한·단계 예산과 lease/fencing을 사용한다.

CMS는 레코드와 불변 발행본을 canonical SQL 저장소에 둔다. Project는 호환 snapshot이고 모델 변경은 검토·배치 이전을 거친다. 전역 정책과 조직/환경 업무 권한은 별도로 검증하며 관리형 민감 변경은 TOTP/일회용 추가 인증을 요구한다.

artifact 바이트와 환경 활성화 manifest는 분리한다. 공개 검수는 로그인·기간·폐기가 적용된 정적 읽기이다. DB/blob/key-ID/artifact 복구는 scoped 동결/검증/기존 파일 충돌 검사와 최신 고객 데이터 유지 원칙을 적용한다. 실제 인프라 전환은 제공자 설정과 별도 검증이 필요하다. [48개 시스템 구현 기록](system-implementation.md)을 참고한다.

추적은 [OTLP HTTP JSON 계약](https://opentelemetry.io/docs/specs/otlp/)으로 선택한 수집기에 전달한다. 조직/개인정보를 metric label이나 전송 attribute에 넣지 않으며 수집기 실패·부분 거절 시 cursor를 진행하지 않는다. 로컬 HTTP 수집기 fixture 성공과 실제 운영 수집기/알림 전달을 구분한다.
