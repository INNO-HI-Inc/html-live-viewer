// @ts-check
const vscode = require('vscode');
const path = require('path');
const { PreviewServer } = require('./server');

/** @type {import('vscode').OutputChannel | undefined} */
let output;
/** @type {import('vscode').OutputChannel | undefined} 미리보기 페이지 콘솔/에러 */
let consoleChannel;
/** @type {PreviewPanel | undefined} 단일 미리보기 패널 */
let panel;
/** @type {PreviewServer | undefined} 현재 정적 서버 (워크스페이스 루트당 하나) */
let server;
/** @type {string | undefined} 현재 서버 루트 경로 */
let serverRoot;
/** @type {import('vscode').StatusBarItem | undefined} */
let statusBar;
/** @type {import('vscode').WebviewPanel | undefined} 설정 패널 */
let settingsPanel;
/** @type {any} 리로드 디바운스 타이머 */
let reloadTimer;

function dbg(m) {
  if (!output) return;
  try { output.appendLine(m); } catch (_) { /* noop */ }
}

/** 이벤트 콜백을 감싸 예외가 확장 전체로 번지지 않게 한다. */
function guard(fn) {
  return function (...args) {
    try { return fn.apply(this, args); }
    catch (e) { dbg('handler error: ' + (e && e.stack ? e.stack : String(e))); }
  };
}

function isHtml(doc) {
  if (!doc) return false;
  try { return doc.languageId === 'html' || /\.x?html?$/i.test(doc.fileName || ''); }
  catch (_) { return false; }
}

function getConfig() {
  return vscode.workspace.getConfiguration('htmlViewer');
}

/** 설정 UI에 넘길 현재 config 값 묶음. */
function currentSettings() {
  const cfg = getConfig();
  return {
    autoOpenOnHtml: cfg.get('autoOpenOnHtml', true),
    autoOpenOnFolder: cfg.get('autoOpenOnFolder', false),
    followActiveEditor: cfg.get('followActiveEditor', true),
    forwardConsole: cfg.get('forwardConsole', true),
    showErrorOverlay: cfg.get('showErrorOverlay', true),
    qualityChecks: cfg.get('qualityChecks', false),
    autoRefresh: cfg.get('autoRefresh', 'onType'),
    refreshDelay: cfg.get('refreshDelay', 300)
  };
}

/** 웹뷰에서 온 설정 변경 메시지를 config에 반영. */
function applySettingMessage(m) {
  if (m && m.type === 'update' && m.key) {
    try { getConfig().update(m.key, m.value, vscode.ConfigurationTarget.Global); }
    catch (e) { dbg('settings update error: ' + e); }
  }
}

/** 미리보기 에러 원문에서 (파일:줄)을 파싱해 에디터로 이동. */
function openSourceFromPreview(raw) {
  try {
    raw = String(raw || '');
    const paren = raw.match(/\(([^()]+)\)\s*$/) || raw.match(/\(([^()]+)\)/);
    if (!paren) return;
    const inside = paren[1];
    const lm = inside.match(/:(\d+):(\d+)$/) || inside.match(/:(\d+)$/);
    if (!lm) return;
    const line = Math.max(0, (parseInt(lm[1], 10) || 1) - 1);
    let fileUrl = inside.slice(0, lm.index);
    let rel;
    if (/^https?:\/\//i.test(fileUrl)) { try { rel = new URL(fileUrl).pathname; } catch (_) { rel = fileUrl; } }
    else rel = fileUrl;
    try { rel = decodeURIComponent(rel); } catch (_) { /* noop */ }
    rel = rel.replace(/^\/+/, '');
    if (!rel) return;
    const base = serverRoot || (panel && panel.sourceDoc && rootForDoc(panel.sourceDoc));
    if (!base) return;
    const fsPath = path.join(base, rel);
    Promise.resolve(vscode.workspace.openTextDocument(vscode.Uri.file(fsPath))).then((doc) => {
      const pos = new vscode.Position(line, 0);
      vscode.window.showTextDocument(doc, { selection: new vscode.Range(pos, pos), preview: false });
    }, (e) => dbg('openSource open failed: ' + e));
  } catch (e) { dbg('openSource error: ' + e); }
}

/** 문서가 속한 서버 루트: 워크스페이스 폴더 우선, 없으면 파일이 있는 디렉터리. */
function rootForDoc(doc) {
  try {
    const f = vscode.workspace.getWorkspaceFolder(doc.uri);
    if (f) return f.uri.fsPath;
  } catch (_) { /* noop */ }
  try {
    if (doc.uri.scheme === 'file') return path.dirname(doc.uri.fsPath);
  } catch (_) { /* noop */ }
  return undefined;
}

function isUnderRoot(doc) {
  try {
    return !!serverRoot && doc.uri.scheme === 'file' &&
      (doc.uri.fsPath === serverRoot || doc.uri.fsPath.startsWith(serverRoot + path.sep));
  } catch (_) { return false; }
}

/** 루트에 맞는 서버를 보장(있으면 재사용, 루트가 바뀌면 재시작). */
async function ensureServer(root) {
  if (server && serverRoot === root) return server;
  if (server) { server.dispose(); server = undefined; serverRoot = undefined; }
  const s = new PreviewServer(root);
  // 열린 에디터 버퍼(저장 안 한 변경) 우선 제공
  s.readText = (absPath) => {
    const docs = vscode.workspace.textDocuments || [];
    for (const d of docs) {
      try { if (d.uri.scheme === 'file' && d.uri.fsPath === absPath) return d.getText(); }
      catch (_) { /* noop */ }
    }
    return undefined;
  };
  // 미리보기 페이지의 console.*/에러를 VS Code 출력 패널로 전달
  s.forwardConsole = getConfig().get('forwardConsole', true);
  // 에러 발생 시 미리보기 화면에 배너 오버레이 표시
  s.showErrorOverlay = getConfig().get('showErrorOverlay', true);
  // 로드 시 품질 점검(깨진 링크·alt 누락)
  s.qualityChecks = getConfig().get('qualityChecks', false);
  // SPA 폴백(알 수 없는 경로 → index.html)
  s.spaFallback = getConfig().get('spaFallback', false);
  s.onClientLog = (entry) => {
    if (!consoleChannel || !entry) return;
    const level = String(entry.level || 'log').toUpperCase();
    try { consoleChannel.appendLine('[' + level + '] ' + String(entry.msg == null ? '' : entry.msg)); }
    catch (_) { /* noop */ }
  };
  await s.start(getConfig().get('port', 0));
  server = s;
  serverRoot = root;
  dbg('server started root=' + root + ' port=' + s.port);
  return s;
}

let reloadFull = false; // 대기 중 배치에 CSS 외 변경이 섞이면 전체 리로드

function isCssFile(nameOrPath) {
  return /\.css$/i.test(nameOrPath || '');
}

// kind: 'css'면 스타일시트만 교체, 그 외(또는 배치에 non-CSS 포함)는 전체 리로드
function scheduleReload(delay, kind) {
  if (!server) return;
  if (kind !== 'css') reloadFull = true;
  if (reloadTimer) clearTimeout(reloadTimer);
  reloadTimer = setTimeout(() => {
    reloadTimer = null;
    const k = reloadFull ? 'full' : 'css';
    reloadFull = false;
    if (server) server.notify(k);
  }, Math.max(0, delay | 0));
}

function reloadNow(kind) {
  if (reloadTimer) { clearTimeout(reloadTimer); reloadTimer = null; }
  const k = (kind === 'css' && !reloadFull) ? 'css' : 'full';
  reloadFull = false;
  if (server) server.notify(k);
}

function updateStatusBar() {
  if (!statusBar) return;
  if (server && panel) {
    statusBar.text = '$(open-preview) 미리보기 :' + server.port;
    statusBar.tooltip = 'HTML Live Viewer 실행 중 — 클릭하면 미리보기로 이동';
    statusBar.show();
  } else {
    statusBar.hide();
  }
}

function activate(context) {
  output = vscode.window.createOutputChannel('HTML Live Viewer');
  consoleChannel = vscode.window.createOutputChannel('HTML Preview Console');
  context.subscriptions.push(output, consoleChannel);
  dbg('=== activate ===');

  statusBar = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Right, 100);
  statusBar.command = 'htmlViewer.openPreview';
  context.subscriptions.push(statusBar);

  const setPreviewActive = (v) => {
    try { vscode.commands.executeCommand('setContext', 'htmlViewer.previewActive', v); }
    catch (_) { /* noop */ }
  };
  setPreviewActive(false);

  const open = (toSide, doc) =>
    Promise.resolve()
      .then(() => PreviewPanel.createOrShow(context, toSide, setPreviewActive, doc))
      .catch((e) => dbg('open error: ' + (e && e.stack ? e.stack : String(e))));

  context.subscriptions.push(
    vscode.commands.registerCommand('htmlViewer.openPreviewToSide', () => open(true)),
    vscode.commands.registerCommand('htmlViewer.openPreview', () => open(false)),
    vscode.commands.registerCommand('htmlViewer.refresh', () => reloadNow()),
    vscode.commands.registerCommand('htmlViewer.openInBrowser', () => {
      if (panel && panel._url) {
        try { vscode.env.openExternal(vscode.Uri.parse(panel._url)); } catch (e) { dbg('openExternal error: ' + e); }
      } else {
        vscode.window.showInformationMessage('HTML Live Viewer: 먼저 미리보기를 여세요.');
      }
    }),
    vscode.commands.registerCommand('htmlViewer.copyUrl', () => {
      if (panel && panel._url) {
        try {
          vscode.env.clipboard.writeText(panel._url);
          vscode.window.showInformationMessage('미리보기 URL 복사됨: ' + panel._url);
        } catch (e) { dbg('clipboard error: ' + e); }
      } else {
        vscode.window.showInformationMessage('HTML Live Viewer: 먼저 미리보기를 여세요.');
      }
    }),
    vscode.commands.registerCommand('htmlViewer.showConsole', () => {
      if (consoleChannel) consoleChannel.show(true);
    }),
    vscode.commands.registerCommand('htmlViewer.openSettings', () => openSettings(context))
  );

  const maybeAutoOpen = (editor) => {
    if (panel) return;
    if (!getConfig().get('autoOpenOnHtml', true)) return;
    if (editor && isHtml(editor.document)) open(false, editor.document);
  };

  const findWorkspaceHtml = async () => {
    const folders = vscode.workspace.workspaceFolders;
    if (!folders || !folders.length) return undefined;
    let files;
    try {
      files = await vscode.workspace.findFiles(
        '**/*.{html,htm}',
        '**/{node_modules,.git,dist,build,out,.next,coverage}/**',
        200
      );
    } catch (e) { dbg('findFiles error: ' + e); return undefined; }
    if (!files || !files.length) return undefined;
    const score = (u) => {
      const base = path.basename(u.fsPath).toLowerCase();
      const depth = u.fsPath.split(/[\\/]/).length;
      return (base === 'index.html' || base === 'index.htm' ? 0 : 1000) + depth;
    };
    return files.slice().sort((a, b) => score(a) - score(b))[0];
  };

  const autoOpenInitial = guard(async () => {
    if (panel) return;
    const cfg = getConfig();
    const active = vscode.window.activeTextEditor;
    if (active && isHtml(active.document)) {
      if (!cfg.get('autoOpenOnHtml', true)) { dbg('initial: html auto-open disabled'); return; }
      dbg('initial: active html');
      await open(false, active.document);
      return;
    }
    // 활성 HTML이 없을 때만 폴더 스캔 — 시작 시 튀어나오는 동작이라 기본은 꺼둔다.
    if (!cfg.get('autoOpenOnFolder', false)) { dbg('initial: folder auto-open disabled'); return; }
    const uri = await findWorkspaceHtml();
    if (!uri) { dbg('initial: no html in workspace'); return; }
    dbg('initial: workspace html -> ' + uri.fsPath);
    try {
      const doc = await vscode.workspace.openTextDocument(uri);
      if (!panel) await open(false, doc);
    } catch (e) { dbg('openTextDocument error: ' + e); }
  });

  setTimeout(autoOpenInitial, 0);

  // 활성 에디터를 따라 미리보기 대상 전환 (없으면 자동으로 연다).
  context.subscriptions.push(
    vscode.window.onDidChangeActiveTextEditor(guard((editor) => {
      if (!panel) { maybeAutoOpen(editor); return; }
      if (!getConfig().get('followActiveEditor', true)) return;
      if (editor && isHtml(editor.document)) panel.setSource(editor.document);
    }))
  );

  // 입력 중 자동 새로고침 (onType) — 저장 안 해도 라이브로 반영.
  context.subscriptions.push(
    vscode.workspace.onDidChangeTextDocument(guard((e) => {
      if (!panel || !server) return;
      if (getConfig().get('autoRefresh', 'onType') !== 'onType') return;
      if (isUnderRoot(e.document)) {
        scheduleReload(getConfig().get('refreshDelay', 300), isCssFile(e.document.fileName) ? 'css' : 'full');
      }
    }))
  );

  // 저장 시 즉시 새로고침 (외부 편집·연결 파일 포함).
  context.subscriptions.push(
    vscode.workspace.onDidSaveTextDocument(guard((doc) => {
      if (!panel || !server) return;
      if (getConfig().get('autoRefresh', 'onType') === 'off') return;
      reloadNow(doc && isCssFile(doc.fileName) ? 'css' : 'full');
    }))
  );

  // 디스크 변경 감시 (에디터에 안 열린 파일·외부 도구 변경까지 반영).
  // 서버 루트 밖이거나 흔한 산출물/의존성 디렉터리 변경은 무시해 불필요한 리로드를 막는다.
  try {
    const watcher = vscode.workspace.createFileSystemWatcher('**/*');
    const onFs = guard((uri) => {
      if (!panel || !server) return;
      if (getConfig().get('autoRefresh', 'onType') === 'off') return;
      let p;
      try {
        p = uri && uri.fsPath;
        if (!p || WATCH_EXCLUDE.test(p) || !isUnderRoot({ uri })) return;
      } catch (_) { return; }
      scheduleReload(150, isCssFile(p) ? 'css' : 'full');
    });
    watcher.onDidChange(onFs);
    watcher.onDidCreate(onFs);
    watcher.onDidDelete(onFs);
    context.subscriptions.push(watcher);
  } catch (e) { dbg('watcher error: ' + e); }
}

const WATCH_EXCLUDE = /[\\/](node_modules|\.git|dist|build|out|\.next|coverage)[\\/]/;

class PreviewPanel {
  static pickDoc(preferredDoc) {
    if (preferredDoc && isHtml(preferredDoc)) return preferredDoc;
    const active = vscode.window.activeTextEditor;
    if (active && isHtml(active.document)) return active.document;
    const visible = (vscode.window.visibleTextEditors || []).find((e) => isHtml(e.document));
    return visible ? visible.document : undefined;
  }

  static async createOrShow(context, toSide, setPreviewActive, preferredDoc) {
    const column = toSide ? vscode.ViewColumn.Beside : vscode.ViewColumn.Active;

    if (panel) {
      const d = PreviewPanel.pickDoc(preferredDoc);
      if (d) await panel.setSource(d);
      try { panel.webviewPanel.reveal(column, true); } catch (_) { /* noop */ }
      return;
    }

    const doc = PreviewPanel.pickDoc(preferredDoc);
    if (!doc) {
      vscode.window.showInformationMessage('HTML Live Viewer: 미리볼 HTML 파일을 먼저 열어주세요.');
      return;
    }
    panel = new PreviewPanel(context, doc, column, setPreviewActive);
    await panel.render();
  }

  constructor(context, doc, column, setPreviewActive) {
    this.context = context;
    this.sourceDoc = doc;
    this.setPreviewActive = setPreviewActive;
    this._url = undefined;

    this.webviewPanel = vscode.window.createWebviewPanel(
      'htmlViewer.preview',
      this.title(),
      column,
      { enableScripts: true, retainContextWhenHidden: true }
    );
    try { this.webviewPanel.webview.html = loadingShell(); } catch (_) { /* noop */ }

    // 미리보기에서 온 메시지: 설정 변경 / 에러 소스 점프.
    this.webviewPanel.webview.onDidReceiveMessage(
      guard((m) => {
        if (m && m.type === 'openSource') { openSourceFromPreview(m.raw); return; }
        applySettingMessage(m);
      }), null, context.subscriptions
    );

    this.webviewPanel.onDidChangeViewState(
      guard(() => this.setPreviewActive(!!this.webviewPanel.active)),
      null, context.subscriptions
    );
    this.webviewPanel.onDidDispose(
      guard(() => {
        this.setPreviewActive(false);
        panel = undefined;
        if (server) { server.dispose(); server = undefined; serverRoot = undefined; }
        updateStatusBar();
      }),
      null, context.subscriptions
    );

    this.setPreviewActive(true);
  }

  title() {
    let name = 'HTML';
    try { name = path.basename(this.sourceDoc.fileName); } catch (_) { /* noop */ }
    return '미리보기: ' + name;
  }

  async setSource(doc) {
    if (!doc) return;
    if (this.sourceDoc && doc.uri.toString() === this.sourceDoc.uri.toString()) {
      reloadNow();
      return;
    }
    this.sourceDoc = doc;
    try { this.webviewPanel.title = this.title(); } catch (_) { /* noop */ }
    await this.render();
  }

  async render() {
    const doc = this.sourceDoc;
    const root = rootForDoc(doc);
    if (!root || !doc.uri || doc.uri.scheme !== 'file') { this._setDirect(doc); return; }

    let s;
    try { s = await ensureServer(root); }
    catch (e) { dbg('server start failed: ' + e); this._setDirect(doc); return; }

    const rel = path.relative(root, doc.uri.fsPath).split(path.sep).map(encodeURIComponent).join('/');
    let base = 'http://127.0.0.1:' + s.port + '/';
    try {
      const ext = await vscode.env.asExternalUri(vscode.Uri.parse('http://127.0.0.1:' + s.port));
      base = ext.toString();
      if (!base.endsWith('/')) base += '/';
    } catch (_) { /* 로컬 기본값 사용 */ }

    this._url = base + rel;
    dbg('preview url = ' + this._url);
    try { this.webviewPanel.webview.html = iframeShell(this._url, currentSettings()); }
    catch (e) { dbg('shell set error: ' + e); }
    updateStatusBar();
  }

  /** 파일이 아닌 문서(untitled 등)를 위한 폴백: 내용을 그대로 웹뷰에 표시. */
  _setDirect(doc) {
    this._url = undefined;
    let html;
    try { html = doc.getText(); }
    catch (e) { dbg('getText failed: ' + e); html = fallbackPage('미리볼 내용을 읽을 수 없습니다.'); }
    if (typeof html !== 'string') html = fallbackPage('미리볼 내용이 없습니다.');
    try { this.webviewPanel.webview.html = html; }
    catch (e) { dbg('direct set error: ' + e); }
    updateStatusBar();
  }
}

/** 설정 컨트롤 공통 CSS (설정 패널 + 미리보기 드로어 공유). */
function settingsCss() {
  return '.card{background:var(--vscode-editorWidget-background,#252526);' +
    'border:1px solid var(--vscode-panel-border,#333);border-radius:12px;padding:4px 18px}' +
    '.row{display:flex;align-items:center;justify-content:space-between;gap:16px;' +
    'padding:14px 0;border-bottom:1px solid var(--vscode-panel-border,#333)}' +
    '.row:last-child{border-bottom:0}.meta{min-width:0}' +
    '.name{font-weight:600;font-size:13px}.desc{font-size:12px;opacity:.62;margin-top:3px}' +
    '.switch{position:relative;display:inline-block;width:40px;height:22px;flex:none}' +
    '.switch input{opacity:0;width:0;height:0}' +
    '.slider{position:absolute;inset:0;background:#6b6b6b;border-radius:22px;transition:.2s;cursor:pointer}' +
    '.slider:before{content:"";position:absolute;height:16px;width:16px;left:3px;top:3px;background:#fff;border-radius:50%;transition:.2s}' +
    '.switch input:checked+.slider{background:var(--vscode-button-background,#0e639c)}' +
    '.switch input:checked+.slider:before{transform:translateX(18px)}' +
    '.seg{display:inline-flex;border:1px solid var(--vscode-panel-border,#3a3a3a);border-radius:7px;overflow:hidden;flex:none}' +
    '.seg button{border:0;background:transparent;color:var(--vscode-foreground,#ccc);padding:6px 12px;font-size:12px;cursor:pointer}' +
    '.seg button.active{background:var(--vscode-button-background,#0e639c);color:var(--vscode-button-foreground,#fff)}' +
    '.num{display:flex;align-items:center;gap:10px;flex:none}' +
    '.num input[type=range]{accent-color:var(--vscode-button-background,#0e639c);width:130px}' +
    '.num .val{font:12px monospace;opacity:.8;min-width:54px;text-align:right}';
}

/** 설정 행 마크업 (값 v로 초기 상태 표시). */
function settingsRows(v) {
  v = v || {};
  const chk = (b) => (b ? ' checked' : '');
  const act = (a, b) => (a === b ? ' class="active"' : '');
  const row = (name, desc, control) =>
    '<div class="row"><div class="meta"><div class="name">' + name + '</div>' +
    '<div class="desc">' + desc + '</div></div>' + control + '</div>';
  const toggle = (key, val) =>
    '<label class="switch"><input type="checkbox" data-key="' + key + '"' + chk(val) + '><span class="slider"></span></label>';
  const ar = v.autoRefresh || 'onType';
  const delay = Number(v.refreshDelay) || 0;
  return row('HTML 파일 열면 자동 미리보기', 'HTML 파일을 열면 미리보기를 자동으로 엽니다.', toggle('autoOpenOnHtml', v.autoOpenOnHtml)) +
    row('폴더 열면 자동 미리보기', 'index.html(우선)을 찾아 자동으로 엽니다.', toggle('autoOpenOnFolder', v.autoOpenOnFolder)) +
    row('활성 에디터 따라가기', '다른 HTML로 포커스를 옮기면 대상도 전환됩니다.', toggle('followActiveEditor', v.followActiveEditor)) +
    row('콘솔/에러 전달', "페이지의 console·에러를 'HTML Preview Console'로 보냅니다.", toggle('forwardConsole', v.forwardConsole)) +
    row('에러 화면 표시', '자바스크립트 에러가 나면 미리보기 하단에 빨간 배너로 보여줍니다.', toggle('showErrorOverlay', v.showErrorOverlay)) +
    row('품질 점검', '로드 시 깨진 링크·alt 없는 이미지를 콘솔 패널에 알려줍니다.', toggle('qualityChecks', v.qualityChecks)) +
    row('자동 새로고침', '언제 미리보기를 갱신할지 정합니다.',
      '<div class="seg" data-key="autoRefresh">' +
      '<button data-val="onType"' + act(ar, 'onType') + '>입력 즉시</button>' +
      '<button data-val="onSave"' + act(ar, 'onSave') + '>저장 시</button>' +
      '<button data-val="off"' + act(ar, 'off') + '>수동</button></div>') +
    row('새로고침 지연', '입력 후 갱신까지 대기 시간입니다.',
      '<div class="num"><input type="range" min="0" max="1500" step="50" data-key="refreshDelay" value="' + delay + '">' +
      '<span class="val" id="delayVal">' + delay + 'ms</span></div>');
}

/** 컨트롤을 send(key,value)에 연결하는 JS 본문 (send는 호출측이 정의). */
function settingsControlsScript() {
  return 'document.querySelectorAll("input[type=checkbox][data-key]").forEach(function(c){' +
    'c.addEventListener("change",function(){send(c.getAttribute("data-key"),c.checked);});});' +
    'document.querySelectorAll(".seg[data-key]").forEach(function(s){var k=s.getAttribute("data-key");' +
    's.querySelectorAll("button").forEach(function(b){b.addEventListener("click",function(){' +
    's.querySelectorAll("button").forEach(function(x){x.classList.remove("active");});' +
    'b.classList.add("active");send(k,b.getAttribute("data-val"));});});});' +
    'var r=document.querySelector("input[type=range][data-key]");if(r){var l=document.getElementById("delayVal");' +
    'r.addEventListener("input",function(){l.textContent=r.value+"ms";});' +
    'r.addEventListener("change",function(){send(r.getAttribute("data-key"),parseInt(r.value,10));});}';
}

/**
 * 웹뷰 셸: 로컬 서버를 iframe으로 임베드 + 반응형 기기 폭 툴바 + ⚙️ 설정 서랍.
 * 값 v를 넘기면 툴바 톱니로 그 자리에서 설정을 바꿀 수 있다.
 */
function iframeShell(url, v) {
  const safe = String(url).replace(/"/g, '&quot;');
  const nonce = getNonce();
  return '<!DOCTYPE html><html lang="ko"><head><meta charset="utf-8">' +
    '<meta http-equiv="Content-Security-Policy" content="default-src \'none\'; ' +
    'frame-src http: https:; style-src \'unsafe-inline\'; script-src \'nonce-' + nonce + '\';">' +
    '<style>' +
    'html,body{margin:0;padding:0;height:100%}' +
    'body{display:flex;flex-direction:column;font:12px sans-serif;' +
    'background:var(--vscode-editor-background,#1e1e1e);color:var(--vscode-foreground,#ccc)}' +
    '#bar{display:flex;align-items:center;gap:6px;padding:4px 8px;' +
    'background:var(--vscode-sideBar-background,#252526);border-bottom:1px solid var(--vscode-panel-border,#333)}' +
    '#bar button{cursor:pointer;border:0;border-radius:6px;padding:3px 9px;font:12px sans-serif;' +
    'color:var(--vscode-button-secondaryForeground,#ccc);background:var(--vscode-button-secondaryBackground,#3a3d41)}' +
    '#bar select,#bar input{background:var(--vscode-input-background,#2a2a2e);color:var(--vscode-input-foreground,#ddd);' +
    'border:1px solid var(--vscode-panel-border,#3a3a3a);border-radius:6px;font:12px sans-serif;height:26px;padding:0 6px}' +
    '#bar input#w{width:64px}' +
    '#bar .zc{display:inline-flex;align-items:center;border:1px solid var(--vscode-panel-border,#3a3a3a);border-radius:6px}' +
    '#bar .zc button{background:transparent;padding:2px 8px;font-size:14px;line-height:1;color:var(--vscode-foreground,#ccc)}' +
    '#bar #z{font-size:11px;min-width:40px;text-align:center;opacity:.85}' +
    '#gear{font-size:13px;line-height:1}' +
    '#dim{margin-left:auto;opacity:.65;font-size:11px}' +
    '#eb{font-size:11px;font-weight:700;padding:2px 9px;border-radius:999px;background:rgba(60,180,90,.25);color:#8ef0a8}' +
    '#wrap{flex:1;overflow:auto;display:flex;justify-content:center;position:relative;' +
    'background:var(--vscode-editor-background,#1e1e1e)}' +
    'iframe{border:0;width:100%;height:100%;display:block;background:#fff}' +
    'iframe.framed{box-shadow:0 0 0 1px rgba(0,0,0,.3),0 8px 30px rgba(0,0,0,.35)}' +
    '#gridov{position:absolute;inset:0;pointer-events:none;z-index:5;display:none;' +
    'background-image:linear-gradient(rgba(0,120,220,.18) 1px,transparent 1px),linear-gradient(90deg,rgba(0,120,220,.18) 1px,transparent 1px);background-size:8px 8px}' +
    '#drawer{position:absolute;top:8px;right:8px;width:360px;max-height:calc(100% - 16px);overflow:auto;z-index:10}' +
    '#drawer[hidden]{display:none}' +
    '#drawer .dh{display:flex;align-items:center;justify-content:space-between;padding:8px 4px 4px}' +
    '#drawer .dh b{font-size:12px}#drawer .dh .x{cursor:pointer;opacity:.6;padding:2px 8px;font-size:14px}' +
    settingsCss() +
    '</style></head><body>' +
    '<div id="bar">' +
    '<select id="dev" title="기기 프리셋">' +
    '<option value="0">Desktop</option><option value="1280">Laptop · 1280</option>' +
    '<option value="1024">iPad Pro · 1024</option><option value="820">iPad · 820</option>' +
    '<option value="393">iPhone 15 · 393</option><option value="375">iPhone SE · 375</option>' +
    '<option value="360">Galaxy · 360</option><option value="custom">Custom</option></select>' +
    '<input id="w" type="number" min="200" max="4000" step="10" title="폭(px)">' +
    '<span class="zc"><button id="zo" title="축소">−</button><span id="z">100%</span><button id="zi" title="확대">+</button></span>' +
    '<button id="rl" title="하드 새로고침">⟳</button>' +
    '<button id="bgb" title="배경 전환(흰/체커/다크)">🎨</button>' +
    '<button id="grb" title="그리드 오버레이">▦</button>' +
    '<span id="dim"></span><span id="eb" title="에러 상태">✓</span>' +
    '<button id="gear" title="설정">⚙️</button></div>' +
    '<div id="wrap">' +
    '<iframe id="f" src="' + safe + '" allow="autoplay; fullscreen; clipboard-read; clipboard-write"></iframe>' +
    '<div id="gridov"></div>' +
    '<div id="drawer" hidden><div class="card">' +
    '<div class="dh"><b>⚙️ 설정</b><span class="x" id="gclose">✕</span></div>' +
    settingsRows(v) + '</div></div></div>' +
    '<script nonce="' + nonce + '">(function(){' +
    'var api=(typeof acquireVsCodeApi==="function")?acquireVsCodeApi():null;' +
    'function send(k,val){if(api)api.postMessage({type:"update",key:k,value:val});}' +
    'var f=document.getElementById("f"),dim=document.getElementById("dim");' +
    'var dev=document.getElementById("dev"),win=document.getElementById("w"),zEl=document.getElementById("z");' +
    'function applyW(w){if(!w){f.style.width="100%";f.classList.remove("framed");dim.textContent="100%";}' +
    'else{f.style.width=w+"px";f.classList.add("framed");dim.textContent=w+" px";}if(win)win.value=w||"";}' +
    'dev.addEventListener("change",function(){if(dev.value==="custom"){win.focus();return;}applyW(parseInt(dev.value,10)||0);});' +
    'win.addEventListener("change",function(){var v=parseInt(win.value,10)||0;applyW(v);dev.value="custom";});' +
    'var zoom=1;function setZoom(z){zoom=Math.max(.25,Math.min(2,Math.round(z*100)/100));try{f.style.zoom=zoom;}catch(_){}zEl.textContent=Math.round(zoom*100)+"%";}' +
    'document.getElementById("zo").addEventListener("click",function(){setZoom(zoom-0.1);});' +
    'document.getElementById("zi").addEventListener("click",function(){setZoom(zoom+0.1);});' +
    'applyW(0);setZoom(1);' +
    // 하드 새로고침 / 배경 전환 / 그리드
    'document.getElementById("rl").addEventListener("click",function(){try{f.src=f.src.split("?")[0]+"?hlv="+Date.now();}catch(_){}} );' +
    'var wrap=document.getElementById("wrap"),bgm=0,CHK="conic-gradient(#cfcfcf 25%,#fff 0 50%,#cfcfcf 0 75%,#fff 0) 0 0/18px 18px";' +
    'document.getElementById("bgb").addEventListener("click",function(){bgm=(bgm+1)%3;' +
    'if(bgm===0){wrap.style.background="";f.style.background="#fff";}' +
    'else if(bgm===1){wrap.style.background=CHK;f.style.background="transparent";}' +
    'else{wrap.style.background="#141414";f.style.background="transparent";}});' +
    'var gv=document.getElementById("gridov");' +
    'document.getElementById("grb").addEventListener("click",function(){gv.style.display=(gv.style.display==="block")?"none":"block";});' +
    'var dr=document.getElementById("drawer");' +
    'document.getElementById("gear").addEventListener("click",function(){dr.hidden=!dr.hidden;});' +
    'document.getElementById("gclose").addEventListener("click",function(){dr.hidden=true;});' +
    // inner 미리보기에서 온 에러 클릭 → 소스 열기 요청 전달
    'window.addEventListener("message",function(e){var d=e.data;if(!d)return;' +
    'if(d.__hlv==="open"&&api){api.postMessage({type:"openSource",raw:d.raw});}' +
    'else if(d.__hlv==="errcount"){var eb=document.getElementById("eb");if(eb){if(d.n>0){eb.textContent="⚠ "+d.n;eb.style.background="rgba(220,70,60,.28)";eb.style.color="#ffb3ab";}else{eb.textContent="✓";eb.style.background="rgba(60,180,90,.25)";eb.style.color="#8ef0a8";}}}});' +
    settingsControlsScript() +
    '})();</script></body></html>';
}

function getNonce() {
  let t = '';
  const chars = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789';
  for (let i = 0; i < 24; i++) t += chars.charAt(Math.floor(Math.random() * chars.length));
  return t;
}

/** 설정 전용 웹뷰 패널을 연다(토글/세그먼트/슬라이더 UI → config 저장). */
function openSettings(context) {
  if (settingsPanel) {
    try { settingsPanel.reveal(vscode.ViewColumn.Active); } catch (_) { /* noop */ }
    return;
  }
  const p = vscode.window.createWebviewPanel(
    'htmlViewer.settings', 'HTML Live Viewer 설정',
    vscode.ViewColumn.Active, { enableScripts: true, retainContextWhenHidden: true }
  );
  settingsPanel = p;
  try { p.webview.html = settingsShell(currentSettings(), getNonce()); } catch (e) { dbg('settings html error: ' + e); }
  p.webview.onDidReceiveMessage(guard((m) => applySettingMessage(m)), null, context.subscriptions);
  p.onDidDispose(guard(() => { settingsPanel = undefined; }), null, context.subscriptions);
}

/** 설정 전용 웹뷰(전체 탭) HTML. 미리보기 드로어와 마크업/CSS 공유. */
function settingsShell(v, nonce) {
  return '<!DOCTYPE html><html lang="ko"><head><meta charset="utf-8">' +
    '<meta http-equiv="Content-Security-Policy" content="default-src \'none\'; ' +
    'style-src \'unsafe-inline\'; script-src \'nonce-' + nonce + '\';">' +
    '<style>' +
    ':root{color-scheme:light dark}' +
    'body{margin:0;font:13px -apple-system,BlinkMacSystemFont,"Segoe UI",sans-serif;' +
    'background:var(--vscode-editor-background,#1e1e1e);color:var(--vscode-foreground,#cccccc);padding:28px 20px}' +
    '.wrap{max-width:620px;margin:0 auto}' +
    'header{display:flex;align-items:center;gap:14px;margin-bottom:22px}' +
    '.logo{width:44px;height:44px;border-radius:12px;flex:none;display:flex;align-items:center;' +
    'justify-content:center;font-size:24px;background:linear-gradient(160deg,#F16529,#E44D26)}' +
    'h1{font-size:18px;margin:0}.sub{margin:2px 0 0;font-size:12px;opacity:.65}' +
    '.foot{text-align:center;font-size:11px;opacity:.5;margin-top:16px}' +
    settingsCss() +
    '</style></head><body><div class="wrap">' +
    '<header><div class="logo">👁</div><div><h1>HTML Live Viewer</h1>' +
    '<p class="sub">미리보기 설정</p></div></header>' +
    '<div class="card">' + settingsRows(v) + '</div>' +
    '<p class="foot">변경 사항은 자동으로 저장됩니다.</p></div>' +
    '<script nonce="' + nonce + '">(function(){' +
    'var api=(typeof acquireVsCodeApi==="function")?acquireVsCodeApi():null;' +
    'function send(k,val){if(api)api.postMessage({type:"update",key:k,value:val});}' +
    settingsControlsScript() +
    '})();</script></body></html>';
}

function loadingShell() {
  return '<!DOCTYPE html><html lang="ko"><head><meta charset="utf-8">' +
    '<style>body{font-family:sans-serif;color:#888;padding:24px}</style></head>' +
    '<body>미리보기 준비 중…</body></html>';
}

function fallbackPage(msg) {
  return '<!DOCTYPE html><html lang="ko"><head><meta charset="utf-8"></head>' +
    '<body style="font-family:sans-serif;padding:24px;color:#888">' + escapeHtml(msg) + '</body></html>';
}

function escapeHtml(s) {
  return String(s).replace(/[&<>"]/g, (c) => (
    { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]
  ));
}

function deactivate() {
  if (server) { try { server.dispose(); } catch (_) { /* noop */ } server = undefined; }
  serverRoot = undefined;
  panel = undefined;
  output = undefined;
  statusBar = undefined;
  settingsPanel = undefined;
}

module.exports = { activate, deactivate, __test: { isHtml, escapeHtml, fallbackPage, iframeShell, settingsShell, rootForDoc } };
