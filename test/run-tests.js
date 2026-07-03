// vscode 모듈을 목으로 가로채 extension.js 를 실제 실행하며 동작을 검증한다.
// 서버 기반이므로 실제 로컬 서버가 뜨고, iframe src 를 실제로 http 요청해 관통 검증한다.
'use strict';

const Module = require('module');
const http = require('http');
const fs = require('fs');
const os = require('os');
const path = require('path');
const mock = require('./mock-vscode');

const origLoad = Module._load;
Module._load = function (request) {
  if (request === 'vscode') return mock;
  return origLoad.apply(this, arguments);
};

const EXT = require.resolve('../extension.js');
function loadExtFresh() {
  delete require.cache[EXT];
  return require(EXT);
}

function fakeContext() { return { subscriptions: [] }; }
function fakeDoc(fsPath, getTextFn, scheme) {
  return {
    languageId: 'html',
    fileName: fsPath,
    uri: { scheme: scheme || 'file', fsPath, toString() { return (scheme || 'file') + '://' + fsPath; } },
    getText() { return typeof getTextFn === 'function' ? getTextFn() : getTextFn; }
  };
}
function tmpDir() { return fs.mkdtempSync(path.join(os.tmpdir(), 'hlv-ext-')); }
const tick = (ms) => new Promise((r) => setTimeout(r, ms || 80));
function iframeSrc(html) { const m = /<iframe[^>]*\ssrc="([^"]+)"/.exec(html || ''); return m ? m[1] : null; }
function origin(url) { const m = /^(https?:\/\/[^/]+)/.exec(url || ''); return m ? m[1] : null; }
function httpGet(url) {
  return new Promise((resolve, reject) => {
    http.get(url, (res) => {
      const chunks = []; res.on('data', (c) => chunks.push(c));
      res.on('end', () => resolve({ status: res.statusCode, body: Buffer.concat(chunks).toString('utf8') }));
    }).on('error', reject);
  });
}
function httpPost(url, body) {
  return new Promise((resolve, reject) => {
    const u = new URL(url);
    const req = http.request({ host: u.hostname, port: u.port, path: u.pathname, method: 'POST' }, (res) => {
      res.on('data', () => {}); res.on('end', () => resolve({ status: res.statusCode }));
    });
    req.on('error', reject); req.end(body);
  });
}

let pass = 0, fail = 0;
function check(name, cond) {
  if (cond) { pass++; console.log('  ✓ ' + name); }
  else { fail++; console.log('  ✗ ' + name + '  <-- FAILED'); }
}

(async () => {
  // 1) 활성 HTML 에디터 → 서버 기반 미리보기 (extension→server 관통)
  {
    console.log('\n[1] 활성 HTML → 로컬 서버 미리보기 (관통)');
    mock.__reset();
    const dir = tmpDir();
    fs.writeFileSync(path.join(dir, 'index.html'),
      '<!DOCTYPE html><html><head><link rel="stylesheet" href="style.css"></head><body><h1>HELLO_MARKER</h1></body></html>');
    fs.writeFileSync(path.join(dir, 'style.css'), 'h1{color:green}');
    const doc = fakeDoc(path.join(dir, 'index.html'), () => fs.readFileSync(path.join(dir, 'index.html'), 'utf8'));
    mock.__state.workspaceFolderRoot = dir;
    mock.__state.textDocuments = [doc];
    mock.__state.activeTextEditor = { document: doc };
    const ext = loadExtFresh();
    ext.activate(fakeContext());
    await tick();
    const p = mock.__state.panels[0];
    const src = p && iframeSrc(p.webview.html);
    check('웹뷰가 iframe 셸을 사용', !!src);
    check('iframe이 로컬 서버를 가리킴', !!src && /127\.0\.0\.1:\d+/.test(src));
    if (src) {
      const r = await httpGet(src);
      check('서버 응답 200', r.status === 200);
      check('페이지 내용 서빙', r.body.includes('HELLO_MARKER'));
      check('라이브리로드 스크립트 주입됨', r.body.includes('EventSource'));
      const css = await httpGet(src.replace(/index\.html$/, 'style.css'));
      check('링크된 CSS도 서빙', css.status === 200 && css.body.includes('color:green'));
    }
    ext.deactivate();
  }

  // 2) 폴더만 열림 → index.html 선택 후 서버 미리보기
  {
    console.log('\n[2] 폴더 열기 → index.html 자동 선택 (관통)');
    mock.__reset();
    mock.__state.config['htmlViewer.autoOpenOnFolder'] = true; // 폴더 자동열기는 옵트인
    const dir = tmpDir();
    fs.mkdirSync(path.join(dir, 'a', 'b'), { recursive: true });
    fs.writeFileSync(path.join(dir, 'index.html'), '<html><body>WORKSPACE_MARKER</body></html>');
    fs.writeFileSync(path.join(dir, 'a', 'b', 'deep.html'), '<html><body>DEEP</body></html>');
    mock.__state.activeTextEditor = undefined;
    mock.__state.workspaceFolders = [{ uri: mock.Uri.file(dir) }];
    mock.__state.workspaceFolderRoot = dir;
    mock.__state.findFilesResult = [mock.Uri.file(path.join(dir, 'a', 'b', 'deep.html')), mock.Uri.file(path.join(dir, 'index.html'))];
    mock.__state.openTextDocumentResult = fakeDoc(path.join(dir, 'index.html'), () => fs.readFileSync(path.join(dir, 'index.html'), 'utf8'));
    const ext = loadExtFresh();
    ext.activate(fakeContext());
    await tick(120);
    const p = mock.__state.panels[0];
    const src = p && iframeSrc(p.webview.html);
    check('폴더 스캔으로 패널 생성', !!p && !!src);
    if (src) {
      check('여러 후보 중 index.html 선택', /index\.html$/.test(src));
      const r = await httpGet(src);
      check('index.html 내용 서빙', r.body.includes('WORKSPACE_MARKER'));
    }
    ext.deactivate();
  }

  // 3) 저장 안 한 편집도 미리보기에 반영 (열린 버퍼 우선)
  {
    console.log('\n[3] 저장하지 않은 편집도 반영 (버퍼 우선, 관통)');
    mock.__reset();
    const dir = tmpDir();
    fs.writeFileSync(path.join(dir, 'index.html'), '<html><body>DISK_ONLY</body></html>');
    const doc = fakeDoc(path.join(dir, 'index.html'), () => '<html><body>UNSAVED_EDIT</body></html>'); // 버퍼는 디스크와 다름
    mock.__state.workspaceFolderRoot = dir;
    mock.__state.textDocuments = [doc];
    mock.__state.activeTextEditor = { document: doc };
    const ext = loadExtFresh();
    ext.activate(fakeContext());
    await tick();
    const src = iframeSrc(mock.__state.panels[0].webview.html);
    const r = await httpGet(src);
    check('디스크가 아닌 편집 중 버퍼 내용 서빙', r.body.includes('UNSAVED_EDIT') && !r.body.includes('DISK_ONLY'));
    ext.deactivate();
  }

  // 4) autoOpenOnHtml=false → 자동으로 열지 않음(서버도 안 뜸)
  {
    console.log('\n[4] autoOpenOnHtml=false 면 열지 않음');
    mock.__reset();
    mock.__state.config['htmlViewer.autoOpenOnHtml'] = false;
    const dir = tmpDir();
    fs.writeFileSync(path.join(dir, 'index.html'), '<html><body>X</body></html>');
    mock.__state.workspaceFolderRoot = dir;
    mock.__state.activeTextEditor = { document: fakeDoc(path.join(dir, 'index.html'), '<html></html>') };
    const ext = loadExtFresh();
    ext.activate(fakeContext());
    await tick();
    check('패널 생성 안 됨', mock.__state.panels.length === 0);
    ext.deactivate();
  }

  // 5) untitled(파일 아님) → 직접 렌더 폴백 (iframe 아님)
  {
    console.log('\n[5] untitled 문서 폴백(직접 렌더)');
    mock.__reset();
    const doc = fakeDoc('Untitled-1', () => '<html><body>UNTITLED_MARK</body></html>', 'untitled');
    mock.__state.activeTextEditor = { document: doc };
    const ext = loadExtFresh();
    ext.activate(fakeContext());
    await tick();
    const p = mock.__state.panels[0];
    check('패널 생성됨', !!p);
    check('내용 직접 표시(iframe 아님)', !!p && p.webview.html.includes('UNTITLED_MARK') && !/<iframe/.test(p.webview.html));
    ext.deactivate();
  }

  // 5b) 폴더 자동열기는 기본 꺼짐 (배포용 안전 기본값)
  {
    console.log('\n[5b] 폴더 자동열기 기본 꺼짐 → 시작 시 안 튀어나옴');
    mock.__reset();
    const dir = tmpDir();
    fs.writeFileSync(path.join(dir, 'index.html'), '<html><body>NOAUTO</body></html>');
    mock.__state.activeTextEditor = undefined; // 활성 HTML 없음(폴더만 열린 상황)
    mock.__state.workspaceFolders = [{ uri: mock.Uri.file(dir) }];
    mock.__state.workspaceFolderRoot = dir;
    mock.__state.findFilesResult = [mock.Uri.file(path.join(dir, 'index.html'))];
    mock.__state.openTextDocumentResult = fakeDoc(path.join(dir, 'index.html'), '<html></html>');
    const ext = loadExtFresh();
    ext.activate(fakeContext());
    await tick(120);
    check('autoOpenOnFolder 기본값(false)이면 패널 안 생김', mock.__state.panels.length === 0);
    ext.deactivate();
  }

  // 6) 미리보기 콘솔 전달 (페이지 console/에러 → 출력 패널, 관통)
  {
    console.log('\n[6] 미리보기 콘솔/에러 전달 (관통)');
    mock.__reset();
    const dir = tmpDir();
    fs.writeFileSync(path.join(dir, 'index.html'), '<html><body>C</body></html>');
    const doc = fakeDoc(path.join(dir, 'index.html'), () => fs.readFileSync(path.join(dir, 'index.html'), 'utf8'));
    mock.__state.workspaceFolderRoot = dir;
    mock.__state.textDocuments = [doc];
    mock.__state.activeTextEditor = { document: doc };
    const ext = loadExtFresh();
    ext.activate(fakeContext());
    await tick();
    const src = iframeSrc(mock.__state.panels[0].webview.html);
    // 서빙된 HTML에 콘솔 후킹 스니펫이 들어있는지
    const served = await httpGet(src);
    check('서빙 HTML에 콘솔 후킹 주입', served.body.includes('sendBeacon') && served.body.includes('__log'));
    // 페이지가 로그를 보냈다고 가정하고 /__log 로 POST → 출력 패널에 반영되는지
    await httpPost(origin(src) + '/__log', JSON.stringify({ level: 'warn', msg: 'HELLO_CONSOLE' }));
    await tick(40);
    const lines = (mock.__state.outputs['HTML Preview Console'] || []).join('\n');
    check('콘솔 로그가 출력 패널로 전달됨', lines.includes('HELLO_CONSOLE') && lines.includes('[WARN]'));
    check('타임스탬프 프리픽스', (mock.__state.outputs['HTML Preview Console'] || []).some((l) => /^\[\d{2}:\d{2}:\d{2}\]/.test(l)));
    ext.deactivate();
  }

  // 7) 명령: URL 복사 / 반응형 툴바 셸
  {
    console.log('\n[7] URL 복사 명령 + 반응형 툴바 셸');
    mock.__reset();
    const dir = tmpDir();
    fs.writeFileSync(path.join(dir, 'index.html'), '<html><body>Z</body></html>');
    const doc = fakeDoc(path.join(dir, 'index.html'), () => '<html><body>Z</body></html>');
    mock.__state.workspaceFolderRoot = dir;
    mock.__state.textDocuments = [doc];
    mock.__state.activeTextEditor = { document: doc };
    const ext = loadExtFresh();
    ext.activate(fakeContext());
    await tick();
    const p0 = mock.__state.panels[0];
    const html = p0.webview.html;
    check('셸에 반응형 프리셋(기기/폭) 포함', /id="dev"/.test(html) && /value="375"/.test(html));
    check('셸 스크립트는 nonce 사용(CSP)', /script-src 'nonce-/.test(html) && /<script nonce="/.test(html));
    check('미리보기 툴바에 ⚙️ 설정 서랍 포함', html.includes('id="gear"') && html.includes('id="drawer"') && html.includes('class="switch"'));
    check('툴바에 기기 프리셋/커스텀 폭/줌 포함', html.includes('id="dev"') && html.includes('id="w"') && html.includes('id="zo"') && html.includes('id="zi"'));
    check('툴바에 하드리로드/배경/그리드 포함', html.includes('id="rl"') && html.includes('id="bgb"') && html.includes('id="grb"') && html.includes('id="gridov"'));
    check('툴바에 에러 상태 배지 + errcount 처리', html.includes('id="eb"') && html.includes('errcount'));
    check('반응형: 회전/디바이스 프레임/치수맵 포함', html.includes('id="rot"') && html.includes('id="frm"') && html.includes('DIMS') && html.includes('bezel'));
    check('에러→소스 점프 브리지 포함', html.includes('__hlv') && html.includes('openSource'));
    const src = iframeSrc(html);
    mock.__runCommand('htmlViewer.copyUrl');
    check('copyUrl 이 미리보기 URL을 클립보드에 복사', mock.__state.clipboard === src);
    // 미리보기 안 설정 서랍에서 토글 → config 저장 (관통)
    p0.webview.__fireMessage({ type: 'update', key: 'forwardConsole', value: false });
    check('미리보기 내 설정 변경이 config에 저장됨',
      mock.__state.configUpdates.some((u) => u.key === 'htmlViewer.forwardConsole' && u.value === false));
    // 에러 → 소스 점프: openSource 메시지 → 파일/줄 열기 (관통)
    mock.__state.openTextDocumentResult = doc;
    p0.webview.__fireMessage({ type: 'openSource', raw: 'doSomething is not defined (index.html:14)' });
    await tick(15);
    check('openSource가 올바른 파일을 엶', mock.__state.openedUri && /index\.html$/.test(mock.__state.openedUri.fsPath));
    check('올바른 줄(14→0-index 13)로 이동', mock.__state.shownDoc && mock.__state.shownDoc.opts.selection.start.line === 13);
    ext.deactivate();
  }

  // 7b) 설정 UI 패널: 열기 → 토글 메시지 → config 저장
  {
    console.log('\n[7b] 설정 UI 패널 (토글 → 설정 저장)');
    mock.__reset();
    const ext = loadExtFresh();
    ext.activate(fakeContext());
    await tick(10);
    mock.__runCommand('htmlViewer.openSettings');
    await tick(10);
    const sp = mock.__state.panels[mock.__state.panels.length - 1];
    const html = sp.webview.html;
    check('설정 패널에 토글 스위치 포함', html.includes('class="switch"') && html.includes('data-key="autoOpenOnFolder"'));
    check('자동새로고침 세그먼트 포함', html.includes('data-key="autoRefresh"') && html.includes('data-val="onSave"'));
    check('지연 슬라이더 포함', html.includes('type="range"') && html.includes('data-key="refreshDelay"'));
    // 웹뷰에서 토글을 켰다고 시뮬레이션 → config.update 호출되는지
    sp.webview.__fireMessage({ type: 'update', key: 'autoOpenOnFolder', value: true });
    sp.webview.__fireMessage({ type: 'update', key: 'refreshDelay', value: 500 });
    const ups = mock.__state.configUpdates;
    check('토글 변경이 설정에 저장됨', ups.some((u) => u.key === 'htmlViewer.autoOpenOnFolder' && u.value === true));
    check('슬라이더 값이 설정에 저장됨', ups.some((u) => u.key === 'htmlViewer.refreshDelay' && u.value === 500));
    ext.deactivate();
  }

  // 7b2) 요소 검사 점프 + 에디터 스크롤 동기화
  {
    console.log('\n[7b2] 요소 검사 점프 · 스크롤 동기화');
    mock.__reset();
    mock.__state.config['htmlViewer.syncScroll'] = true;
    const dir = tmpDir();
    const CONTENT = '<html>\n<body>\n<div id="hero">Hi</div>\n</body>\n</html>';
    fs.writeFileSync(path.join(dir, 'index.html'), CONTENT);
    const doc = fakeDoc(path.join(dir, 'index.html'), () => CONTENT);
    doc.lineCount = 5;
    mock.__state.workspaceFolderRoot = dir;
    mock.__state.textDocuments = [doc];
    mock.__state.activeTextEditor = { document: doc };
    const ext = loadExtFresh();
    ext.activate(fakeContext());
    await tick();
    const p0 = mock.__state.panels[0];
    // 검사 클릭 → id="hero" 줄(index 2)로 점프
    p0.webview.__fireMessage({ type: 'pick', info: { tag: 'div', id: 'hero', cls: '', text: 'Hi' } });
    await tick(10);
    check('pick → id 줄로 점프(2)', mock.__state.shownDoc && mock.__state.shownDoc.opts.selection.start.line === 2);
    // 에디터 스크롤 → scrollTo 메시지
    mock.__fireVisibleRanges({ textEditor: { document: doc }, visibleRanges: [{ start: { line: 2 } }] });
    await tick(10);
    const posted = p0.webview._posted || [];
    const sc = posted.find((m) => m && m.type === 'scrollTo');
    check('스크롤 동기화 → scrollTo(ratio 0.5)', !!sc && Math.abs(sc.ratio - 0.5) < 0.01);
    check('셸에 검사 버튼/브리지 포함', p0.webview.html.includes('id="ins"') && p0.webview.html.includes('scrollTo'));
    ext.deactivate();
  }

  // 7b3) nth 점프 · 핀 · 일시정지 · 상태바 에러 (관통)
  {
    console.log('\n[7b3] nth 점프 · 핀 · 일시정지 · 상태바');
    mock.__reset();
    const dir = tmpDir();
    const C = '<html>\n<body>\n<li>one</li>\n<li>two</li>\n<li>three</li>\n</body>\n</html>';
    fs.writeFileSync(path.join(dir, 'index.html'), C);
    const doc = fakeDoc(path.join(dir, 'index.html'), () => C);
    mock.__state.workspaceFolderRoot = dir;
    mock.__state.textDocuments = [doc];
    mock.__state.activeTextEditor = { document: doc };
    const ext = loadExtFresh();
    ext.activate(fakeContext());
    await tick();
    const p0 = mock.__state.panels[0];
    check('툴바에 핀/일시정지 버튼', p0.webview.html.includes('id="pin"') && p0.webview.html.includes('id="pause"'));
    // nth: 3번째 li(줄 4)로 점프
    p0.webview.__fireMessage({ type: 'pick', info: { tag: 'li', id: '', cls: '', text: 'three', nth: 2 } });
    await tick(10);
    check('nth 기반 점프(3번째 li → 줄 4)', mock.__state.shownDoc && mock.__state.shownDoc.opts.selection.start.line === 4);
    // 핀: 다른 HTML로 포커스해도 대상 유지
    p0.webview.__fireMessage({ type: 'pin', on: true });
    const other = fakeDoc(path.join(dir, 'b.html'), () => '<html><body>B</body></html>');
    mock.__fireActiveEditor({ document: other });
    await tick(40);
    check('핀 고정 중엔 따라가지 않음', p0.title === '미리보기: index.html');
    p0.webview.__fireMessage({ type: 'pin', on: false });
    // 일시정지: 실제 SSE로 신호 유무 관찰
    const src = iframeSrc(p0.webview.html);
    const u = new URL(origin(src) + '/__livereload');
    const buf = { s: '' };
    const sseReq = http.get({ host: u.hostname, port: u.port, path: u.pathname }, (res) => {
      res.on('data', (c) => { buf.s += c.toString('utf8'); });
    });
    await tick(80);
    mock.__fireSaveDoc(doc);
    await tick(150);
    check('저장 → 리로드 신호 수신', /data:\s*(reload|css)/.test(buf.s));
    buf.s = '';
    p0.webview.__fireMessage({ type: 'pause', on: true });
    mock.__fireSaveDoc(doc);
    await tick(200);
    check('일시정지 중엔 신호 없음', !/data:/.test(buf.s));
    p0.webview.__fireMessage({ type: 'pause', on: false });
    await tick(150);
    check('재개 시 밀린 변경 즉시 반영(리로드)', /data:\s*(reload|css)/.test(buf.s));
    // 악성 postMessage 방어: RegExp 메타문자 태그 → 예외 없이 무시, 이후 정상 동작
    p0.webview.__fireMessage({ type: 'pick', info: { tag: 'li(*+', id: '', cls: '', text: '', nth: 1e9 } });
    await tick(10);
    p0.webview.__fireMessage({ type: 'pick', info: { tag: 'li', id: '', cls: '', text: '', nth: 0 } });
    await tick(10);
    check('악성 pick 무해 + 이후 정상 점프', mock.__state.shownDoc && mock.__state.shownDoc.opts.selection.start.line === 2);
    // 상태바 에러 카운트
    p0.webview.__fireMessage({ type: 'errcount', n: 3 });
    await tick(10);
    const sb = (mock.__state.statusBars || [])[0];
    check('상태바에 에러 수 표시', !!sb && /3/.test(sb.text));
    try { sseReq.destroy(); } catch (_) {}
    ext.deactivate();
  }

  // 7c) QR 명령: 미리보기 없으면 안내, 있으면 네트워크 공개 경고
  {
    console.log('\n[7c] QR 명령(휴대폰으로 보기)');
    mock.__reset();
    const ext = loadExtFresh();
    ext.activate(fakeContext());
    await tick(10);
    check('showQr 명령 등록됨', typeof mock.__state.commands['htmlViewer.showQr'] === 'function');
    await mock.__runCommand('htmlViewer.showQr');
    check('미리보기 없으면 안내 메시지', mock.__state.infoMessages.some((m) => m.includes('미리보기')));
    ext.deactivate();

    // 미리보기 열린 상태 → 네트워크 공개 확인 경고가 떠야 함(목은 취소 반환)
    mock.__reset();
    const dir = tmpDir();
    fs.writeFileSync(path.join(dir, 'index.html'), '<html><body>Q</body></html>');
    const doc = fakeDoc(path.join(dir, 'index.html'), () => '<html><body>Q</body></html>');
    mock.__state.workspaceFolderRoot = dir;
    mock.__state.textDocuments = [doc];
    mock.__state.activeTextEditor = { document: doc };
    const ext2 = loadExtFresh();
    ext2.activate(fakeContext());
    await tick();
    await mock.__runCommand('htmlViewer.showQr');
    check('네트워크 공개 경고 표시(opt-in)', (mock.__state.warnMessages || []).some((m) => m.includes('공개')));
    check('취소하면 설정 안 바뀜', !mock.__state.configUpdates.some((u) => u.key === 'htmlViewer.allowNetworkPreview'));
    ext2.deactivate();
  }

  // 8) 순수 유틸/셸
  {
    console.log('\n[8] 유틸 함수');
    const t = loadExtFresh().__test;
    check('isHtml: .html 인식', t.isHtml({ fileName: 'a.html', languageId: 'plaintext' }) === true);
    check('isHtml: 비HTML 거부', t.isHtml({ fileName: 'a.txt', languageId: 'plaintext' }) === false);
    check('iframeShell: iframe+url 포함', t.iframeShell('http://x/').includes('src="http://x/"'));
    check('iframeShell: 따옴표 이스케이프', t.iframeShell('http://x/"y').includes('&quot;'));
    check('escapeHtml 동작', t.escapeHtml('<a>&"') === '&lt;a&gt;&amp;&quot;');
  }

  console.log('\n' + pass + ' passed, ' + fail + ' failed');
  process.exit(fail ? 1 : 0);
})().catch((e) => { console.error('TEST HARNESS ERROR:', e); process.exit(2); });
