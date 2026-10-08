# 선언형 확장 SDK 1

기존 schemaVersion 2 문서, 블록 ID와 페이지 경로는 유지합니다. 사용자 패키지는 검증된 템플릿과 문구 기본값을 선언합니다. URL에서 코드를 내려받거나 브라우저가 전달한 JavaScript를 실행하지 않습니다. 새 실행 모듈은 저장소에서 검토하고 편집기·SSR·독립 런타임 테스트를 통과한 뒤 빌드에 포함해야 합니다.

## 패키지 만들기

manifest의 허용 키는 id, name, version, integrity, protocol, definitions입니다. protocol은 1, version은 정확한 `1.0.0` 형태입니다. 정의는 id, name, description, template, defaults만 받습니다. template은 `text`, `cards`, `faq`, `pricing`, `automade:timeline`이고 defaults는 title, body, primaryAction, secondaryAction 문구만 받습니다. 실행 코드, URL, 이벤트 처리기, 비밀 값은 선언할 수 없습니다.

```json
{
  "id": "example.guide",
  "name": "안내 문구",
  "version": "1.0.0",
  "integrity": "sha256-0000000000000000000000000000000000000000000000000000000000000000",
  "protocol": 1,
  "definitions": [
    {
      "id": "intro",
      "name": "소개",
      "description": "일반 텍스트 안내",
      "template": "text",
      "defaults": { "title": "서비스 소개", "body": "실제 안내를 작성하세요." }
    }
  ]
}
```

```powershell
npm.cmd run extension:check -- guide.json --print-integrity
# 출력 integrity를 manifest에 넣은 후 검증
npm.cmd run extension:check -- guide.json
npm.cmd run extension:check -- project.interface.json --project --target=node
npm.cmd run extension:check -- project.interface.json --project --target=static
```

`--print-integrity`는 정렬된 JSON의 실제 SHA-256을 출력하며 입력 파일을 수정하지 않습니다. 배포 시 일반 검증을 반드시 실행합니다. 해시는 내용 변조를 검출하며 작성자의 신원을 증명하는 서명은 아닙니다. 관리자가 승인한 팩만 설치하고 설치·적용 권한과 감사 기록은 서버가 검증합니다.

## 등록과 원본 호환

`src/domain/blockRegistry.ts`가 이름, 버전, 카테고리, 속성 프로필, 렌더러, 실행 환경과 기본값을 등록합니다. 승인된 `automade:timeline`은 실제 순서 목록을 렌더링합니다. 선언형 정의는 `extension` 블록에 `props.extensionDefinitionId = packageId/definitionId`로 연결되며 `featurePins`에 정확한 패키지 버전과 integrity를 보관합니다. 기존 16개 이름을 변경하지 않습니다.

`preflightProject`는 정규화 전에 지원되지 않는 schema·블록·버전·핀을 검사합니다. 실패한 원본은 자동 변환하거나 덮어쓰지 않습니다. 패키지 적용은 `previewPackageUpdate`의 변경 목록을 먼저 보여주고 선택한 인스턴스에 적용합니다. 기존 문구 재정의는 유지합니다. 사용 중인 정의 삭제와 렌더러 변경은 차단합니다. 제거는 `removePackage(project,id,true)`로 명시적으로 연결을 해제한 후 현재 블록 ID와 문구를 유지합니다.

## 공유 구성과 업종 팩

공유 컴포넌트는 `{id,name,version,blocks}`이며 `parseSharedComponent`로 검증합니다. 삽입은 `instantiateComponent`가 트리와 내부 참조를 새 ID로 복제합니다. 업데이트는 `previewComponentUpdate`의 affectedIds/skippedIds/changes를 보여주고 한 편집 이력으로 적용합니다. `componentLink.overrides`에 기록된 사용자 변경, 잠금, 사라진 sourceBlockId는 덮어쓰지 않습니다. 결제·데이터 연결·권한 동작을 문구 업데이트로 변경하지 않습니다.

브랜드는 `previewBrandUpdate`, 업종 팩의 선택 섹션은 `previewIndustryPack`으로 적용합니다. 원본 섹션과 공유 정의는 공개 문서에서 제외합니다. 공개 블록에 필요한 선언형 렌더링 메타데이터만 남기며 사용하지 않는 기본 문구는 제거합니다.

## CMS와 연결 데이터

기존 `fields: Record<string,string>`는 보존합니다. 선택적인 `schema`와 `values`로 text/number/boolean/date/enum/image/reference를 추가합니다. required/unique/readOnly/min/max/public 규칙을 서버에서 다시 검증합니다. `previewSchemaChange`는 제거 필드 값을 archivedValues로 이동하고 복원 시 되돌립니다. 아카이브 값과 비공개 필드는 공개 API·HTML에 나오지 않습니다.

수정은 contentRevision을 증가시키고 승인을 무효화합니다. review → approved 이후만 published/scheduled로 전환할 수 있습니다. 예약은 서버 UTC와 approvedRevision으로 판단합니다. runtime_state의 `project:cms` 스냅샷은 `{revision,collections}`이며 `withCmsSnapshot`이 릴리스 원본과 합칩니다.

서버 조회는 `queryMode: server`, `GET /api/content/:collectionId?limit=20&cursor=...&q=...&language=fr-CA`를 사용합니다. 한 응답은 100개 이하이며 공개 필드로만 검색·정렬합니다. 초기 HTML은 20개 스냅샷과 선택 상세만 포함합니다. 나머지 상세는 서버 SSR 경로로 제공합니다. `/sitemap.xml`은 최신 발행 스냅샷의 모든 공개 레코드와 언어별 대표 주소를 포함합니다. 10,000개를 넘으면 sitemap index와 `/sitemaps/:page.xml`로 나눕니다. 독립 정적 생성·재빌드도 같은 전체 인덱스와 페이지 파일을 출력합니다. 초안·회원 레코드는 어느 사이트맵에도 포함하지 않습니다.

`dataBinding`은 connectionId와 허용된 제목·본문·이미지·값·레이블 매핑만 저장합니다. 실제 서버 어댑터는 `/api/platform/data/:connectionId/binding`에서 데이터를 조회하며 키를 클라이언트에 보내지 않습니다. 런타임은 로딩·빈 결과·오류·재시도·커서 이동을 표시합니다. 이미지 값은 프로젝트에 등록된 asset ID만 사용합니다.

## 독립 결과물과 완료 기준

결과물은 원본 `project.interface.json`, 같은 domain/runtime 소스, `artifact.contract.json`, 공개 HTML과 실제 이미지 파일을 포함합니다. contract는 generatorVersion, schemaVersion, 실행 환경, 패키지 핀, 복사한 소스 SHA-256을 기록합니다. node 결과물은 Node 22.16 이상을 요구합니다. blob 참조는 생성 전에 권한·MIME·실제 해시를 확인하고 파일을 포함해 Studio 없이 실행됩니다.

정적 환경에서는 서버 폼·데이터 연결·회원 콘텐츠를 지원한다고 표시하지 않습니다. 환경 preflight 실패는 해당 기능의 서버 연결 또는 환경 변경이 필요하다는 뜻입니다. 독립 재빌드는 기존 dist를 새 결과가 완성된 뒤 교체하고 이전 폴더를 보관합니다.

새 모듈 완료 조건은 기존 원본 재읽기, 미지원 버전 원본 보존, 조작 manifest 거부, 편집 저장, 공통 SSR, 독립 재빌드·실행, 모바일 키보드 접근, 공개/회원/초안 데이터 분리 테스트 통과입니다. 공급자 자격 증명, 실제 결제, 클라우드 운영·회수는 실제 환경 검증 기록이 있어야 완료로 보고합니다.
