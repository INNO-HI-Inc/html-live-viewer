'use strict';
// 의존성 없는 정적 파일 서버 + SSE 기반 라이브 리로드.
// 열린 에디터 버퍼(저장 안 한 변경)를 우선 제공할 수 있도록 readText 훅을 둔다.
const http = require('http');
const fs = require('fs');
const path = require('path');

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.htm': 'text/html; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.map': 'application/json; charset=utf-8',
  '.xml': 'application/xml; charset=utf-8',
  '.webmanifest': 'application/manifest+json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.avif': 'image/avif',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.gif': 'image/gif',
  '.webp': 'image/webp',
  '.ico': 'image/x-icon',
  '.woff': 'font/woff',
  '.woff2': 'font/woff2',
  '.ttf': 'font/ttf',
  '.otf': 'font/otf',
  '.txt': 'text/plain; charset=utf-8',
  '.wasm': 'application/wasm',
  '.mp4': 'video/mp4',
  '.webm': 'video/webm',
  '.mp3': 'audio/mpeg'
};

const TEXT_EXT = new Set(['.html', '.htm', '.css', '.js', '.mjs', '.json', '.map', '.svg', '.txt', '.xml', '.webmanifest']);

/**
 * 서빙되는 HTML에 주입할 클라이언트 스크립트:
 *  - 라이브리로드(항상)
 *  - 콘솔/에러를 출력 패널로 전달(forwardConsole)
 *  - 에러 발생 시 화면 하단에 빨간 배너 오버레이(showErrorOverlay)
 */
function clientSnippet(forwardConsole, showErrorOverlay) {
  const lr =
    'try{var es=new EventSource("/__livereload");' +
    'es.onmessage=function(e){if(e.data==="reload"){location.reload();}};}catch(e){}';

  let hooks = '';
  if (forwardConsole || showErrorOverlay) {
    hooks =
      'var FC=' + (forwardConsole ? '1' : '0') + ',OV=' + (showErrorOverlay ? '1' : '0') + ';' +
      'function str(a){try{return Array.prototype.map.call(a,function(x){' +
      'try{return typeof x==="object"?JSON.stringify(x):String(x);}catch(e){return String(x);}}).join(" ");}catch(e){return "";}}' +
      'function beacon(l,m){try{if(FC)navigator.sendBeacon("/__log",JSON.stringify({level:l,msg:m}));}catch(e){}}' +
      // 원문 에러 → 사람이 이해하기 쉬운 설명
      'function explain(m){m=m||"";var x;' +
      'if(/is not defined/.test(m)){x=(m.match(/(\\w+) is not defined/)||[])[1]||"그것";' +
      'return "「"+x+"」(이)라는 것을 찾을 수 없어요. 이름 오타이거나, 만들기 전에 먼저 사용했거나, 필요한 스크립트를 안 불러왔을 수 있어요.";}' +
      'if(/is not a function/.test(m)){x=(m.match(/([\\w.]+) is not a function/)||[])[1]||"그것";' +
      'return "「"+x+"」(은)는 함수가 아니에요. 이름 오타이거나, 함수가 아닌 값을 ()로 호출했을 수 있어요.";}' +
      'if(/Cannot read propert.*of (null|undefined)/i.test(m)){x=(m.match(/reading .(\\w+)/)||[])[1];' +
      'return "값이 비어있는(null/undefined) 대상에서 "+(x?("「"+x+"」을(를) "):"어떤 속성을 ")+"읽으려 했어요. 화면 요소를 아직 못 찾았거나(스크립트가 먼저 실행됨), 데이터가 없을 수 있어요.";}' +
      'if(/Cannot set propert/i.test(m))return "값이 비어있는 대상에 값을 넣으려 했어요. 그 대상이 실제로 있는지 확인하세요.";' +
      'if(/is not iterable/.test(m))return "반복(for..of 등)할 수 없는 값이에요. 배열이 맞는지 데이터 형태를 확인하세요.";' +
      'if(/Unexpected|SyntaxError|Invalid or unexpected|missing/i.test(m))return "문법 오류예요. 괄호 {} () 와 따옴표 짝, 쉼표·세미콜론이 맞는지 확인하세요.";' +
      'if(/Failed to fetch|NetworkError|Load failed|ERR_|CORS/i.test(m))return "네트워크 요청이 실패했어요. 주소가 맞는지, 파일이 있는지, 인터넷 연결을 확인하세요.";' +
      'if(/Unhandled rejection/i.test(m))return "처리하지 않은 Promise 오류예요. .catch() 를 붙이거나 try/catch 로 감싸 주세요.";' +
      'return "자바스크립트 실행 중 문제가 생겼어요. 아래 원문 메시지를 참고하세요.";}' +
      // 화면 오버레이
      'var box,n=0;' +
      'function overlay(m,type){if(!OV)return;try{' +
      'if(!box){box=document.createElement("div");box.setAttribute("data-hlv-err","");' +
      'box.style.cssText="position:fixed;right:14px;bottom:14px;z-index:2147483647;width:auto;' +
      'max-width:min(380px,calc(100vw - 28px));max-height:46vh;overflow:auto;' +
      'font:13px/1.5 -apple-system,BlinkMacSystemFont,Segoe UI,sans-serif;color:#fff;' +
      'background:rgba(28,24,30,0.34);-webkit-backdrop-filter:blur(18px) saturate(1.5);backdrop-filter:blur(18px) saturate(1.5);' +
      'border:1px solid rgba(255,255,255,0.28);border-radius:14px;' +
      'box-shadow:0 12px 40px rgba(0,0,0,0.35)";' +
      'var h=document.createElement("div");h.style.cssText="position:sticky;top:0;display:flex;' +
      'justify-content:space-between;align-items:center;padding:9px 12px;font-weight:700;' +
      'background:rgba(255,90,77,0.16);-webkit-backdrop-filter:blur(6px);backdrop-filter:blur(6px);border-radius:12px 12px 0 0";' +
      'box._t=document.createElement("span");h.appendChild(box._t);' +
      'var x=document.createElement("span");x.textContent="✕";x.style.cssText="cursor:pointer;padding:0 6px";' +
      'x.onclick=function(){box.remove();box=null;n=0;};h.appendChild(x);box.appendChild(h);' +
      'box._l=document.createElement("div");box.appendChild(box._l);' +
      'box._seen={};box._order=[];(document.body||document.documentElement).appendChild(box);}' +
      'n++;box._t.textContent="⚠️ 문제가 "+n+"개 있어요";' +
      // 같은 메시지는 ×N 으로 합치기 (무한 누적 방지)
      'var key=type+"|"+m;' +
      'if(box._seen[key]){var it=box._seen[key];it.k++;it.b.textContent="×"+it.k;it.b.style.display="inline-block";return;}' +
      'var r=document.createElement("div");r.style.cssText="padding:10px 12px;border-top:1px solid rgba(255,255,255,.18);position:relative";' +
      'var f=document.createElement("div");f.style.cssText="font-weight:600;margin-bottom:4px;padding-right:30px";' +
      'f.textContent=(type==="console"?"코드에서 직접 남긴 오류 메시지예요.":explain(m));' +
      'var d=document.createElement("div");d.style.cssText="font:11px/1.45 ui-monospace,Menlo,Consolas,monospace;opacity:.8;white-space:pre-wrap;word-break:break-word";d.textContent=m;' +
      'var b=document.createElement("span");b.style.cssText="position:absolute;top:9px;right:10px;font-size:11px;background:rgba(255,255,255,.22);border-radius:8px;padding:1px 6px;display:none";' +
      'r.appendChild(f);r.appendChild(d);r.appendChild(b);box._l.appendChild(r);' +
      'box._seen[key]={k:1,b:b};box._order.push({key:key,r:r});' +
      // 최대 20개 유지 (오래된 것부터 제거)
      'if(box._order.length>20){var old=box._order.shift();old.r.remove();delete box._seen[old.key];}}catch(e){}}' +
      // 후킹
      '["log","info","warn","error"].forEach(function(k){var o=console[k];console[k]=function(){' +
      'var m=str(arguments);beacon(k,m);if(k==="error")overlay(m,"console");if(o)o.apply(console,arguments);};});' +
      'window.addEventListener("error",function(e){var m=(e.message||"Error")+(e.filename?" ("+e.filename+":"+(e.lineno||0)+")":"");beacon("error",m);overlay(m,"runtime");});' +
      'window.addEventListener("unhandledrejection",function(e){var m="Unhandled rejection: "+((e.reason&&e.reason.message)||e.reason);beacon("error",m);overlay(m,"runtime");});';
  }
  return '\n<script data-hlv-client>(function(){' + lr + hooks + '})();</script>';
}

function injectClient(html, forwardConsole, showErrorOverlay) {
  if (html.indexOf('data-hlv-client') !== -1) return html; // 중복 방지
  const snip = clientSnippet(forwardConsole, showErrorOverlay);
  if (/<\/body>/i.test(html)) return html.replace(/<\/body>/i, snip + '</body>');
  return html + snip;
}

class PreviewServer {
  constructor(root) {
    this.root = path.resolve(root);
    this.clients = new Set();
    this.server = null;
    this.port = 0;
    /** @type {null | ((absPath: string) => (string | undefined))} 열린 버퍼 우선 제공 훅 */
    this.readText = null;
    /** 서빙 HTML에 콘솔 전달 스크립트를 주입할지 */
    this.forwardConsole = true;
    /** 에러 발생 시 화면 하단에 배너 오버레이를 띄울지 */
    this.showErrorOverlay = true;
    /** @type {null | ((entry: {level: string, msg: string}) => void)} 미리보기 콘솔 로그 수신 훅 */
    this.onClientLog = null;
  }

  start() {
    return new Promise((resolve, reject) => {
      this.server = http.createServer((req, res) => {
        try { this._handle(req, res); }
        catch (e) { try { res.writeHead(500); res.end('Server error'); } catch (_) {} }
      });
      this.server.on('error', reject);
      this.server.listen(0, '127.0.0.1', () => {
        this.port = this.server.address().port;
        resolve(this.port);
      });
    });
  }

  dispose() {
    for (const c of this.clients) { try { c.end(); } catch (_) {} }
    this.clients.clear();
    if (this.server) { try { this.server.close(); } catch (_) {} this.server = null; }
  }

  /** 연결된 모든 미리보기에 새로고침 신호를 보낸다. */
  notifyReload() {
    for (const c of this.clients) {
      try { c.write('data: reload\n\n'); } catch (_) {}
    }
  }

  _handle(req, res) {
    let pathname;
    try { pathname = decodeURIComponent(new URL(req.url, 'http://localhost').pathname); }
    catch (_) { pathname = (req.url || '/').split('?')[0]; }

    if (pathname === '/__livereload') return this._sse(req, res);
    if (pathname === '/__log') return this._log(req, res);

    // 경로 해석 + 디렉터리 트래버설 방지
    const rel = pathname.replace(/^\/+/, '');
    let abs = path.resolve(this.root, rel);
    if (abs !== this.root && !abs.startsWith(this.root + path.sep)) {
      res.writeHead(403, { 'Content-Type': 'text/plain; charset=utf-8' });
      res.end('Forbidden');
      return;
    }

    let stat = null;
    try { stat = fs.statSync(abs); } catch (_) { stat = null; }
    if (stat && stat.isDirectory()) abs = path.join(abs, 'index.html');

    const ext = path.extname(abs).toLowerCase();
    const mime = MIME[ext] || 'application/octet-stream';
    const isHtml = ext === '.html' || ext === '.htm';

    // 열린 에디터 버퍼 우선 (저장하지 않은 변경도 미리보기에 반영)
    let override;
    if (TEXT_EXT.has(ext) && typeof this.readText === 'function') {
      try { override = this.readText(abs); } catch (_) { override = undefined; }
    }

    if (typeof override === 'string') {
      const body = isHtml ? injectClient(override, this.forwardConsole, this.showErrorOverlay) : override;
      res.writeHead(200, { 'Content-Type': mime, 'Cache-Control': 'no-store' });
      res.end(body);
      return;
    }

    const notFound = () => {
      res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' });
      res.end('Not Found: ' + rel);
    };

    // HTML: 전체를 읽어 라이브리로드 스니펫을 주입 (HTML은 작으므로 스트리밍 불필요).
    if (isHtml) {
      fs.readFile(abs, (err, data) => {
        if (err) return notFound();
        const body = injectClient(data.toString('utf8'), this.forwardConsole, this.showErrorOverlay);
        res.writeHead(200, { 'Content-Type': mime, 'Cache-Control': 'no-store' });
        res.end(body);
      });
      return;
    }

    // 그 외(이미지·폰트·미디어 등): 스트리밍 + HTTP Range 지원(비디오/오디오 탐색).
    fs.stat(abs, (err, st) => {
      if (err || !st.isFile()) return notFound();
      const total = st.size;
      const range = req.headers.range;
      let start = 0, end = total - 1, status = 200;
      if (range) {
        const m = /bytes=(\d*)-(\d*)/.exec(range);
        if (m) {
          if (m[1]) start = parseInt(m[1], 10);
          if (m[2]) end = parseInt(m[2], 10);
          if (isNaN(start)) start = 0;
          if (isNaN(end) || end >= total) end = total - 1;
          if (start > end || start >= total) {
            res.writeHead(416, { 'Content-Range': 'bytes */' + total }); res.end(); return;
          }
          status = 206;
        }
      }
      const headers = {
        'Content-Type': mime,
        'Cache-Control': 'no-store',
        'Accept-Ranges': 'bytes',
        'Content-Length': (end - start + 1)
      };
      if (status === 206) headers['Content-Range'] = 'bytes ' + start + '-' + end + '/' + total;
      res.writeHead(status, headers);
      if (req.method === 'HEAD') { res.end(); return; }
      const stream = fs.createReadStream(abs, { start, end });
      stream.on('error', () => { try { res.end(); } catch (_) { /* noop */ } });
      stream.pipe(res);
    });
  }

  _log(req, res) {
    if (req.method !== 'POST') { res.writeHead(405); res.end(); return; }
    let body = '';
    req.on('data', (c) => { body += c; if (body.length > 1e6) req.destroy(); });
    req.on('end', () => {
      let entry = null;
      try { entry = JSON.parse(body); } catch (_) { entry = null; }
      if (entry && typeof this.onClientLog === 'function') {
        try { this.onClientLog(entry); } catch (_) { /* noop */ }
      }
      res.writeHead(204); res.end();
    });
    req.on('error', () => { try { res.writeHead(400); res.end(); } catch (_) { /* noop */ } });
  }

  _sse(req, res) {
    res.writeHead(200, {
      'Content-Type': 'text/event-stream',
      'Cache-Control': 'no-cache',
      'Connection': 'keep-alive'
    });
    res.write(': connected\n\n');
    this.clients.add(res);
    req.on('close', () => { this.clients.delete(res); });
  }
}

module.exports = { PreviewServer, injectClient, clientSnippet, MIME, TEXT_EXT };
