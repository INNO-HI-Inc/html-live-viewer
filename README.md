# HTML Live Viewer

<p align="center">
  <img src="icon.png" width="120" alt="HTML Live Viewer">
</p>

VS Code에서 **HTML을 실제 브라우저처럼 미리보기**하는 확장입니다. 로컬 정적 서버를 띄워
편집기 안 탭에서 `http://localhost`로 렌더하므로, 일반 브라우저와 동일하게 동작합니다.

## ✨ 기능

- 🌐 **실제 브라우저와 동일한 렌더링** — 내부 로컬 서버를 iframe으로 임베드.
  `fetch`, ES 모듈, 절대경로(`/assets/...`), 웹폰트까지 그대로 동작.
- ⚡ **스마트 라이브 리로드** — 편집/저장 즉시 갱신(SSE). **CSS만 고치면 새로고침 없이
  스타일만 교체**되어 스크롤·입력·JS 상태가 유지됩니다.
- 📝 **저장 안 한 편집도 반영** — 편집 중인 에디터 버퍼를 우선 제공.
- 📱 **반응형 미리보기** — 실기기 프리셋(iPhone/iPad/Galaxy)·커스텀 폭·가로 회전·
  디바이스 베젤 프레임·줌.
- 📲 **휴대폰으로 보기 (QR)** — 같은 Wi-Fi 기기에서 QR 스캔으로 접속(opt-in 네트워크 공개).
- 🐞 **친절한 에러 표시** — 에러를 유리 카드로 띄우고 사람이 이해하기 쉬운 설명 + 원문 표시.
  **에러 카드를 클릭하면 에디터의 해당 줄로 이동**하고, ⧉ 버튼으로 **복사**(개별/전체)할 수 있습니다. 툴바에 에러 상태 배지(✓/⚠).
- 🔍 **품질 점검** — 깨진 링크·alt 없는 이미지를 자동 점검(옵션).
- 🖥 **미리보기 콘솔** — 페이지의 `console.*`·에러를 'HTML Preview Console' 패널로 전달.
- 🧰 **툴바 도구** — 하드 새로고침·배경 전환(흰/체커/다크)·그리드 오버레이·설정 드로어(⚙️).
- 🎯 **요소 검사** — 툴바 과녁(🎯) 버튼을 켜고 미리보기의 요소를 클릭하면 **에디터의 해당 소스 줄로 이동**.
  같은 태그가 여러 개여도 **몇 번째 요소인지(nth)까지 계산**해 정확한 줄을 찾습니다.
- 📌 **미리보기 고정 / ⏸ 일시정지** — 툴바에서 대상 파일을 고정하거나 자동 새로고침을 잠시 멈춤.
- 🔄 **에디터 스크롤 동기화** — 에디터를 스크롤하면 미리보기도 따라감(`syncScroll`, 옵션).
- 📂 **디렉터리 목록** — index.html 없는 폴더는 파일 목록을 보여줍니다.
- 🧭 **브라우저에서 열기 / URL 복사**, 상태바 표시, SPA 폴백, 고정 포트.

## 🚀 사용법

1. HTML 파일을 열면 미리보기가 자동으로 열립니다(설정으로 끌 수 있음).
2. 수동으로 열려면:
   - 에디터 우상단 **미리보기 아이콘**
   - 단축키 `⌘⇧1` (mac) / `Ctrl+Shift+1`
   - 명령 팔레트(`⌘⇧P`) → **HTML: 미리보기 열기**
3. 편집하면 즉시 반영. 상단 툴바로 기기 폭 전환, 🌐로 브라우저에서 열기, ⚙️로 설정.

## ⚙️ 설정

| 설정 | 기본값 | 설명 |
| --- | --- | --- |
| `htmlViewer.autoOpenOnHtml` | `true` | HTML 파일을 열면 미리보기 자동 열기 |
| `htmlViewer.autoOpenOnFolder` | `false` | 폴더를 열 때 HTML(index.html 우선)을 찾아 자동 열기 |
| `htmlViewer.autoRefresh` | `onType` | `onType`(입력 즉시) / `onSave`(저장 시) / `off`(수동) |
| `htmlViewer.refreshDelay` | `300` | onType 모드에서 입력 후 새로고침까지 대기(ms) |
| `htmlViewer.followActiveEditor` | `true` | 포커스한 HTML로 미리보기 대상 자동 전환 |
| `htmlViewer.forwardConsole` | `true` | 페이지 콘솔/에러를 'HTML Preview Console' 패널로 전달 |
| `htmlViewer.showErrorOverlay` | `true` | 에러 발생 시 미리보기 화면에 유리 카드로 표시 |
| `htmlViewer.qualityChecks` | `false` | 깨진 링크·alt 없는 이미지 점검 |
| `htmlViewer.spaFallback` | `false` | 확장자 없는 경로 → index.html (SPA 라우팅) |
| `htmlViewer.port` | `0` | 서버 포트 고정 (0=자동) |
| `htmlViewer.allowNetworkPreview` | `false` | ⚠️ 같은 Wi-Fi 기기 접속 허용 (QR용) |
| `htmlViewer.syncScroll` | `false` | 에디터 스크롤 → 미리보기 동기화 |

## 🧭 명령

`HTML: 미리보기 열기` · `미리보기 열기 (옆 패널)` · `새로고침` · `브라우저에서 열기` ·
`미리보기 URL 복사` · `미리보기 콘솔 열기` · `설정 열기` · `휴대폰으로 보기 (QR)`

## 🔒 동작 방식 · 보안

- 미리보기는 **`127.0.0.1`(로컬)에만** 바인딩된 정적 서버로 제공되어 외부에 노출되지 않습니다.
- 서버 루트는 **워크스페이스 폴더**(없으면 해당 파일의 폴더). 상위 경로 접근은 차단됩니다.
- 로컬 한정이지만 워크스페이스 파일이 서빙 대상이 되므로, 민감 파일(`.env` 등)이 있는
  폴더에서 사용할 때는 알고 사용하세요.

## 📦 설치

- `.vsix` 파일을 확장 패널 `...` → **VSIX에서 설치**, 또는:
  ```bash
  code --install-extension html-live-viewer-<버전>.vsix
  ```

## 🛠 개발

```bash
npm test       # 서버 통합 테스트 + 확장 관통 테스트
npm run package # .vsix 생성
```

## 한계

- 미리보기는 한 번에 하나(단일 패널)입니다.
- 프레임워크 개발 서버(Vite/Next 등)를 대체하지 않습니다. 정적/단순 HTML 프로젝트용입니다.

## 라이선스

MIT
