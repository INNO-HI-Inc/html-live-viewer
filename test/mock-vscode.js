// 최소한의 vscode API 목(mock). 단위 테스트에서 extension.js를 실제 실행하기 위한 것.
'use strict';

function makeDisposable() { return { dispose() {} }; }

const state = {};
function reset() {
  state.activeTextEditor = undefined;
  state.visibleTextEditors = [];
  state.workspaceFolders = undefined;
  state.workspaceFolderRoot = undefined; // getWorkspaceFolder 가 반환할 루트 경로
  state.textDocuments = [];
  state.config = {};                 // 예: { 'htmlViewer.autoOpenOnHtml': false }
  state.findFilesResult = [];
  state.openTextDocumentResult = null;
  state.openTextDocumentError = null;
  state.openedUri = undefined;
  state.shownDoc = undefined;
  state.panels = [];
  state.infoMessages = [];
  state.openedExternal = [];
  state.clipboard = undefined;
  state.outputs = {};                // { 채널이름: [줄, ...] }
  state.configUpdates = [];          // config.update 호출 기록
  state.contextSet = {};
  state.commands = {};
  state.onActiveEditor = [];
  state.onChangeDoc = [];
  state.onSaveDoc = [];
}
reset();

function makeWebview() {
  return {
    _html: '',
    _htmlSetCount: 0,
    cspSource: 'vscode-webview://mock',
    options: {},
    set html(v) { this._html = v; this._htmlSetCount++; },
    get html() { return this._html; },
    asWebviewUri(uri) {
      const p = (uri && uri.fsPath) || '';
      return { toString() { return 'vscode-webview://mock' + p; } };
    },
    _msgHandlers: [],
    onDidReceiveMessage(fn) { this._msgHandlers.push(fn); return makeDisposable(); },
    _posted: [],
    postMessage(m) { this._posted.push(m); return Promise.resolve(true); },
    __fireMessage(msg) { this._msgHandlers.slice().forEach((h) => h(msg)); }
  };
}

function createWebviewPanel(viewType, title, showOptions, options) {
  const p = {
    viewType,
    title,
    options,
    active: true,
    webview: makeWebview(),
    _disposeHandlers: [],
    reveal() {},
    onDidChangeViewState() { return makeDisposable(); },
    onDidDispose(fn) { this._disposeHandlers.push(fn); return makeDisposable(); },
    dispose() { this._disposeHandlers.forEach((h) => h()); }
  };
  state.panels.push(p);
  return p;
}

const vscode = {
  ViewColumn: { Active: -1, Beside: -2, One: 1, Two: 2, Three: 3 },
  StatusBarAlignment: { Left: 1, Right: 2 },
  ConfigurationTarget: { Global: 1, Workspace: 2, WorkspaceFolder: 3 },
  Position: class { constructor(line, character) { this.line = line; this.character = character; } },
  Range: class { constructor(start, end) { this.start = start; this.end = end; } },
  Selection: class { constructor(start, end) { this.start = start; this.end = end; } },
  Uri: {
    file(p) { return { scheme: 'file', fsPath: p, toString() { return 'file://' + p; } }; },
    parse(s) { return { scheme: String(s).split(':')[0], fsPath: s, toString() { return s; } }; }
  },
  env: {
    asExternalUri(uri) { return Promise.resolve(uri); },
    openExternal(uri) { state.openedExternal.push(uri); return Promise.resolve(true); },
    clipboard: { writeText(t) { state.clipboard = t; return Promise.resolve(); } }
  },
  commands: {
    registerCommand(name, fn) { state.commands[name] = fn; return makeDisposable(); },
    executeCommand(name, key, val) {
      if (name === 'setContext') state.contextSet[key] = val;
      return Promise.resolve();
    }
  },
  window: {
    get activeTextEditor() { return state.activeTextEditor; },
    get visibleTextEditors() { return state.visibleTextEditors; },
    onDidChangeActiveTextEditor(fn) { state.onActiveEditor.push(fn); return makeDisposable(); },
    onDidChangeTextEditorVisibleRanges(fn) { (state.onVisRange = state.onVisRange || []).push(fn); return makeDisposable(); },
    createWebviewPanel,
    createOutputChannel(name) {
      state.outputs[name] = state.outputs[name] || [];
      const lines = state.outputs[name];
      return {
        name,
        appendLine(l) { lines.push(String(l)); },
        append(l) { lines.push(String(l)); },
        show() {}, clear() { lines.length = 0; }, dispose() {}
      };
    },
    createStatusBarItem() {
      return { text: '', tooltip: '', command: '', show() {}, hide() {}, dispose() {} };
    },
    showInformationMessage(msg) { state.infoMessages.push(msg); return Promise.resolve(); },
    showWarningMessage(msg) { (state.warnMessages = state.warnMessages || []).push(msg); return Promise.resolve(undefined); },
    showTextDocument(doc, opts) { state.shownDoc = { doc, opts }; return Promise.resolve({}); }
  },
  workspace: {
    getConfiguration(section) {
      return {
        get(key, def) {
          const k = section + '.' + key;
          return Object.prototype.hasOwnProperty.call(state.config, k) ? state.config[k] : def;
        },
        update(key, value) {
          const k = section + '.' + key;
          state.config[k] = value;
          state.configUpdates.push({ key: k, value });
          return Promise.resolve();
        }
      };
    },
    get workspaceFolders() { return state.workspaceFolders; },
    get textDocuments() { return state.textDocuments; },
    getWorkspaceFolder(uri) {
      const root = state.workspaceFolderRoot;
      if (!root || !uri || !uri.fsPath) return undefined;
      if (uri.fsPath === root || uri.fsPath.indexOf(root + '/') === 0) {
        return { uri: vscode.Uri.file(root) };
      }
      return undefined;
    },
    onDidChangeTextDocument(fn) { state.onChangeDoc.push(fn); return makeDisposable(); },
    onDidSaveTextDocument(fn) { state.onSaveDoc.push(fn); return makeDisposable(); },
    onDidChangeConfiguration(fn) { (state.onCfg = state.onCfg || []).push(fn); return makeDisposable(); },
    createFileSystemWatcher() {
      return {
        onDidChange() { return makeDisposable(); },
        onDidCreate() { return makeDisposable(); },
        onDidDelete() { return makeDisposable(); },
        dispose() {}
      };
    },
    findFiles() { return Promise.resolve(state.findFilesResult); },
    openTextDocument(uri) {
      state.openedUri = uri;
      if (state.openTextDocumentError) return Promise.reject(state.openTextDocumentError);
      return Promise.resolve(state.openTextDocumentResult);
    }
  },

  // 테스트 헬퍼
  __state: state,
  __reset: reset,
  __runCommand(name, ...args) { return state.commands[name] ? state.commands[name](...args) : undefined; },
  __fireActiveEditor(ed) { state.onActiveEditor.slice().forEach((h) => h(ed)); },
  __fireVisibleRanges(e) { (state.onVisRange || []).slice().forEach((h) => h(e)); },
  __fireChangeDoc(e) { state.onChangeDoc.slice().forEach((h) => h(e)); },
  __fireSaveDoc(d) { state.onSaveDoc.slice().forEach((h) => h(d)); }
};

module.exports = vscode;
