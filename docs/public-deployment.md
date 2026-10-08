# 공개 배포 연결과 독립 운영

현재 배포 대상·도메인·공급자는 미정이다. 로컬 제작 도구는 계속 127.0.0.1에만 바인딩한다. 생성된 사이트에는 공개 운영용 인증·역할·영속 데이터·Docker 설정이 포함된다. 외부 게시·실결제·실메일 전송을 이번 검증에서 수행하지 않는다.

## 배포 게이트웨이 계약

운영 → 배포에서 HTTPS 공급자 endpoint, allowedHost, `DEPLOY_`로 시작하는 서버 비밀 환경 변수 이름, 정확한 공개 HTTPS origin을 저장한다. `PLATFORM_ALLOWED_HOSTS`에 공급자 호스트와 사이트 호스트를 모두 명시해야 한다. 비밀값은 서버 환경에만 넣고 설정·DB·로그·소스에 넣지 않는다. API와 공개 상태 확인은 DNS 주소를 검사·고정하며 사설 주소, 리디렉션, 다른 포트, 자격증명 URL을 허용하지 않는다.

구현은 특정 업체 SDK를 가장하지 않는 **게이트웨이 protocol 1**이다. 선정한 NAS/VPS/클라우드가 아래 계약을 제공하지 않으면 이 게이트웨이 어댑터를 먼저 배포해야 한다. Docker를 수동 배포하는 경우에도 같은 영속 볼륨·활성 릴리스·헬스 계약을 지켜야 한다.

- 연결 시험: 설정 endpoint GET, 2xx JSON 응답. 응답 가능성만 표시한다.
- 배포/롤백: POST. Authorization은 환경 변수의 Bearer 비밀값, `Idempotency-Key`와 `X-Request-ID`는 서버의 배포 작업 ID이다.
- body: `{protocol:1,operation:'publish'|'rollback',projectId,releaseId,revision,sha256,publicOrigin,preserveData:true,dataVolume:projectId,activateReleaseId:releaseId,files:[{path,base64,sha256}]}`.
- response: `{deploymentId:'...'}`. 이 응답만으로 성공하지 않는다. 공급자는 원자적으로 새 릴리스를 준비하고 기존 데이터 볼륨을 재사용하여 활성화해야 한다.
- payload는 dist, 번들 site-server, 서버에서 회원 페이지를 검증할 편집 원본, `.release.json`, Docker 설정, 공개 파일 무결성 `deployment.contract.json`과 선택 서명만 포함한다. 최대 25MB·2000파일. 문의·회원 DB, `.env`, OS 실행파일, 개발 의존성은 전송하지 않는다.
- 파일 해시를 확인하고 소팅된 `{path,sha256}` 배열의 JSON에 대한 SHA256을 검사한다. 이 값을 `SITE_DEPLOYMENT_SHA256`에 주입한다. `SITE_ACTIVE_RELEASE_ID`는 `.release.json.id`와 일치해야 한다.
- 배포 후 공개 `/health` JSON은 `{data:{service:'automade-site',status:'ok',projectId,revision,releaseId,deploymentSha256,buildCommit,buildHash},error:null,meta}`이다. 모든 값이 서버의 요청과 일치해야 `verified`로 저장한다. H38 CI는 실제 빌드에 고정한 commit과 hash까지 검사한다.
- 타임아웃·버전 불일치 등 결과가 불명확한 경우 `unknown`이다. 무조건 재발행하지 말고 공급자 기록을 확인한 뒤 UI의 공개 버전 재검증을 사용한다. 배포 요청 키 재사용은 중복 발행을 막는다.

push 검증 이후 준비 파일 고정·보호된 승인·공개 SHA 확인·기존 파일 rollback을 실행하는 H38 연결 절차는 [CI 배포 문서](system-release-pipeline.md)를 따른다. 연결 대상이 없는 기본 설정에서는 공개 배포를 실행하지 않는다.

파일 bytes를 보존하는 로컬 승격 별칭은 원본 `.release.json`의 ID를 수정하지 않는다. 이 별칭 ID와 원본 ID가 다르면 공개 배포는 `DEPLOYMENT_ACTIVATION_MANIFEST`로 거절한다. 현재 공개 게이트웨이는 결과물 내부 ID와 활성 ID의 일치를 요구하므로 별도 activation manifest 없이 다른 별칭을 활성화한다고 주장할 수 없다. 대상 공급자가 선정되면 원본 artifact SHA와 별칭·환경·config revision을 묶어 검토/서명하는 별도 activation manifest 계약을 구현하고 실제 공개 health로 검증해야 한다. 정적 SEO bytes가 다른 variant는 별도 결과물 ID/해시로 생성한다.

## 컨테이너

생성 결과의 output에서 `docker compose config`로 설정을 검증하고 `docker compose up --build -d`로 실행한다. Docker 실행은 이번 Windows 검증 환경에서 미검증이다. `infrastructure/site`의 파일은 산출물로 복사된다.

필수 설정: SITE_PUBLIC_ORIGIN, SITE_ACTIVE_RELEASE_ID, SITE_DEPLOYMENT_SHA256, PLATFORM_ADMIN_EMAIL, PLATFORM_ADMIN_PASSWORD, SITE_VOLUME_NAME. 비밀값은 운영 secret store 또는 별도 커밋 제외 env 파일로 전달한다. SITE_VOLUME_NAME은 프로젝트별 고정 이름으로 지정하고 배포 디렉터리 변경 시에도 유지한다. UID1000(node)이 볼륨에 쓸 수 있어야 한다.

사이트는 컨테이너 8080에서 실행하며 호스트 127.0.0.1:8080에만 연결된다. 외부 HTTPS 리버스 프록시는 원래 Host를 보존하고 TLS를 종료해야 한다. 프록시의 서버 설정과 인증서 자동 갱신은 실제 대상 선정 후 검증한다. 헬스 체크는 공개 Host를 가진 내부 요청으로 수행한다. 비루트 사용자, 읽기 전용 이미지, 제한된 tmpfs, 모든 capability 제거, init/종료 신호 처리를 적용한다. 이미지에는 SQLite와 비밀값을 복사하지 않는다. 배포 시 이미지 digest 고정과 Linux 실행 검증을 수행한다.

## 데이터·롤백 순서

1. 사이트 운영 DB 온라인 백업과 복원 가능성을 먼저 확인한다.
2. 생성 결과의 프로젝트·릴리스·품질 오류·파일 해시를 검사한다.
3. 새 이미지를 준비하고 기존 SQLite 볼륨의 additive 마이그레이션 호환성을 검증한다.
4. 이전 프로세스의 쓰기를 중지하고 새 릴리스 ID를 명시적으로 활성화한다. 두 버전을 쓰기 가능 상태로 함께 실행하지 않는다.
5. HTTPS 공개 헬스의 실제 버전과 해시를 확인한 뒤 트래픽을 전환한다.
6. 디자인 롤백은 이전 디자인의 새 릴리스를 만들고 **최신 운영 DB**를 유지한다. 공개 롤백 요청도 같은 볼륨 재사용을 요구한다. 오래된 앱이 새 스키마와 호환되지 않으면 DB를 내리지 말고 수정된 호환 릴리스를 생성한다.

볼륨 삭제, DB 초기화, down -v는 정상 배포·롤백 절차에 포함하지 않는다. 회원·주문·문의 등 실제 데이터를 포함한 백업은 제한된 운영자만 내려받을 수 있게 관리한다.
