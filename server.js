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
function clientSnippet(forwardConsole, showErrorOverlay, qualityChecks) {
  const lr =
    'try{var es=new EventSource("/__livereload");es.onmessage=function(e){' +
    // CSS만 바뀌면 스타일시트 href만 교체 → 전체 리로드 없이 스크롤/입력/상태 보존
    'if(e.data==="css"){try{var L=document.querySelectorAll("link[rel=stylesheet]");' +
    'for(var i=0;i<L.length;i++){var u=L[i].href.split("?")[0];L[i].href=u+"?hlv="+Date.now();}}catch(_){location.reload();}}' +
    'else{location.reload();}};}catch(e){}' +
    // 전체 리로드 시 스크롤 위치 보존
    'try{var SK="__hlv_sy__";addEventListener("scroll",function(){try{sessionStorage.setItem(SK,String(scrollY))}catch(_){}} ,{passive:true});' +
    'addEventListener("load",function(){try{var y=sessionStorage.getItem(SK);if(y)scrollTo(0,parseFloat(y)||0)}catch(_){}} );}catch(e){}' +
    // 요소 검사 모드 + 부모(셸)에서 온 스크롤 동기화
    'try{var INS=false,olEl=null;' +
    'function hlvClearOl(){if(olEl){try{olEl.style.outline=olEl.__hlvOl||"";}catch(_){}olEl=null;}}' +
    'addEventListener("message",function(e){var d=e.data;if(!d||!d.__hlv)return;' +
    'if(d.__hlv==="scroll"){try{var h=document.documentElement.scrollHeight-innerHeight;scrollTo(0,Math.max(0,h*d.ratio));}catch(_){}}' +
    'else if(d.__hlv==="inspect"){INS=!!d.on;if(!INS)hlvClearOl();}});' +
    'addEventListener("mouseover",function(e){if(!INS)return;hlvClearOl();var t=e.target;if(!t||!t.style)return;olEl=t;t.__hlvOl=t.style.outline;t.style.outline="2px solid #ff5f4d";},true);' +
    'addEventListener("click",function(e){if(!INS)return;e.preventDefault();e.stopPropagation();var t=e.target||{};' +
    'var info={tag:(t.tagName||"").toLowerCase(),id:t.id||"",cls:(typeof t.className==="string"?t.className.trim():"").split(" ")[0]||"",text:((t.textContent||"").trim()).slice(0,40)};' +
    'try{var hlvL=document.getElementsByTagName(info.tag||"*"),hlvN=0;for(var hi=0;hi<hlvL.length;hi++){if(hlvL[hi]===t){hlvN=hi;break;}}info.nth=hlvN;}catch(_){info.nth=0;}' +
    'INS=false;hlvClearOl();' +
    'try{parent.postMessage({__hlv:"pick",info:info},"*")}catch(_){}' +
    'try{parent.postMessage({__hlv:"inspectOff"},"*")}catch(_){}},true);}catch(e){}';

  let hooks = '';
  if (forwardConsole || showErrorOverlay) {
    hooks =
      'var FC=' + (forwardConsole ? '1' : '0') + ',OV=' + (showErrorOverlay ? '1' : '0') + ';' +
      'function str(a){try{return Array.prototype.map.call(a,function(x){' +
      'try{return typeof x==="object"?JSON.stringify(x):String(x);}catch(e){return String(x);}}).join(" ");}catch(e){return "";}}' +
      'function beacon(l,m){try{if(FC)navigator.sendBeacon("/__log",JSON.stringify({level:l,msg:m}));}catch(e){}}' +
      'var EN=0;function bump(){EN++;try{parent.postMessage({__hlv:"errcount",n:EN},"*")}catch(_){}}' +
      'var NL=String.fromCharCode(10);' +
      'function hlvCopy(txt,el,orig){function done(ok){try{el.textContent=ok?"✓":"✗";setTimeout(function(){el.textContent=orig;},900);}catch(_){}}' +
      'function fb(){try{var ta=document.createElement("textarea");ta.value=txt;ta.style.cssText="position:fixed;opacity:0";' +
      '(document.body||document.documentElement).appendChild(ta);ta.select();var k=document.execCommand("copy");ta.remove();done(!!k);}catch(_){done(false);}}' +
      'try{navigator.clipboard.writeText(txt).then(function(){done(true);},function(){fb();});}catch(_){fb();}}' +
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
      'font:12.5px/1.55 -apple-system,BlinkMacSystemFont,Segoe UI,sans-serif;color:#fff;' +
      'background:rgba(16,14,19,0.6);-webkit-backdrop-filter:blur(22px) saturate(1.4);backdrop-filter:blur(22px) saturate(1.4);' +
      'border:1px solid rgba(255,255,255,0.13);border-radius:16px;' +
      'box-shadow:0 18px 50px rgba(0,0,0,0.5)";' +
      'var h=document.createElement("div");h.style.cssText="position:sticky;top:0;display:flex;' +
      'align-items:center;padding:11px 13px 9px;font-weight:600;font-size:12.5px;' +
      'background:rgba(16,14,19,0.9);-webkit-backdrop-filter:blur(8px);backdrop-filter:blur(8px);border-radius:15px 15px 0 0";' +
      'var dt=document.createElement("span");dt.style.cssText="width:8px;height:8px;border-radius:50%;background:#ff5f4d;box-shadow:0 0 10px rgba(255,95,77,.8);margin-right:8px;flex:none";h.appendChild(dt);' +
      'box._t=document.createElement("span");box._t.style.cssText="flex:1";h.appendChild(box._t);' +
      'var ca=document.createElement("span");ca.textContent="⧉";ca.title="전체 복사";ca.style.cssText="cursor:pointer;padding:0 7px;opacity:.6;font-size:13px";' +
      'ca.onclick=function(ev){ev.stopPropagation();hlvCopy(box&&box._msgs?box._msgs.join(NL+NL):"",ca,"⧉");};h.appendChild(ca);' +
      'var x=document.createElement("span");x.textContent="✕";x.style.cssText="cursor:pointer;padding:0 7px;opacity:.6;font-size:13px";' +
      'x.onclick=function(){box.remove();box=null;n=0;EN=0;try{parent.postMessage({__hlv:"errcount",n:0},"*")}catch(_){}};h.appendChild(x);box.appendChild(h);' +
      'box._l=document.createElement("div");box.appendChild(box._l);' +
      'box._seen={};box._order=[];box._msgs=[];(document.body||document.documentElement).appendChild(box);}' +
      'n++;box._t.textContent="문제 "+n+"개";' +
      // 같은 메시지는 ×N 으로 합치기 (무한 누적 방지)
      'var key=type+"|"+m;' +
      'if(box._seen[key]){var it=box._seen[key];it.k++;it.b.textContent="×"+it.k;it.b.style.display="inline-block";return;}' +
      'var r=document.createElement("div");r.style.cssText="padding:11px 14px;border-top:1px solid rgba(255,255,255,.08);position:relative";' +
      'var f=document.createElement("div");f.style.cssText="font-weight:600;color:#f2eff5;line-height:1.55;margin-bottom:6px;padding-right:56px";' +
      'f.textContent=(type==="console"?"코드에서 직접 남긴 오류 메시지예요.":(type==="resource"?"파일(이미지·CSS·JS 등)을 불러오지 못했어요. 경로가 맞는지, 파일이 있는지 확인하세요.":explain(m)));' +
      'var d=document.createElement("div");d.style.cssText="font:11px/1.5 ui-monospace,Menlo,Consolas,monospace;color:#cfc9d6;background:rgba(255,255,255,.06);border:1px solid rgba(255,255,255,.07);border-radius:8px;padding:6px 9px;white-space:pre-wrap;word-break:break-word";d.textContent=m;' +
      'var b=document.createElement("span");b.style.cssText="position:absolute;top:11px;right:36px;font-size:10.5px;background:rgba(255,122,69,.22);color:#ffb46a;border-radius:8px;padding:1px 6px;display:none";' +
      'var cp=document.createElement("span");cp.textContent="⧉";cp.title="이 에러 복사";' +
      'cp.style.cssText="position:absolute;top:9px;right:12px;cursor:pointer;font-size:13px;color:#b9b3c0;opacity:.85";' +
      'cp.addEventListener("click",function(ev){ev.stopPropagation();hlvCopy(f.textContent+NL+m,cp,"⧉");});' +
      'box._msgs.push(f.textContent+NL+m);' +
      'r.appendChild(f);r.appendChild(d);r.appendChild(b);r.appendChild(cp);box._l.appendChild(r);' +
      // 에러 행 클릭 → 부모(웹뷰 셸)로 알려 에디터 소스로 이동
      'if(type!=="console"){r.style.cursor="pointer";r.title="클릭 → 소스로 이동";' +
      'r.addEventListener("click",function(){try{parent.postMessage({__hlv:"open",raw:m},"*");}catch(_){}} );}' +
      'box._seen[key]={k:1,b:b};box._order.push({key:key,r:r});' +
      // 최대 20개 유지 (오래된 것부터 제거)
      'if(box._order.length>20){var old=box._order.shift();old.r.remove();delete box._seen[old.key];box._msgs.shift();}}catch(e){}}' +
      // 후킹
      '["log","info","warn","error"].forEach(function(k){var o=console[k];console[k]=function(){' +
      'var m=str(arguments);beacon(k,m);if(k==="error"){overlay(m,"console");bump();}if(o)o.apply(console,arguments);};});' +
      'window.addEventListener("error",function(e){var m=(e.message||"Error")+(e.filename?" ("+e.filename+":"+(e.lineno||0)+")":"");beacon("error",m);overlay(m,"runtime");bump();});' +
      'window.addEventListener("unhandledrejection",function(e){var m="Unhandled rejection: "+((e.reason&&e.reason.message)||e.reason);beacon("error",m);overlay(m,"runtime");bump();});' +
      // 리소스 로드 실패(이미지/CSS/JS 404 등) — 캡처 단계로 잡는다
      'window.addEventListener("error",function(e){var t=e.target;if(t&&t!==window&&(t.src||t.href)){var u=t.src||t.href;var m="리소스 로드 실패: "+u;beacon("error",m);overlay(m,"resource");bump();}},true);';
  }
  let qc = '';
  if (qualityChecks) {
    qc =
      'addEventListener("load",function(){try{' +
      'function qb(m){try{navigator.sendBeacon("/__log",JSON.stringify({level:"warn",msg:m}))}catch(e){}}' +
      'var im=document.querySelectorAll("img:not([alt])");if(im.length)qb("[품질] alt 없는 이미지 "+im.length+"개");' +
      'var as=document.querySelectorAll("a[href]"),ck=0;' +
      'Array.prototype.forEach.call(as,function(a){if(ck>=50)return;var h=a.getAttribute("href");' +
      'if(!h||/^(https?:|mailto:|tel:|#|javascript:|data:)/i.test(h))return;ck++;' +
      'fetch(h,{method:"HEAD"}).then(function(r){if(!r.ok)qb("[품질] 깨진 링크: "+h+" ("+r.status+")");})' +
      '.catch(function(){qb("[품질] 링크 확인 실패: "+h);});});' +
      '}catch(e){}});';
  }
  return '\n<script data-hlv-client>(function(){' + lr + hooks + qc + '})();</script>';
}

function injectClient(html, forwardConsole, showErrorOverlay, qualityChecks) {
  if (html.indexOf('data-hlv-client') !== -1) return html; // 중복 방지
  const snip = clientSnippet(forwardConsole, showErrorOverlay, qualityChecks);
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
    /** 로드 시 품질 점검(깨진 링크·alt 누락)을 실행할지 */
    this.qualityChecks = false;
    /** 알 수 없는 경로를 index.html로 폴백(SPA) */
    this.spaFallback = false;
    /** @type {null | ((entry: {level: string, msg: string}) => void)} 미리보기 콘솔 로그 수신 훅 */
    this.onClientLog = null;
  }

  start(port, host) {
    this.host = host || '127.0.0.1';
    return new Promise((resolve, reject) => {
      this.server = http.createServer((req, res) => {
        try { this._handle(req, res); }
        catch (e) { try { res.writeHead(500); res.end('Server error'); } catch (_) {} }
      });
      // 고정 포트가 사용 중이면 임의 포트로 폴백
      this.server.on('error', (e) => {
        if (port && e && e.code === 'EADDRINUSE') { try { this.server.listen(0, this.host); } catch (_) { reject(e); } }
        else reject(e);
      });
      this.server.listen(port || 0, this.host, () => {
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

  /** 연결된 모든 미리보기에 신호를 보낸다. kind==='css'면 스타일시트만 교체. */
  notify(kind) {
    const data = kind === 'css' ? 'css' : 'reload';
    for (const c of this.clients) {
      try { c.write('data: ' + data + '\n\n'); } catch (_) {}
    }
  }

  /** 전체 새로고침 (하위 호환). */
  notifyReload() { this.notify('full'); }

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
    if (stat && stat.isDirectory()) {
      const idx = path.join(abs, 'index.html');
      let hasIdx = false;
      try { hasIdx = fs.statSync(idx).isFile(); } catch (_) { /* noop */ }
      if (!hasIdx) return this._listing(res, abs, pathname);
      abs = idx;
    }

    const ext = path.extname(abs).toLowerCase();
    const mime = MIME[ext] || 'application/octet-stream';
    const isHtml = ext === '.html' || ext === '.htm';

    // 열린 에디터 버퍼 우선 (저장하지 않은 변경도 미리보기에 반영)
    let override;
    if (TEXT_EXT.has(ext) && typeof this.readText === 'function') {
      try { override = this.readText(abs); } catch (_) { override = undefined; }
    }

    if (typeof override === 'string') {
      const body = isHtml ? injectClient(override, this.forwardConsole, this.showErrorOverlay, this.qualityChecks) : override;
      res.writeHead(200, { 'Content-Type': mime, 'Cache-Control': 'no-store' });
      res.end(body);
      return;
    }

    const looksLikeRoute = () => {
      try { return !path.extname(pathname) || /text\/html/i.test(req.headers.accept || ''); }
      catch (_) { return false; }
    };
    const notFound = () => {
      // SPA 폴백: 확장자 없는 경로(클라이언트 라우팅)는 index.html로
      if (this.spaFallback && looksLikeRoute()) {
        const idx = path.join(this.root, 'index.html');
        return fs.readFile(idx, (err, data) => {
          if (err) { res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' }); res.end('Not Found: ' + rel); return; }
          const body = injectClient(data.toString('utf8'), this.forwardConsole, this.showErrorOverlay, this.qualityChecks);
          res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store' });
          res.end(body);
        });
      }
      res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' });
      res.end('Not Found: ' + rel);
    };

    // HTML: 전체를 읽어 라이브리로드 스니펫을 주입 (HTML은 작으므로 스트리밍 불필요).
    if (isHtml) {
      fs.readFile(abs, (err, data) => {
        if (err) return notFound();
        const body = injectClient(data.toString('utf8'), this.forwardConsole, this.showErrorOverlay, this.qualityChecks);
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

  /** index.html이 없는 디렉터리의 파일 목록 페이지. */
  _listing(res, absDir, pathname) {
    fs.readdir(absDir, { withFileTypes: true }, (err, ents) => {
      if (err) { res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' }); res.end('Not Found'); return; }
      const esc = (s) => String(s).replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
      const base = pathname.endsWith('/') ? pathname : pathname + '/';
      ents.sort((a, b) => (Number(b.isDirectory()) - Number(a.isDirectory())) || a.name.localeCompare(b.name));
      let items = '';
      if (pathname !== '/') items += '<li><a href="' + esc(base) + '..">&#128193; ..</a></li>';
      for (const e of ents) {
        if (e.name.startsWith('.')) continue;
        const ic = e.isDirectory() ? '&#128193;' : (/\.html?$/i.test(e.name) ? '&#127760;' : '&#128196;');
        items += '<li><a href="' + esc(base + e.name) + '">' + ic + ' ' + esc(e.name) + (e.isDirectory() ? '/' : '') + '</a></li>';
      }
      const html = '<!DOCTYPE html><html lang="ko"><head><meta charset="utf-8"><title>' + esc(pathname) + '</title>' +
        '<style>body{font:14px -apple-system,BlinkMacSystemFont,sans-serif;max-width:640px;margin:40px auto;padding:0 20px;color:#333}' +
        'h1{font-size:16px;color:#E24E22}ul{list-style:none;padding:0}li{padding:8px 0;border-bottom:1px solid #eee}' +
        'a{text-decoration:none;color:#222}a:hover{color:#E24E22}</style></head>' +
        '<body><h1>&#128194; ' + esc(pathname) + '</h1><ul>' + items + '</ul></body></html>';
      res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store' });
      res.end(html);
    });
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
