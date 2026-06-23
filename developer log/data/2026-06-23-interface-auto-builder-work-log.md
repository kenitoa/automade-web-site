# 2026-06-23 Interface Auto Builder Work Log

## Scope

이 문서는 `C:\Users\abc20\Desktop\인터페이스 자동 생성기` 폴더에서 진행한 인터페이스 자동 생성기 작업 내역을 기록한다.

목표는 React 기반 UI 조립 도구를 만들고, 사용자가 팔레트 블록을 캔버스에 배치한 뒤 실제 실행 가능한 사이트 폴더로 저장할 수 있게 하는 것이다.

## 주요 구현 내역

### 기본 빌더 구조

- React/Vite 기반 앱 구조를 사용한다.
- `start-site.cmd`로 로컬 개발 서버를 바로 실행한다.
- `src/App.jsx`가 전체 프로젝트 상태, 선택 블록, 저장, 미리보기, 인스펙터, 팔레트, 캔버스를 연결한다.
- `src/lib/projectModel.js`가 프로젝트 생성, 블록 생성, 배치, 삭제, 수정, 캔버스 크기/그리드 업데이트를 담당한다.
- `src/lib/storage.js`가 localStorage 저장/복원을 담당한다.

### 팔레트와 블록

- 팔레트 블록을 드래그해서 캔버스에 배치할 수 있다.
- 팔레트 항목은 일반 사용자가 기능을 이해하기 쉽게 정리했다.
  - 첫 화면 안내
  - 상단 네비게이션
  - 사이드 메뉴
  - 입력 폼
  - 데이터 테이블
  - 데이터 차트
  - 탭 패널
  - 확인 모달
- `src/data/blockCatalog.js`에 각 블록의 기본 크기, 제목, 설명, 버튼명, 디자인, 로직 의도를 정의했다.

### 캔버스 편집

- 캔버스는 실제 사이트 원본 크기 기준으로 표시한다.
- 왼쪽 팔레트에서 블록을 끌어 캔버스 위치에 배치한다.
- 배치 후에도 저장 전까지 계속 이동할 수 있다.
- 선택한 블록은 리사이즈 핸들로 크기를 조절할 수 있다.
- 캔버스에 점선/도트 그리드를 표시하고, 배치/이동/크기 조절이 그리드에 맞춰진다.
- `GRID` 값은 타이핑이 아니라 `-`, `+` 버튼으로 조절한다.
- 선택된 블록은 `Delete` 또는 `Backspace` 키로 삭제할 수 있다. 입력창/셀렉트/텍스트영역에 포커스가 있을 때는 삭제 단축키가 작동하지 않는다.

### 블록 내부 기능

- 입력 폼은 실제 input/select/textarea를 제공하고 필수값 검증, 제출 메시지, 초기화 메시지를 처리한다.
- 데이터 테이블은 행 표시, 정렬, 행 추가, 행 삭제, CSV 내보내기를 지원한다.
- 데이터 차트는 막대/선형/요약 모드를 제공하고, 데이터 포인트 클릭 시 값을 표시한다.
- 탭 패널은 선택한 탭에 맞는 패널 내용을 표시한다.
- 사이드 메뉴는 선택 상태를 유지하고 현재 영역을 표시한다.
- 확인 모달은 확인/취소 상태를 표시한다.
- 히어로/기본 블록 버튼은 클릭 시 실행 결과 메시지를 표시한다.

### 네비게이션 정책

- 네비게이션 기본 메뉴 `Dashboard / Builder / Data / Settings`는 제거했다.
- 상단 네비게이션은 캔버스에 실제 배치된 다른 블록들을 자동으로 메뉴 버튼화한다.
- 편집 중에도 새 블록을 배치하면 네비게이션 버튼이 즉시 반영된다.
- 네비게이션 버튼 이름은 기본적으로 블록 제목을 사용한다.
- 인스펙터의 `네비게이션 버튼 이름` 필드로 버튼명을 직접 바꿀 수 있다.
- 네비게이션 버튼을 누르면 해당 블록 화면만 표시된다.
- 네비게이션을 처음 배치했을 때는 아무 메뉴도 자동 선택하지 않고 전체 블록을 보여준다.

### 인스펙터

- 프로젝트 언어, 커스텀 언어 JSON, 테마 색상, 모서리 둥글기, 프로젝트명, 선택 블록 속성을 편집한다.
- 선택한 블록의 제목, 본문, 주요 버튼, 보조 버튼, 톤, 밀도, 배치, x/y/width/height, 배경색을 수정한다.
- 선택한 블록이 네비게이션이 아니면 `네비게이션 버튼 이름`을 편집할 수 있다.

### 미리보기

- 기존 오른쪽 패널 미리보기만으로는 실제 배치 결과 확인이 부족했다.
- `미리 보기` 버튼을 누르면 새 창으로 현재 캔버스 결과를 연다.
- 새 창 미리보기는 저장될 정적 사이트와 같은 `HTML + CSS + JavaScript` 문서를 Blob URL로 연다.
- 프로젝트 JSON은 HTML escaping이 아니라 script-safe JSON 직렬화로 넣어 `JSON.parse`가 가능하도록 수정했다.
- 새 창 팝업이 차단되면 앱 상태 메시지로 안내한다.

### 저장 구조

- 저장 시 바탕화면에 `{프로젝트명}-react-app` 폴더를 만든다.
- 생성 폴더의 1차 구조는 다음과 같다.
  - `start-site.cmd`
  - `output/`
- `output/`에는 React/Vite 앱 파일을 생성한다.
  - `package.json`
  - `index.html`
  - `vite.config.js`
  - `src/main.jsx`
  - `src/App.jsx`
  - `src/projectData.js`
  - `src/styles.css`
  - `README.md`
  - `static-site/index.html`
  - `static-site/styles.css`
  - `static-site/script.js`
  - `project.interface.json`
- 저장된 `start-site.cmd`는 `output`으로 이동해 의존성이 없으면 설치하고 저장 시 배정된 랜덤 포트로 `npm run dev -- --port {launchPort} --open`을 실행한다.
- 저장 시 `vite.config.js`가 `10000~49999` 범위에서 사용 가능한 포트를 확인해 `launchPort`로 배정한다.
- `output/project.interface.json`에는 `savedAt`, `launchPort`, `project`, `exportSpec`을 함께 기록한다.

### 생성물

- `src/lib/siteExport.js`가 React 프로젝트 파일, 정적 사이트 파일, 새 창 미리보기 문서를 생성한다.
- 생성 React 앱과 정적 사이트 모두 네비게이션 자동 메뉴, 폼, 테이블, 차트, 탭 동작을 포함한다.
- 생성 React 앱 `package.json`에는 `overrides.esbuild`를 포함해 audit 기준을 맞췄다.

## 변경된 주요 파일

- `src/App.jsx`
  - 전체 상태 연결, 새 창 미리보기, 저장 흐름, 패널 전환 처리.
- `src/components/BuilderCanvas.jsx`
  - 드래그/드롭, 그리드 스냅, 리사이즈, 블록 내부 기능, 네비게이션 표시 필터.
- `src/components/Preview.jsx`
  - 오른쪽 패널용 인터랙티브 미리보기.
- `src/components/Inspector.jsx`
  - 블록 속성 편집과 네비게이션 버튼명 편집.
- `src/components/Palette.jsx`
  - 팔레트 렌더링과 드래그 시작 처리.
- `src/components/SavePanel.jsx`
  - 바탕화면 저장 UI.
- `src/components/ExportPanel.jsx`
  - JSON 스펙 확인 UI.
- `src/data/blockCatalog.js`
  - 직관적인 팔레트 블록 정의와 기본 기능 설명.
- `src/lib/blockRuntime.js`
  - 네비게이션 메뉴 생성, 블록 표시 판단, 테이블 기본 데이터, CSV 처리.
- `src/lib/siteExport.js`
  - 저장용 React 앱, 정적 사이트, 새 창 미리보기 문서 생성.
- `src/lib/projectModel.js`
  - 프로젝트/블록 모델과 그리드 스냅 기반 배치.
- `vite.config.js`
  - `/api/save-project` 저장 API와 생성 폴더 작성.
  - 저장된 사이트 실행용 랜덤 포트 생성, 포트 사용 가능 여부 확인, `start-site.cmd`와 `project.interface.json`에 `launchPort` 반영.
- `src/styles.css`
  - 빌더, 캔버스, 팔레트, 인스펙터, 기능 블록, 미리보기 스타일.
- `start-site.cmd`
  - 로컬 실행 진입점.

## 재검증 결과

실행일: 2026-06-23

### 앱 빌드

명령:

```powershell
npm.cmd run build
```

결과:

- Vite production build 성공.
- 42 modules transformed.
- `dist/index.html`, CSS, JS asset 생성 확인.

### 생성 경로 검증

검증 내용:

- 샘플 프로젝트 생성.
- `navigation`, `hero`, `form`, `table`, `chart`, `tabs`, `sidebar`, `modal` 블록 배치.
- 네비게이션 메뉴 수가 네비게이션 외 블록 수와 일치하는지 확인.
- 예전 고정 메뉴 `Dashboard / Builder / Data / Settings`가 남아 있지 않은지 확인.
- 새 창 미리보기 문서에 `style`, `script`, `page-canvas`가 포함되는지 확인.
- `project-data` JSON이 HTML escaped 상태가 아니며 `JSON.parse` 가능한지 확인.
- React 저장물과 정적 저장물을 임시 폴더에 생성.

결과:

- `generation-ok 7`

### 생성 React 앱 JSX 검사

명령:

```powershell
node -e "const fs=require('node:fs'); const esbuild=require('esbuild'); const source=fs.readFileSync('.tmp-generated-output/src/App.jsx','utf8'); esbuild.transformSync(source,{loader:'jsx',format:'esm'}); console.log('generated-jsx-ok');"
```

결과:

- `generated-jsx-ok`

### 생성 정적 사이트 스크립트 검사

명령:

```powershell
node --check .tmp-static-output\script.js
```

결과:

- 문법 오류 없음.

### 생성 React 앱 빌드

명령:

```powershell
node ..\node_modules\vite\bin\vite.js build --config vite.config.js
```

결과:

- Vite production build 성공.
- 30 modules transformed.

### 실행 서버 확인

명령:

```powershell
Invoke-WebRequest -Uri http://127.0.0.1:5173 -UseBasicParsing | Select-Object -ExpandProperty StatusCode
```

결과:

- `200`

### 보안 audit

명령:

```powershell
npm.cmd audit --omit=dev
```

결과:

- `found 0 vulnerabilities`

## 정리

검증용 임시 폴더는 삭제했다.

- `.tmp-generated-output`: 삭제 확인.
- `.tmp-static-output`: 삭제 확인.
