// @ts-check
const vscode = require('vscode');
const path = require('path');
const os = require('os');
const qr = require('./qr');
const { PreviewServer } = require('./server');
const shell = require('./shell');

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
/** @type {import('vscode').WebviewPanel | undefined} QR 패널 */
let qrPanel;
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
    spaFallback: cfg.get('spaFallback', false),
    allowNetworkPreview: cfg.get('allowNetworkPreview', false),
    syncScroll: cfg.get('syncScroll', false),
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

/** 요소 검사 결과(태그/id/클래스/텍스트)로 소스에서 가장 그럴듯한 줄을 찾아 이동. */
function jumpToPick(info) {
  try {
    if (!panel || !panel.sourceDoc || !info) return;
    const doc = panel.sourceDoc;
    const lines = String(doc.getText()).split(/\r?\n/);
    const findLine = (pred) => { for (let i = 0; i < lines.length; i++) if (pred(lines[i])) return i; return -1; };
    let line = -1;
    if (info.id) line = findLine((l) => l.includes('id="' + info.id + '"') || l.includes("id='" + info.id + "'"));
    if (line < 0 && info.tag && typeof info.nth === 'number' && info.nth >= 0) {
      // 같은 태그 중 몇 번째인지(DOM 순서)로 소스 줄을 센다 — 반복 요소에 정확
      try {
        const safeTag = String(info.tag).replace(/[^a-z0-9-]/gi, '');
        if (safeTag) {
          const re = new RegExp('<' + safeTag + '(?=[\\s>/])', 'gi');
          let count = 0;
          for (let i = 0; i < lines.length && line < 0; i++) {
            const mm = lines[i].match(re);
            if (mm) { if (count + mm.length > info.nth) line = i; count += mm.length; }
          }
        }
      } catch (_) { /* noop */ }
    }
    if (line < 0 && info.cls) line = findLine((l) => l.includes('<' + info.tag) && l.includes(info.cls));
    if (line < 0 && info.text) { const t = info.text.slice(0, 24); if (t.length >= 3) line = findLine((l) => l.includes(t)); }
    if (line < 0 && info.tag) line = findLine((l) => l.includes('<' + info.tag));
    if (line < 0) return;
    const pos = new vscode.Position(line, 0);
    vscode.window.showTextDocument(doc, { selection: new vscode.Range(pos, pos), preview: false });
  } catch (e) { dbg('pick error: ' + e); }
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

let serverStarting = null; // 동시 호출 경합 방지

/** 루트에 맞는 서버를 보장(있으면 재사용, 루트가 바뀌면 재시작). */
async function ensureServer(root) {
  if (server && serverRoot === root) return server;
  if (serverStarting) { try { await serverStarting; } catch (_) { /* noop */ } if (server && serverRoot === root) return server; }
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
    const ts = new Date().toTimeString().slice(0, 8);
    try { consoleChannel.appendLine('[' + ts + '] [' + level + '] ' + String(entry.msg == null ? '' : entry.msg)); }
    catch (_) { /* noop */ }
  };
  const allowNet = getConfig().get('allowNetworkPreview', false);
  serverStarting = s.start(getConfig().get('port', 0), allowNet ? '0.0.0.0' : '127.0.0.1');
  try { await serverStarting; } finally { serverStarting = null; }
  server = s;
  serverRoot = root;
  dbg('server started root=' + root + ' host=' + s.host + ' port=' + s.port);
  return s;
}

/** 첫 번째 로컬 네트워크 IPv4 주소. */
function lanIp() {
  try {
    const ifs = os.networkInterfaces();
    for (const k of Object.keys(ifs)) {
      for (const it of ifs[k] || []) {
        if (it && it.family === 'IPv4' && !it.internal) return it.address;
      }
    }
  } catch (_) { /* noop */ }
  return null;
}

/** QR 패널: 같은 Wi-Fi 기기에서 미리보기를 열 수 있는 주소를 보여준다. */
async function showQrPanel(context) {
  if (!panel || !server) {
    vscode.window.showInformationMessage('HTML Live Viewer: 먼저 미리보기를 여세요.');
    return;
  }
  const cfg = getConfig();
  if (!cfg.get('allowNetworkPreview', false)) {
    const pick = await vscode.window.showWarningMessage(
      '휴대폰에서 보려면 미리보기 서버를 같은 네트워크에 공개해야 합니다. 같은 Wi-Fi의 기기가 워크스페이스 파일에 접근할 수 있게 됩니다. 공개할까요?',
      '공개하고 QR 표시', '취소'
    );
    if (pick !== '공개하고 QR 표시') return;
    try { await cfg.update('allowNetworkPreview', true, vscode.ConfigurationTarget.Global); } catch (_) { /* noop */ }
    if (server) { server.dispose(); server = undefined; serverRoot = undefined; }
    if (panel) await panel.render();
    if (!server) return;
  }
  const ip = lanIp();
  let pathname = '/';
  try { pathname = new URL(panel._url).pathname || '/'; } catch (_) { /* noop */ }
  const url = 'http://' + (ip || '127.0.0.1') + ':' + server.port + pathname;
  let svg = '';
  try { svg = qr.toSvg(qr.encode(url)); } catch (e) { dbg('qr error: ' + e); }
  const html = shell.qrShell(svg, url, ip ? '' : '네트워크 IP를 찾지 못해 로컬 주소만 표시합니다.');
  if (qrPanel) {
    try { qrPanel.webview.html = html; qrPanel.reveal(vscode.ViewColumn.Beside, true); return; }
    catch (_) { qrPanel = undefined; }
  }
  qrPanel = vscode.window.createWebviewPanel('htmlViewer.qr', '휴대폰으로 보기', vscode.ViewColumn.Beside, {});
  qrPanel.webview.html = html;
  qrPanel.onDidDispose(guard(() => { qrPanel = undefined; }), null, context.subscriptions);
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
    const errs = (panel && panel._errs) | 0;
    statusBar.text = '$(open-preview) 미리보기 :' + server.port + (errs > 0 ? '  $(warning) ' + errs : '');
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
    vscode.commands.registerCommand('htmlViewer.openSettings', () => openSettings(context)),
    vscode.commands.registerCommand('htmlViewer.showQr', () => showQrPanel(context))
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
      if (panel._pinned) return; // 핀 고정 중에는 따라가지 않음
      if (!getConfig().get('followActiveEditor', true)) return;
      if (editor && isHtml(editor.document)) panel.setSource(editor.document);
    }))
  );

  // 입력 중 자동 새로고침 (onType) — 저장 안 해도 라이브로 반영.
  context.subscriptions.push(
    vscode.workspace.onDidChangeTextDocument(guard((e) => {
      if (!panel || !server) return;
      if (panel._paused) return;
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
      if (panel._paused) return;
      if (getConfig().get('autoRefresh', 'onType') === 'off') return;
      reloadNow(doc && isCssFile(doc.fileName) ? 'css' : 'full');
    }))
  );

  // 에디터 스크롤 → 미리보기 동기화 (syncScroll 켰을 때, 비율 기반)
  context.subscriptions.push(
    vscode.window.onDidChangeTextEditorVisibleRanges(guard((e) => {
      if (!panel || !getConfig().get('syncScroll', false)) return;
      if (!e || !e.textEditor || !panel.sourceDoc) return;
      if (e.textEditor.document.uri.toString() !== panel.sourceDoc.uri.toString()) return;
      const ranges = e.visibleRanges;
      if (!ranges || !ranges.length) return;
      const total = Math.max(1, (e.textEditor.document.lineCount || 1) - 1);
      const ratio = Math.min(1, ranges[0].start.line / total);
      try { panel.webviewPanel.webview.postMessage({ type: 'scrollTo', ratio }); } catch (_) { /* noop */ }
    }))
  );

    // 설정이 바뀌면 실행 중인 서버에 즉시 반영하고 다시 그린다.
  context.subscriptions.push(
    vscode.workspace.onDidChangeConfiguration(guard((e) => {
      if (e && e.affectsConfiguration && !e.affectsConfiguration('htmlViewer')) return;
      if (e && e.affectsConfiguration &&
          (e.affectsConfiguration('htmlViewer.allowNetworkPreview') || e.affectsConfiguration('htmlViewer.port'))) {
        if (server) { server.dispose(); server = undefined; serverRoot = undefined; }
        if (panel) panel.render();
        return;
      }
      if (!server) return;
      const cfg = getConfig();
      server.forwardConsole = cfg.get('forwardConsole', true);
      server.showErrorOverlay = cfg.get('showErrorOverlay', true);
      server.qualityChecks = cfg.get('qualityChecks', false);
      server.spaFallback = cfg.get('spaFallback', false);
      scheduleReload(200, 'full');
    }))
  );

  // 디스크 변경 감시 (에디터에 안 열린 파일·외부 도구 변경까지 반영).
  // 서버 루트 밖이거나 흔한 산출물/의존성 디렉터리 변경은 무시해 불필요한 리로드를 막는다.
  try {
    const watcher = vscode.workspace.createFileSystemWatcher('**/*');
    const onFs = guard((uri) => {
      if (!panel || !server) return;
      if (panel._paused) return;
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
    try { this.webviewPanel.webview.html = shell.loadingShell(); } catch (_) { /* noop */ }

    // 미리보기에서 온 메시지: 설정 변경 / 에러 소스 점프.
    this.webviewPanel.webview.onDidReceiveMessage(
      guard((m) => {
        if (m && m.type === 'openSource') { openSourceFromPreview(m.raw); return; }
        if (m && m.type === 'pick') { jumpToPick(m.info); return; }
        if (m && m.type === 'pin') { this._pinned = !!m.on; return; }
        if (m && m.type === 'pause') {
          const was = this._paused;
          this._paused = !!m.on;
          if (was && !this._paused) reloadNow('full'); // 정지 중 밀린 변경 반영
          return;
        }
        if (m && m.type === 'errcount') { this._errs = m.n | 0; updateStatusBar(); return; }
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
    // 툴바가 새로 그려지므로 세션 토글 상태도 함께 초기화 (UI와 상태 일치)
    this._pinned = false;
    this._paused = false;
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
    try { this.webviewPanel.webview.html = shell.iframeShell(this._url, currentSettings()); }
    catch (e) { dbg('shell set error: ' + e); }
    updateStatusBar();
  }

  /** 파일이 아닌 문서(untitled 등)를 위한 폴백: 내용을 그대로 웹뷰에 표시. */
  _setDirect(doc) {
    this._url = undefined;
    let html;
    try { html = doc.getText(); }
    catch (e) { dbg('getText failed: ' + e); html = shell.fallbackPage('미리볼 내용을 읽을 수 없습니다.'); }
    if (typeof html !== 'string') html = shell.fallbackPage('미리볼 내용이 없습니다.');
    try { this.webviewPanel.webview.html = html; }
    catch (e) { dbg('direct set error: ' + e); }
    updateStatusBar();
  }
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
  try { p.webview.html = shell.settingsShell(currentSettings(), shell.getNonce()); }
  catch (e) { dbg('settings html error: ' + e); }
  p.webview.onDidReceiveMessage(guard((m) => applySettingMessage(m)), null, context.subscriptions);
  p.onDidDispose(guard(() => { settingsPanel = undefined; }), null, context.subscriptions);
}

function deactivate() {
  if (server) { try { server.dispose(); } catch (_) { /* noop */ } server = undefined; }
  serverRoot = undefined;
  panel = undefined;
  output = undefined;
  statusBar = undefined;
  settingsPanel = undefined;
}

module.exports = {
  activate, deactivate,
  __test: {
    isHtml, rootForDoc,
    escapeHtml: shell.escapeHtml,
    fallbackPage: shell.fallbackPage,
    iframeShell: shell.iframeShell,
    settingsShell: shell.settingsShell
  }
};
