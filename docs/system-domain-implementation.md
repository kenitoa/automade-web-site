# 시스템 고도화: 콘텐츠·공유 구조·독립 결과물

H01–H48 승인 범위 중 이 문서는 도메인과 생성 사이트의 저장/공개 계약을 설명한다. 기존 schemaVersion 2, 블록 ID, 기존 프로젝트 JSON 읽기와 protocol 1 결과물 검사는 유지한다. 새 생성 서비스 버전은 2.1.0이고 결과물 계약은 protocol 2다.

| 요구 | 실제 경로                                                                                                           | 검증 증거                                                                                                                                                     | 조건 및 남은 검증                                                                                                                             |
| ---- | ------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------- |
| H07  | `server/advancement/content.ts`, Store hydrate/reconcile hooks                                                      | `advancement-content.test.ts`: 레코드 CAS, 동일 명령 재전송, 다른 레코드 독립 revision, 작업본 수정 중 기존 공개본 유지                                       | 운영 CMS 자료 이전은 온라인 백업 후 건수/해시 대사가 필요하다.                                                                                |
| H08  | indexed draft/live/value tables, SQL keyset 조건과 안정 ID cursor, `siteServer.ts` CMS 목록/상세                    | 47건 동일 정렬키/숫자 정렬, 공개 필드만 검색, 오래된 cursor 거절; 35건 실제 HTTP 페이지 조회                                                                  | 기존 전체 프로젝트 문서 읽기와 독립 export는 전체 snapshot 계약이다. 초대형 자료의 운영 용량은 별도 실측한다.                                 |
| H09  | schema preview, source schema/collection revision, 영속 candidates/checkpoint/errors, atomic final activation       | 무효 2건 dry-run 표시, SQLite 재시작 후 1건 배치 재개, 격리 시 이전 공개본 유지, 검토 뒤 수정 시 실행 거절, 공개 schema 전환 시 과거 private 값 차단          | 실패 자료 수정 뒤 새 preview를 작성한다. 임의 타입 강제 변환은 하지 않으며 제거 값은 archivedValues에 보존한다.                               |
| H10  | block/CMS/component/package/page reference edges, 주소 이력과 localized slug                                        | 직접 언어별 상세·canonical·사이트맵, 사용 중인 자료 삭제 차단, 공개 자료는 별도 발행 취소 필요                                                                | workflow/환경 참조의 서버 운영 조회와 결합한다. 공개 주소 이력은 재사용 충돌을 차단한다.                                                      |
| H26  | `timezones.ts`, `expansion/bookings.ts`, migration 0015 rule revision/slot provenance/review                        | `system-backend.test.ts`: 실제 예약 materialize의 DST gap/fold, UTC/ICU/tzdata provenance, capacity/holiday 변경 검토, 중복 실행                              | 기존 생성 slot은 불변 보관한다. 실제 공급자 예약/휴일 영향은 설정한 환경에서 별도 검증한다.                                                   |
| H28  | content field/language revisions, translation review/source-field hashes/assignee/glossary version, scoped AI merge | 원문 변경 필드 추적, 승인과 실제 발행 분리, 기존 scoped proposal 권한/수정 영역 회귀                                                                          | 외부 모델 품질과 청구는 공급자 설정 후 검증한다. 수동 문구 입력과 검토 기능은 로컬에서 동작한다.                                              |
| H29  | block registry, dependency validation, shared field update, explicit structural three-way review                    | `shared-structure.test.ts`: 추가/이동/삭제, 내부 대상 재연결, stable IDs, 로컬 수정 보존, 참조/폼 삭제 시 detach                                              | 구조 비교는 별도 검토 버튼으로 실행한다. 충돌은 현재 값을 보존하고 사유를 표시한다. 운영 데이터 모델 변경은 별도 이전이 필요하다.             |
| H30  | `generator.ts`, `artifactIntegrity.ts`, `artifactSigning.ts`, `build-generated.mjs`, `extension:check --artifact`   | source/compiled/runtime/license/lock 변조 거절, Ed25519 서명 및 다른 키/서명자 위조 거절, protocol 1 읽기                                                     | 최종 독립 설치/재빌드/포함 Node 실행 증거는 `.data/delivery-verification.json`을 참조한다. 다른 OS의 실행과 실제 공급자 거래는 별도 검증한다. |
| H37  | ReleaseBundle/EnvironmentBinding contracts, dynamic SEO origin binding, server promotion path                       | `advancement-content-runtime.test.ts`: 원본 HTML bytes 유지 상태에서 목표 origin의 canonical/사이트맵 응답                                                    | 정적 SEO가 바뀌면 새 variant hash를 사용한다. 실제 공개 도메인/배포 대상은 아직 미정이다.                                                     |
| H38  | `release.yml`, `publish-reviewed-release.ts`, compact deployment contract                                           | `reviewed-release.test.ts`: 미설정 skip, 승인/파일/commit 불일치 거절, 실제 health SHA/commit/hash 검사 fixture, 불확실 결과 POST 재시도 방지, 읽기 전용 대사 | [연결·승인·복원 절차](system-release-pipeline.md). 보호된 GitHub Environment와 실제 게이트웨이는 별도 설정/검증한다.                          |

## canonical CMS 경계

최초 legacy import 뒤에는 indexed record가 원본이다. Project JSON 저장에서 바뀌지 않은 옛 자료는 동시 개별 수정 내용을 덮어쓰지 않는다. 개별 쓰기는 record revision과 command ID로 검증하고 receipt, 새 revision, publication pointer와 outbox 등록을 같은 로컬 transaction에 넣는다. 사이트 DB 전달은 별도의 inbox/ack 경계다.

게시 승인과 작업본 저장은 구분한다. 공개 중인 자료의 프로젝트 JSON 삭제는 발행 취소 권한을 우회하지 못하도록 거절한다. 컬렉션/이미지의 현재 참조도 삭제 전에 검사한다. 기존 공개 revision은 수정하지 않으며 이전 발행본 복원은 별도 명령이다.

기존 검토/예약 API의 상태 변경도 canonical transition을 사용한다. 실제 실행자·조직·작업공간·환경 범위와 현재 권한을 전달하며 발행 pointer와 outbox는 같은 transaction에 저장한다. 별도 worker Store에서도 indexed 상태를 읽으며 원본 JSON을 덮어쓰지 않는다. 과거 승인 이전은 저장된 작성자·별도 검토자·내용 fingerprint가 모두 일치해야 한다. 예약 시각 도달만으로 새 canonical 자료를 공개하지 않으며 worker의 승인 확인이 끝나야 한다. 기존 protocol의 순수 legacy 시간 기반 조회 계약은 유지한다.

일반 프로젝트 저장에서 schemaRevision을 임의로 올려 모델 이전을 건너뛸 수 없다. 서버 preview/run으로 완료한 canonical schema와 일치하는 저장만 허용한다. 공개 값·이미지는 현재 공개 schema와 불변 발행 당시 공개 schema의 교집합을 사용한다.

## 공유 구조 비교

연결 인스턴스는 instance ID와 source block ID를 가진다. componentHistory는 적용 기준 공유 버전을 불변 보관한다. 구조 비교는 기준 공유본/현재 인스턴스/새 공유본을 비교하고 변하지 않은 필드에만 새 값을 적용한다. 로컬 수정, 잠금, override, 데이터 모델 변경은 충돌로 표시하고 현재 값을 유지한다. 제거된 공유 블록이 참조되거나 폼/표 운영 데이터에 연결될 경우 연결만 해제해 실제 ID를 보존한다. 새 블록의 내부 scroll/modal/chart/폼 성공 대상은 해당 인스턴스 ID로 다시 연결한다. 공유 기준과 연결 메타데이터는 공개 문서에서 제거한다.

## 독립 결과물 확인과 서명

`artifact.contract.json`은 source, package lock, compiled output, 포함 Node, Node license와 지원 OS/arch를 고정한다. 빌드의 원본 commit은 실제 빌드에 주입된 값이며 런타임 환경 변수를 commit 증거로 사용하지 않는다. 포함 runtime은 오프라인 실행용이고 `npm ci` 및 개발 재빌드는 패키지 설치 환경이 필요하다. 다른 OS를 지원한다고 자동으로 주장하지 않는다.

```powershell
npm.cmd run extension:check -- <artifact-output-directory> --artifact
```

독립 서버는 시작 전에 해시와 지원 환경을 검사한다. 현재 읽을 수 있는 databaseMigration은 1~15이며 더 높은 스키마 계약은 거절한다. unsigned source rebuild는 임시 output에서 검증하고 dist/server/contract 교체를 함께 복구할 수 있게 기존 파일을 보존한다. 공개 배포 계약도 임시 파일에 작성한 뒤 atomic rename으로 교체한다. `--accept-source`로 의도한 소스 변경을 승인하면 새 source hash를 기록하고 원본 commit 주장을 비운다. 기존 데이터와 key 파일은 이 교체 대상에 포함하지 않는다.

공개 배포는 전체 source/runtime를 전송하지 않고 필요한 공개 파일의 `deployment.contract.json`을 따로 검증한다. unsigned 재빌드는 전체 계약과 이 배포 계약을 함께 갱신한다. 선택 서명은 두 계약 각각에 적용하며 외부 신뢰 키로 검증한다.

worker IPC는 protocol 1을 명시하며 과거의 버전 없는 envelope도 protocol 1로 읽는다. 미래 버전은 DB/파일을 열거나 작업을 실행하기 전에 `WORKER_PROTOCOL`로 거절한다. `worker-protocol.test.ts`는 세 종류의 실제 source child process에서 이를 검증한다. generation 결과와 실패 envelope에는 해당 자식 프로세스가 측정한 CPU microseconds/CPU ms와 별도 elapsed ms를 담는다.

서명은 선택 설정이며 내용 해시와 별개다. 운영자가 보호된 Ed25519 PKCS8 private-key 파일과 다음 환경 이름을 설정하면 생성 시 실제 contract 서명을 만든다. private key는 output에 복사하지 않는다.

- `ARTIFACT_SIGNING_PRIVATE_KEY_FILE`
- `ARTIFACT_SIGNER_ID`
- `ARTIFACT_SIGNING_KEY_ID`
- 검증 측의 `ARTIFACT_TRUSTED_PUBLIC_KEY_FILE`
- 신뢰 서명을 필수로 하는 `ARTIFACT_REQUIRE_SIGNATURE=true`

검증 키는 별도 신뢰 경로에서 제공해야 한다. 결과물 안의 키 또는 signer label만으로 신원을 검증하지 않는다. 서명된 결과물 업데이트는 새 검토/생성으로 새 서명을 부여하며 원래 signed result를 임의로 다시 덮어쓰지 않는다. 이 구현은 [Node.js crypto의 Ed25519 sign/verify API](https://nodejs.org/docs/latest-v22.x/api/crypto.html#cryptosignalgorithm-data-key-callback)를 사용한다.

## 복구와 마이그레이션

새 indexed CMS 테이블은 migration 0010에 있고 시스템의 다른 새 마이그레이션과 순서대로 적용된다. 생성물 databaseMigration은 현재 전체 스키마 번호에 맞춘다. 이전 migration은 수정하지 않는다. rollback은 새 자료를 삭제하는 역 migration으로 수행하지 않고 사전 온라인 백업, 이전 빌드, 최근 권한 회수 자료를 함께 검토하는 복구 경로를 사용한다. 실제 운영 DB 업그레이드와 전체 검증 결과는 최종 작업 보고서에서 별도 확인한다.
