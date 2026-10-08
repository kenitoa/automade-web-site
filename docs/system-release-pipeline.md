# H38 검토한 결과물의 CI 배포

배포 대상과 공개 도메인은 아직 미정이다. `.github/workflows/release.yml`과 `scripts/publish-reviewed-release.ts`는 설정한 HTTPS 배포 게이트웨이의 protocol 1 계약에 연결한다. 필수 저장소 변수가 없으면 배포 job은 건너뛰며 CLI도 `RELEASE_SKIPPED`로 종료한다. 테스트용 프로젝트를 실제 공개 배포 대상으로 자동 선택하지 않는다.

## 준비와 승인

`Validate Studio`가 같은 저장소의 main 계열 push에서 성공한 정확한 40자리 commit을 선택한다. 수동 실행도 해당 commit의 성공한 검증 기록과 main 조상 관계를 확인한다. 공개 서버의 `buildCommit`과 `buildHash`는 검증한 소스를 빌드할 때 번들에 넣으며 런타임의 임의 SHA 환경 변수로 덮어쓰지 않는다.

저장소 Variables에 다음 값을 설정해야 한다.

| 이름                    | 의미                                            |
| ----------------------- | ----------------------------------------------- |
| `RELEASE_PROJECT_FILE`  | checkout 안의 실제 승인 대상 프로젝트 JSON 경로 |
| `RELEASE_GATEWAY_URL`   | protocol 1을 제공하는 HTTPS endpoint            |
| `RELEASE_PUBLIC_ORIGIN` | 경로 없는 정확한 공개 HTTPS origin              |
| `RELEASE_ALLOWED_HOSTS` | 게이트웨이와 공개 사이트 호스트의 쉼표 목록     |
| `RELEASE_APPROVAL_JSON` | 아래 계약에 맞는 검토 승인 JSON                 |

실제 `RELEASE_GATEWAY_TOKEN`은 `reviewed-release` GitHub Environment의 Secret에 등록한다. 이 Environment에는 **필수 검토자와 보호 규칙을 설정한 뒤** 배포를 켜야 한다. Environment 이름만 작성했다고 사람의 승인이 자동 보장되는 것은 아니다. 검토자는 준비 job이 업로드한 `prepared.json`의 프로젝트, 버전, commit, buildHash, 공개 origin, 데이터 볼륨, 파일 목록과 artifact SHA를 확인하고 승인한다. 준비와 공개 실행은 같은 고정 파일을 사용한다.

승인 JSON의 예제는 실제 값 대신 자리 표시자로 표현한다. SHA와 날짜는 실제 검토한 파일/빌드의 값으로 교체해야 한다.

```json
{
  "protocol": 1,
  "projectId": "<project-id>",
  "projectRevision": 1,
  "projectSha256": "<raw-project-file-sha256>",
  "buildCommit": "<tested-40-character-commit>",
  "buildHash": "<validated-linux-dist-service-build.json-hash>",
  "publicOrigin": "https://<chosen-public-host>",
  "dataVolume": "<persistent-volume-id>",
  "approvedBy": "<reviewer-id>",
  "approvedAt": "<UTC-ISO-date>",
  "expiresAt": "<UTC-ISO-date-within-seven-days>",
  "qualityApproved": true
}
```

`projectSha256`는 정규화한 Project가 아니라 승인 대상 파일의 실제 bytes SHA256이다. `buildHash`는 해당 commit의 Linux 검증 artifact에 있는 `dist-service/build.json`에서 확인한다. Windows 빌드와 Linux 빌드의 해시를 같은 값이라고 가정하지 않는다. 승인 JSON은 commit이 결정된 후 저장소 Variable에 넣으므로 commit 안에 자기 자신의 SHA를 다시 쓰는 순환 문제가 없다.

로컬 CLI에서는 `RELEASE_APPROVAL_FILE`에 승인 JSON 경로를 지정하고 `RELEASE_EXPECTED_COMMIT`, 위의 연결 설정을 제공한다. `RELEASE_PREPARED_FILE`로 고정 파일 위치를 바꿀 수 있다. `RELEASE_ARTIFACT_DIRECTORY`를 지정하면 이미 생성한 결과물의 루트를 사용하며 다시 생성하지 않는다. 지정하지 않으면 준비 단계에서 한 번 생성한다.

## 파일 무결성과 실제 공개 확인

생성 단계의 전체 `artifact.contract.json`은 source·lock·compiled·runtime·license를 검증한다. 공개 배포에는 필요한 파일만 담은 별도 `deployment.contract.json`과 선택 서명을 포함한다. 공개 서버는 이 계약의 파일 해시와 번들에 고정된 commit/buildHash를 시작 전에 검증한다. OS별 Node 실행 파일, 개발 소스, 운영 DB와 비밀키는 공개 배포 payload에 넣지 않는다.

배포 게이트웨이는 `preserveData:true`, 승인한 `dataVolume`, `releaseId`, 각 파일 해시와 전체 artifact SHA를 받아야 한다. 배포는 기존 볼륨을 보존하고 새 파일을 준비한 뒤 활성 release를 원자적으로 전환해야 한다. 자세한 계약과 운영 순서는 [공개 배포 문서](public-deployment.md)에 있다. H38 요청은 여기에 `buildCommit`, `buildHash`를 추가한다.

업로드 응답 이후 실제 공개 `/health`에서 service/status/project/revision/releaseId/artifact SHA/**빌드에 고정한 commit과 hash**를 모두 확인해야 성공이다. 게이트웨이의 업로드 응답만으로 성공하지 않는다. 실패나 타임아웃은 `verification.json`에 `unknown`으로 남기며 자동으로 두 번째 POST를 보내지 않는다. 같은 로컬 journal에서 불명확한 요청을 다시 실행하면 쓰기를 거절한다. `verify` 명령은 공개 health만 읽어 대사한다. CI의 불명확한 결과는 업로드된 verification artifact와 공급자의 멱등성 기록을 보존하고 대사한 뒤 다시 승인해야 한다. CI를 새 준비 실행으로 무조건 반복하지 않는다.

## 이전 결과물 복원

수동 실행에서 `operation:rollback`, 이전 `prepared.json`의 GitHub artifact ID인 `prepared_artifact_id`, 해당 이전 commit을 지정한다. 새 승인 JSON에는 `artifactSha256`를 추가해 **이전 고정 파일의 정확한 SHA**를 승인해야 한다. 이전 파일의 bytes, build commit/hash, releaseId를 유지하며 다시 생성하거나 현재 source를 이전 버전으로 가장하지 않는다. 대상 프로젝트·origin·데이터 볼륨이 새 승인과 다르면 거절한다.

GitHub 준비 artifact의 현재 보관 기간은 7일이다. 만료된 artifact 대신 임의 결과물을 생성해 rollback하지 않는다. 장기 보관 저장소를 선정하면 이 고정 계약과 해시를 보존하는 어댑터가 필요하다. 파일 복원은 최신 운영 DB/권한 회수를 유지하고 이전 앱이 현재 additive schema와 호환되는지 확인한 후 수행한다. DB 초기화나 볼륨 삭제는 이 경로에 없다.

## 검증 범위

`tests/reviewed-release.test.ts`는 미설정 CLI skip, 프로젝트 파일/승인/build 불일치, 변조/중복 파일, 만료 승인, 명시한 rollback artifact hash, 공개 commit/hash 불일치, 읽기 전용 대사를 검증한다. `artifact-integrity.test.ts`는 전체 결과물 해시와 Ed25519 외부 신뢰 키 검증을 검사한다. 이 결과는 로컬 fixture와 코드 검증 증거다. 실제 GitHub 보호 승인, Linux 컨테이너, DNS/TLS, NAS/VPS/클라우드, 게이트웨이 전환과 실제 공개 SHA는 대상과 자격증명을 정한 후 별도로 검증해야 한다.
