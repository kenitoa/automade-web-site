# 서버 이미지 디코딩·변형과 worker CPU 측정

2026-10-08. H16의 서버 원본 검증·로컬 변형과 H27의 측정 가능한 CPU 원장을 연결한다.

## 선택 근거

기존 Node 표준 라이브러리와 esbuild/React 의존성은 PNG/JPEG/GIF/WEBP의 전체 픽셀 디코더를 제공하지 않는다. 직접 코덱을 구현하면 손상 파일·애니메이션·압축 해제 경계를 안전하게 유지하기 어렵다. 서버 전용 Sharp `0.35.5`를 exact pin하고 기존 npm lockfile을 갱신했다. 여러 이미지 형식과 resize를 한 코덱으로 처리하며 브라우저 번들에는 들어가지 않는다.

[공식 0.35.5 변경 기록](https://sharp.pixelplumbing.com/changelog/v0.35.5/)과 [릴리스](https://github.com/lovell/sharp/releases), [지원/보안 정책](https://sharp.pixelplumbing.com/security/), [설치 조건](https://sharp.pixelplumbing.com/install/), [생성자 입력 제한](https://sharp.pixelplumbing.com/api-constructor/), [출력 메타데이터 정책](https://sharp.pixelplumbing.com/api-output/)을 확인했다. npm 정보와 설치된 package manifest는 Node `>=20.9.0` 및 최신 버전 `0.35.5`를 표시했고, 프로젝트의 Node 22 조건과 맞는다. 설치 전·후 `npm audit --json`은 알려진 npm 취약점 0건을 보고했다. 이는 내장 native 코덱에 모든 취약점이 없다는 증명이 아니다. 지원되는 최신 버전 변경 시 테스트 후 pin·lock·검사 결과를 함께 갱신한다.

Sharp 자체는 Apache-2.0이다. 설치된 `@img/sharp-win32-x64@0.35.5`의 manifest는 `Apache-2.0 AND LGPL-3.0-or-later`이고 README에는 libvips 및 다른 native 구성요소의 라이선스 목록이 있다. 공개 사이트 runtime에는 이미지 worker/native 코덱을 배포하지 않는다. 전체 개발 소스 package/lock/SBOM에는 target별 optional 패키지와 라이선스가 남는다. 서버 배포 시 native 패키지의 LICENSE·README·구성요소 고지와 상응하는 upstream source 정보를 함께 보존한다. Node 재배포 고지는 기존 runtime 계약을 따른다.

## 처리 경계

`BlobService.upload`는 서명/MIME·8MB 검사 후 별도 `imageWorker` 프로세스로 실제 디코딩을 요청한다. worker에는 바이트와 출력 크기만 보내며 DB 경로·URL·인증 비밀값을 넘기지 않는다. 환경 변수도 OS 경로·임시 디렉터리 목록으로 제한한다. PNG/JPEG/GIF/WEBP만 허용하며 SVG·임의 URL·파일 입력을 받지 않는다. 파일 저장 전과 DB 참조 저장 전에 현재 권한·정책을 다시 확인한다.

worker는 `failOn:warning`, 제한 해제 금지, 한 변 16000, 총 4000만 픽셀, 최대 128프레임, 4채널 제한을 사용한다. 모든 애니메이션 프레임을 raw로 디코딩해 헤더만 정상인 손상 입력을 거절한다. native pipeline은 5초 제한, 부모의 전체 요청은 12초 제한이며 초과하면 child를 종료한다. 프로세스당 두 작업과 Sharp native thread 한 개로 동시 작업을 제한하고 cache를 끈다. raw 결과는 최대 약 160MB다. Node heap 256MB는 native 총 메모리 제한을 뜻하지 않으므로 실제 운영 호스트의 프로세스/컨테이너 메모리 제한과 동시 worker 수를 함께 설정한다.

`POST /api/expansion/blobs/:id/variants`는 원본 이하 크기의 PNG/WEBP를 fit-inside로 생성한다. 애니메이션은 전체 검증 후 첫 프레임 정적 변형본을 만든다. 자동 회전과 기본 출력 메타데이터 제거를 적용한다. 원본 파일은 SHA 주소에 불변으로 남고 변형본은 새 격리/private 참조이며 별도 공개 승인이 필요하다. 원본 메타데이터까지 지우는 기능으로 표시하지 않는다.

변형 요청 키에는 원본·규격·코덱 버전 지문과 30초 lease를 묶는다. 같은 키의 동시 작업은 409, 완료 재전송은 같은 참조, 설정 변경은 충돌이다. 참조 저장과 완료 receipt를 같은 DB 트랜잭션으로 기록한다. 완료 retry가 새 변형이나 추가 CPU 관측을 만들지 않으며 failed/expired 작업만 다시 처리한다. 실제 이미지 검사도 malware 검사와 구분하고 `malwareScan:not-configured`를 유지한다.

## 사용량과 검증

생성·확장·이미지 child의 `process.cpuUsage()` 차이를 user/system 마이크로초로 측정하고, 합계 올림 밀리초를 별도 UUID 작업의 실제 CPU 원장으로 기록한다. `hrtime` 경과 시간은 CPU로 계산하지 않는다. 정상·오류 최종 메시지 모두 측정을 전달하고 동일 operation/env/metric의 재수신은 한 번만 반영한다. 이미지 decode/resize 실패와 권한 철회 후 실패도 이미 측정한 CPU를 보존한다.

측정 대상은 해당 Node 프로세스와 그 스레드다. 별도 esbuild 프로세스와 지속 실행 site CPU, provider tokens/invoice는 현재 측정에 포함하지 않는다. hard kill·OS crash로 최종 메시지를 받지 못하면 완전한 CPU 측정값을 만들지 않는다.

Windows x64에서 네 이미지 형식, 손상 입력, 애니메이션, 해제 한도, metadata 제거, 원본 불변, 동시/재전송 receipt, 격리 공개 차단과 성공/실패 CPU 원장을 `tests/image-processing.test.ts`·`tests/worker-usage.test.ts`로 검증했다. Linux/컨테이너 native 설치·외부 CDN/AV·실제 공급자 청구는 별도 인수 대상이다. 추가 DB 마이그레이션과 환경 변수는 없으며 기존 migration14의 asset/usage 원장과 `runtime_state` receipt를 사용한다. 롤백 시 현재 pin/lock/source와 새 이미지 worker를 하나의 버전으로 배포하며 원본·참조·검토 상태를 삭제하지 않는다.
