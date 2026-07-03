'use strict';
// 웹뷰 셸(미리보기 툴바/설정 UI) HTML 생성 모듈.
// extension.js에서 분리 — UI만 여기서 관리한다.

function getNonce() {
  let t = '';
  const chars = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789';
  for (let i = 0; i < 24; i++) t += chars.charAt(Math.floor(Math.random() * chars.length));
  return t;
}

function escapeHtml(s) {
  return String(s).replace(/[&<>"]/g, (c) => (
    { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]
  ));
}

/** 오류 상황에서 보여줄 최소 페이지. */
function fallbackPage(msg) {
  return '<!DOCTYPE html><html lang="ko"><head><meta charset="utf-8"></head>' +
    '<body style="font-family:sans-serif;padding:24px;color:#888">' + escapeHtml(msg) + '</body></html>';
}

/** 로딩 셸: 스피너. */
function loadingShell() {
  return '<!DOCTYPE html><html lang="ko"><head><meta charset="utf-8"><style>' +
    'body{margin:0;height:100vh;display:flex;align-items:center;justify-content:center;' +
    'background:var(--vscode-editor-background,#1e1e1e)}' +
    '.sp{width:26px;height:26px;border-radius:50%;border:3px solid rgba(128,128,128,.25);' +
    'border-top-color:var(--vscode-progressBar-background,#e66c3a);animation:r .8s linear infinite}' +
    '@keyframes r{to{transform:rotate(360deg)}}' +
    '</style></head><body><div class="sp"></div></body></html>';
}

/** 툴바용 인라인 SVG 아이콘. */
function icon(name) {
  const P = {
    rotate: '<path d="M13.2 8a5.2 5.2 0 1 1-1.5-3.7"/><path d="M13.2 1.9v2.8h-2.8"/>',
    phone: '<rect x="4.75" y="1.75" width="6.5" height="12.5" rx="1.7"/><path d="M7.1 12.3h1.8"/>',
    reload: '<path d="M2.8 8a5.2 5.2 0 1 0 1.5-3.7"/><path d="M2.8 1.9v2.8h2.8"/>',
    bg: '<circle cx="8" cy="8" r="5.4"/><path d="M8 2.6v10.8A5.4 5.4 0 0 0 8 2.6Z" fill="currentColor" stroke="none"/>',
    grid: '<path d="M2.5 5.6h11M2.5 10.4h11M5.6 2.5v11M10.4 2.5v11"/>',
    sliders: '<path d="M2.5 4.6h5.4M11.6 4.6h1.9M2.5 11.4h2M8.6 11.4h4.9"/><circle cx="9.5" cy="4.6" r="1.6"/><circle cx="6.5" cy="11.4" r="1.6"/>',
    target: '<circle cx="8" cy="8" r="5"/><circle cx="8" cy="8" r="1.4" fill="currentColor" stroke="none"/><path d="M8 1.2v2.2M8 12.6v2.2M1.2 8h2.2M12.6 8h2.2"/>',
    pin: '<path d="M6.2 1.8h3.6M7 1.8v4L4.4 8.5h7.2L9 5.8v-4M8 8.5V14"/>',
    pause: '<path d="M5.6 3.6v8.8M10.4 3.6v8.8"/>'
  };
  return '<svg width="14" height="14" viewBox="0 0 16 16" fill="none" stroke="currentColor" ' +
    'stroke-width="1.4" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">' + (P[name] || '') + '</svg>';
}

/** 설정 컨트롤 공통 CSS (설정 패널 + 미리보기 드로어 공유). */
function settingsCss() {
  return '.card{background:var(--vscode-editorWidget-background,#252526);' +
    'border:1px solid var(--vscode-panel-border,#333);border-radius:12px;padding:4px 16px 10px}' +
    '.gl{font-size:10.5px;font-weight:700;letter-spacing:.6px;text-transform:uppercase;opacity:.48;padding:15px 0 3px}' +
    '.row{display:flex;align-items:center;justify-content:space-between;gap:16px;' +
    'padding:11px 0;border-bottom:1px solid var(--vscode-panel-border,rgba(128,128,128,.16))}' +
    '.row:last-child{border-bottom:0}.meta{min-width:0}' +
    '.name{font-weight:600;font-size:12.5px}.desc{font-size:11.5px;opacity:.6;margin-top:2px}' +
    '.switch{position:relative;display:inline-block;width:38px;height:21px;flex:none}' +
    '.switch input{opacity:0;width:0;height:0}' +
    '.slider{position:absolute;inset:0;background:rgba(128,128,128,.55);border-radius:22px;transition:.18s;cursor:pointer}' +
    '.slider:before{content:"";position:absolute;height:15px;width:15px;left:3px;top:3px;background:#fff;border-radius:50%;transition:.18s}' +
    '.switch input:checked+.slider{background:var(--vscode-button-background,#0e639c)}' +
    '.switch input:checked+.slider:before{transform:translateX(17px)}' +
    '.seg{display:inline-flex;border:1px solid var(--vscode-panel-border,#3a3a3a);border-radius:7px;overflow:hidden;flex:none}' +
    '.seg button{border:0;background:transparent;color:var(--vscode-foreground,#ccc);padding:5px 11px;font-size:11.5px;cursor:pointer}' +
    '.seg button.active{background:var(--vscode-button-background,#0e639c);color:var(--vscode-button-foreground,#fff)}' +
    '.num{display:flex;align-items:center;gap:9px;flex:none}' +
    '.num input[type=range]{accent-color:var(--vscode-button-background,#0e639c);width:120px}' +
    '.num .val{font:11px ui-monospace,Menlo,monospace;opacity:.8;min-width:50px;text-align:right}';
}

/** 설정 행 마크업 (값 v로 초기 상태 표시). */
function settingsRows(v) {
  v = v || {};
  const chk = (b) => (b ? ' checked' : '');
  const act = (a, b) => (a === b ? ' class="active"' : '');
  const row = (name, desc, control) =>
    '<div class="row"><div class="meta"><div class="name">' + name + '</div>' +
    '<div class="desc">' + desc + '</div></div>' + control + '</div>';
  const gl = (t) => '<div class="gl">' + t + '</div>';
  const toggle = (key, val) =>
    '<label class="switch"><input type="checkbox" data-key="' + key + '"' + chk(val) + '><span class="slider"></span></label>';
  const ar = v.autoRefresh || 'onType';
  const delay = Number(v.refreshDelay) || 0;
  return gl('자동 열기') +
    row('HTML 파일 열면 자동 미리보기', 'HTML 파일을 열면 미리보기를 자동으로 엽니다.', toggle('autoOpenOnHtml', v.autoOpenOnHtml)) +
    row('폴더 열면 자동 미리보기', 'index.html(우선)을 찾아 자동으로 엽니다.', toggle('autoOpenOnFolder', v.autoOpenOnFolder)) +
    row('활성 에디터 따라가기', '다른 HTML로 포커스를 옮기면 대상도 전환됩니다.', toggle('followActiveEditor', v.followActiveEditor)) +
    gl('새로고침') +
    row('자동 새로고침', '언제 미리보기를 갱신할지 정합니다.',
      '<div class="seg" data-key="autoRefresh">' +
      '<button data-val="onType"' + act(ar, 'onType') + '>입력 즉시</button>' +
      '<button data-val="onSave"' + act(ar, 'onSave') + '>저장 시</button>' +
      '<button data-val="off"' + act(ar, 'off') + '>수동</button></div>') +
    row('새로고침 지연', '입력 후 갱신까지 대기 시간입니다.',
      '<div class="num"><input type="range" min="0" max="1500" step="50" data-key="refreshDelay" value="' + delay + '">' +
      '<span class="val" id="delayVal">' + delay + 'ms</span></div>') +
    row('에디터 스크롤 동기화', '에디터를 스크롤하면 미리보기도 따라갑니다.', toggle('syncScroll', v.syncScroll)) +
    gl('진단') +
    row('콘솔/에러 전달', "페이지의 console·에러를 'HTML Preview Console'로 보냅니다.", toggle('forwardConsole', v.forwardConsole)) +
    row('에러 화면 표시', '에러가 나면 미리보기 위 유리 카드로 보여줍니다.', toggle('showErrorOverlay', v.showErrorOverlay)) +
    row('품질 점검', '로드 시 깨진 링크·alt 없는 이미지를 알려줍니다.', toggle('qualityChecks', v.qualityChecks)) +
    gl('서버') +
    row('SPA 폴백', '확장자 없는 경로를 index.html로 응답합니다.', toggle('spaFallback', v.spaFallback)) +
    row('네트워크 공개 (QR)', '⚠️ 같은 Wi-Fi 기기(휴대폰)에서 접속을 허용합니다.', toggle('allowNetworkPreview', v.allowNetworkPreview));
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
 * 미리보기 웹뷰 셸: 로컬 서버 iframe + 정돈된 툴바(디바이스/줌/도구) + 설정 드로어.
 */
function iframeShell(url, v) {
  const safe = String(url).replace(/"/g, '&quot;');
  const nonce = getNonce();
  return '<!DOCTYPE html><html lang="ko"><head><meta charset="utf-8">' +
    '<meta http-equiv="Content-Security-Policy" content="default-src \'none\'; ' +
    'frame-src http: https:; style-src \'unsafe-inline\'; script-src \'nonce-' + nonce + '\';">' +
    '<style>' +
    'html,body{margin:0;padding:0;height:100%}' +
    'body{display:flex;flex-direction:column;font:12px -apple-system,BlinkMacSystemFont,"Segoe UI",sans-serif;' +
    'background:var(--vscode-editor-background,#1e1e1e);color:var(--vscode-foreground,#ccc)}' +
    '#bar{display:flex;align-items:center;gap:8px;padding:5px 10px;user-select:none;' +
    'background:var(--vscode-sideBar-background,#252526);border-bottom:1px solid var(--vscode-panel-border,#333)}' +
    '.g{display:flex;align-items:center;gap:3px}' +
    '.sep{width:1px;height:16px;background:var(--vscode-panel-border,#3a3a3a);margin:0 2px}' +
    '#bar select,#bar input{background:var(--vscode-input-background,#2a2a2e);color:var(--vscode-input-foreground,#ddd);' +
    'border:1px solid var(--vscode-panel-border,#3a3a3a);border-radius:6px;font:12px sans-serif;height:25px;padding:0 6px}' +
    '#bar input#w{width:60px}' +
    '.ib{width:26px;height:25px;display:inline-flex;align-items:center;justify-content:center;border:0;border-radius:6px;' +
    'background:transparent;color:inherit;cursor:pointer;opacity:.82;padding:0}' +
    '.ib:hover{background:rgba(128,128,128,.2);opacity:1}' +
    '.ib.on{background:var(--vscode-button-background,#0e639c);color:var(--vscode-button-foreground,#fff);opacity:1}' +
    '.zc{display:inline-flex;align-items:center;border:1px solid var(--vscode-panel-border,#3a3a3a);border-radius:6px;overflow:hidden}' +
    '.zc .ib{border-radius:0;width:23px;height:23px;font-size:13px}' +
    '#z{font-size:11px;min-width:40px;text-align:center;opacity:.85;font-variant-numeric:tabular-nums}' +
    '#dim{margin-left:auto;font-size:11px;opacity:.6;font-variant-numeric:tabular-nums}' +
    '#eb{font-size:11px;font-weight:700;padding:2px 9px;border-radius:999px;flex:none;' +
    'background:rgba(60,180,90,.22);color:#8ef0a8}' +
    '#eb.bad{background:rgba(220,70,60,.26);color:#ffb3ab}' +
    '#wrap{flex:1;overflow:auto;display:flex;justify-content:center;align-items:stretch;position:relative;' +
    'background:var(--vscode-editor-background,#1e1e1e)}' +
    '#wrap.dev{align-items:center;padding:18px;' +
    'background-image:radial-gradient(rgba(128,128,128,.14) 1px,transparent 1px);background-size:20px 20px}' +
    'iframe{border:0;width:100%;height:100%;display:block;background:#fff}' +
    'iframe.framed{box-shadow:0 0 0 1px rgba(0,0,0,.3),0 10px 34px rgba(0,0,0,.38)}' +
    'iframe.bezel{border:12px solid #16181d;border-radius:34px;flex:none;' +
    'box-shadow:0 0 0 1.5px rgba(255,255,255,.09),0 24px 60px rgba(0,0,0,.5)}' +
    '#gridov{position:absolute;inset:0;pointer-events:none;z-index:5;display:none;' +
    'background-image:linear-gradient(rgba(0,120,220,.18) 1px,transparent 1px),linear-gradient(90deg,rgba(0,120,220,.18) 1px,transparent 1px);background-size:8px 8px}' +
    '#drawer{position:absolute;top:10px;right:10px;width:344px;max-height:calc(100% - 20px);overflow:auto;z-index:10;' +
    'filter:drop-shadow(0 12px 30px rgba(0,0,0,.35))}' +
    '#drawer[hidden]{display:none}' +
    '#drawer .dh{display:flex;align-items:center;justify-content:space-between;padding:10px 2px 6px;font-weight:700;font-size:12px}' +
    '#drawer .dh .x{cursor:pointer;opacity:.6;padding:2px 8px;font-size:13px}' +
    '#drawer .dh .x:hover{opacity:1}' +
    settingsCss() +
    '</style></head><body>' +
    '<div id="bar">' +
    '<div class="g">' +
    '<select id="dev" title="기기 프리셋">' +
    '<option value="0">Desktop</option><option value="1280">Laptop 1280</option>' +
    '<option value="1024">iPad Pro 1024</option><option value="820">iPad 820</option>' +
    '<option value="393">iPhone 15 393</option><option value="375">iPhone SE 375</option>' +
    '<option value="360">Galaxy 360</option><option value="custom">Custom</option></select>' +
    '<input id="w" type="number" min="200" max="4000" step="10" title="폭(px)">' +
    '<button id="rot" class="ib" title="회전(가로/세로)">' + icon('rotate') + '</button>' +
    '<button id="frm" class="ib" title="디바이스 프레임">' + icon('phone') + '</button>' +
    '</div><span class="sep"></span>' +
    '<div class="g zc"><button id="zo" class="ib" title="축소">−</button><span id="z">100%</span>' +
    '<button id="zi" class="ib" title="확대">+</button></div>' +
    '<span class="sep"></span>' +
    '<div class="g">' +
    '<button id="rl" class="ib" title="하드 새로고침">' + icon('reload') + '</button>' +
    '<button id="bgb" class="ib" title="배경 전환(흰/체커/다크)">' + icon('bg') + '</button>' +
    '<button id="grb" class="ib" title="그리드 오버레이">' + icon('grid') + '</button>' +
    '<button id="ins" class="ib" title="요소 검사 (클릭→소스로 이동)">' + icon('target') + '</button>' +
    '<button id="pin" class="ib" title="미리보기 고정 (에디터 따라가기 중지)">' + icon('pin') + '</button>' +
    '<button id="pause" class="ib" title="자동 새로고침 일시정지">' + icon('pause') + '</button>' +
    '</div>' +
    '<span id="dim"></span><span id="eb" title="에러 상태">✓</span>' +
    '<button id="gear" class="ib" title="설정">' + icon('sliders') + '</button></div>' +
    '<div id="wrap">' +
    '<iframe id="f" src="' + safe + '" allow="autoplay; fullscreen; clipboard-read; clipboard-write"></iframe>' +
    '<div id="gridov"></div>' +
    '<div id="drawer" hidden><div class="card">' +
    '<div class="dh"><span>설정</span><span class="x" id="gclose">✕</span></div>' +
    settingsRows(v) + '</div></div></div>' +
    '<script nonce="' + nonce + '">(function(){' +
    'var api=(typeof acquireVsCodeApi==="function")?acquireVsCodeApi():null;' +
    'function send(k,val){if(api)api.postMessage({type:"update",key:k,value:val});}' +
    'var f=document.getElementById("f"),dim=document.getElementById("dim"),wrap=document.getElementById("wrap");' +
    'var dev=document.getElementById("dev"),win=document.getElementById("w"),zEl=document.getElementById("z");' +
    'var rotB=document.getElementById("rot"),frmB=document.getElementById("frm");' +
    'var DIMS={"1280":[1280,800],"1024":[1024,1366],"820":[820,1180],"393":[393,852],"375":[375,667],"360":[360,780]};' +
    'var baseW=0,land=false,frame=false;' +
    'function applyView(){' +
    'if(!baseW){f.style.width="100%";f.style.height="100%";f.classList.remove("framed","bezel");wrap.classList.remove("dev");' +
    'dim.textContent="100%";if(win)win.value="";rotB.classList.remove("on");frmB.classList.remove("on");return;}' +
    'var dm=DIMS[String(baseW)],ww=baseW,hh=0;if(dm){hh=dm[1];if(land){ww=dm[1];hh=dm[0];}}' +
    'f.style.width=ww+"px";f.style.height=hh?(hh+"px"):"100%";' +
    'f.classList.add("framed");f.classList.toggle("bezel",frame&&!!hh);' +
    'wrap.classList.toggle("dev",!!hh);' +
    'rotB.classList.toggle("on",land);frmB.classList.toggle("on",frame&&!!hh);' +
    'dim.textContent=ww+(hh?(" × "+hh):" px");if(win)win.value=ww;}' +
    'dev.addEventListener("change",function(){if(dev.value==="custom"){win.focus();return;}baseW=parseInt(dev.value,10)||0;land=false;applyView();});' +
    'win.addEventListener("change",function(){baseW=parseInt(win.value,10)||0;dev.value="custom";land=false;applyView();});' +
    'rotB.addEventListener("click",function(){land=!land;applyView();});' +
    'frmB.addEventListener("click",function(){frame=!frame;applyView();});' +
    'var zoom=1;function setZoom(z){zoom=Math.max(.25,Math.min(2,Math.round(z*100)/100));try{f.style.zoom=zoom;}catch(_){}zEl.textContent=Math.round(zoom*100)+"%";}' +
    'document.getElementById("zo").addEventListener("click",function(){setZoom(zoom-0.1);});' +
    'document.getElementById("zi").addEventListener("click",function(){setZoom(zoom+0.1);});' +
    'applyView();setZoom(1);' +
    'document.getElementById("rl").addEventListener("click",function(){try{f.src=f.src.split("?")[0]+"?hlv="+Date.now();}catch(_){}} );' +
    'var bgb=document.getElementById("bgb"),bgm=0,CHK="conic-gradient(#cfcfcf 25%,#fff 0 50%,#cfcfcf 0 75%,#fff 0) 0 0/18px 18px";' +
    'bgb.addEventListener("click",function(){bgm=(bgm+1)%3;bgb.classList.toggle("on",bgm!==0);' +
    'if(bgm===0){wrap.style.background="";f.style.background="#fff";}' +
    'else if(bgm===1){wrap.style.background=CHK;f.style.background="transparent";}' +
    'else{wrap.style.background="#141414";f.style.background="transparent";}});' +
    'var gv=document.getElementById("gridov"),grb=document.getElementById("grb");' +
    'grb.addEventListener("click",function(){var on=gv.style.display!=="block";gv.style.display=on?"block":"none";grb.classList.toggle("on",on);});' +
    'var insB=document.getElementById("ins"),insOn=false;' +
    'insB.addEventListener("click",function(){insOn=!insOn;insB.classList.toggle("on",insOn);' +
    'try{f.contentWindow.postMessage({__hlv:"inspect",on:insOn},"*")}catch(_){}} );' +
    'var pinB=document.getElementById("pin"),pinOn=false;' +
    'pinB.addEventListener("click",function(){pinOn=!pinOn;pinB.classList.toggle("on",pinOn);if(api)api.postMessage({type:"pin",on:pinOn});});' +
    'var pauB=document.getElementById("pause"),pauOn=false;' +
    'pauB.addEventListener("click",function(){pauOn=!pauOn;pauB.classList.toggle("on",pauOn);if(api)api.postMessage({type:"pause",on:pauOn});});' +
    'var dr=document.getElementById("drawer"),gearB=document.getElementById("gear");' +
    'gearB.addEventListener("click",function(){dr.hidden=!dr.hidden;gearB.classList.toggle("on",!dr.hidden);});' +
    'document.getElementById("gclose").addEventListener("click",function(){dr.hidden=true;gearB.classList.remove("on");});' +
    'window.addEventListener("message",function(e){var d=e.data;if(!d)return;' +
    'if(d.__hlv==="open"&&api){api.postMessage({type:"openSource",raw:d.raw});}' +
    'else if(d.__hlv==="pick"){if(api)api.postMessage({type:"pick",info:d.info});}' +
    'else if(d.__hlv==="inspectOff"){insOn=false;insB.classList.remove("on");}' +
    'else if(d.type==="scrollTo"){try{f.contentWindow.postMessage({__hlv:"scroll",ratio:d.ratio},"*")}catch(_){}}' +
    'else if(d.__hlv==="errcount"){if(api)api.postMessage({type:"errcount",n:d.n});var eb=document.getElementById("eb");if(eb){' +
    'if(d.n>0){eb.textContent="⚠ "+d.n;eb.classList.add("bad");}else{eb.textContent="✓";eb.classList.remove("bad");}}}});' +
    settingsControlsScript() +
    '})();</script></body></html>';
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
    'header{display:flex;align-items:center;gap:14px;margin-bottom:20px}' +
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

/** QR 패널: 휴대폰으로 보기. */
function qrShell(svg, url, note) {
  return '<!DOCTYPE html><html lang="ko"><head><meta charset="utf-8">' +
    '<meta http-equiv="Content-Security-Policy" content="default-src \'none\'; style-src \'unsafe-inline\';">' +
    '<style>' +
    'body{margin:0;min-height:100vh;display:flex;align-items:center;justify-content:center;' +
    'font:13px -apple-system,BlinkMacSystemFont,"Segoe UI",sans-serif;' +
    'background:var(--vscode-editor-background,#1e1e1e);color:var(--vscode-foreground,#ccc)}' +
    '.box{text-align:center;padding:28px}' +
    'h1{font-size:16px;margin:0 0 4px}' +
    '.sub{font-size:12px;opacity:.65;margin:0 0 18px}' +
    '.qr{display:inline-block;background:#fff;border-radius:14px;padding:6px;line-height:0;' +
    'box-shadow:0 14px 40px rgba(0,0,0,.35)}' +
    '.qr svg{width:240px;height:240px}' +
    '.url{margin-top:16px;font:12px ui-monospace,Menlo,monospace;user-select:all;' +
    'background:rgba(128,128,128,.14);border:1px solid rgba(128,128,128,.25);border-radius:8px;padding:9px 13px;display:inline-block}' +
    '.note{margin-top:14px;font-size:11.5px;opacity:.6;max-width:340px;margin-left:auto;margin-right:auto}' +
    '</style></head><body><div class="box">' +
    '<h1>📱 휴대폰으로 보기</h1>' +
    '<p class="sub">같은 Wi-Fi에 연결된 기기에서 카메라로 스캔하세요.</p>' +
    '<div class="qr">' + svg + '</div>' +
    '<div><span class="url">' + escapeHtml(url) + '</span></div>' +
    (note ? '<p class="note">⚠️ ' + escapeHtml(note) + '</p>' : '') +
    '<p class="note">이 기능은 미리보기 서버를 로컬 네트워크에 공개합니다. 끝나면 설정에서 「네트워크 공개」를 꺼 주세요.</p>' +
    '</div></body></html>';
}

module.exports = {
  iframeShell, settingsShell, loadingShell, fallbackPage, qrShell,
  escapeHtml, getNonce, settingsCss, settingsRows, settingsControlsScript, icon
};
