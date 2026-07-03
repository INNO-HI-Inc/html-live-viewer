'use strict';
// 실제 http 요청으로 정적 서버 + 라이브리로드를 검증한다 (목킹 아님).
const http = require('http');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { PreviewServer } = require('../server');

let pass = 0, fail = 0;
function check(name, cond) {
  if (cond) { pass++; console.log('  ✓ ' + name); }
  else { fail++; console.log('  ✗ ' + name + '  <-- FAILED'); }
}

function get(port, urlPath, headers) {
  return new Promise((resolve, reject) => {
    const req = http.get({ host: '127.0.0.1', port, path: urlPath, headers: headers || {} }, (res) => {
      const chunks = [];
      res.on('data', (c) => chunks.push(c));
      res.on('end', () => resolve({
        status: res.statusCode, type: res.headers['content-type'],
        headers: res.headers, body: Buffer.concat(chunks).toString('utf8')
      }));
    });
    req.on('error', reject);
  });
}

// SSE: 응답이 오면 즉시 req/res 를 넘긴다 (reload 는 나중에 별도로 기다림).
function openSse(port) {
  return new Promise((resolve, reject) => {
    const req = http.get({ host: '127.0.0.1', port, path: '/__livereload' }, (res) => {
      resolve({ req, res });
    });
    req.on('error', reject);
  });
}

const tick = (ms) => new Promise((r) => setTimeout(r, ms || 30));

(async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'hlv-srv-'));
  fs.writeFileSync(path.join(dir, 'index.html'),
    '<!DOCTYPE html><html><head><link rel="stylesheet" href="style.css"></head><body><h1>PAGE_MARK</h1></body></html>');
  fs.writeFileSync(path.join(dir, 'style.css'), 'h1{color:red} /* CSS_MARK */');
  fs.mkdirSync(path.join(dir, 'sub'));
  fs.writeFileSync(path.join(dir, 'sub', 'index.html'), '<html><body>SUB_MARK</body></html>');

  const srv = new PreviewServer(dir);
  const port = await srv.start();
  console.log('\n[server] listening on 127.0.0.1:' + port + ' root=' + dir);

  // 1) 정적 파일 서빙 + MIME + 라이브리로드 주입
  {
    console.log('\n[S1] 정적 서빙 / MIME / 라이브리로드 주입');
    const html = await get(port, '/index.html');
    check('index.html 200', html.status === 200);
    check('Content-Type text/html', /text\/html/.test(html.type));
    check('페이지 내용 포함', html.body.includes('PAGE_MARK'));
    check('라이브리로드 스크립트 주입됨', html.body.includes('__livereload') && html.body.includes('EventSource'));

    const css = await get(port, '/style.css');
    check('style.css 200', css.status === 200);
    check('Content-Type text/css', /text\/css/.test(css.type));
    check('CSS 내용 포함, 라이브리로드는 CSS엔 미주입', css.body.includes('CSS_MARK') && !css.body.includes('EventSource'));
  }

  // 2) 디렉터리 → index.html, 루트 → index.html
  {
    console.log('\n[S2] 디렉터리 인덱스 처리');
    const root = await get(port, '/');
    check('/ → index.html', root.status === 200 && root.body.includes('PAGE_MARK'));
    const sub = await get(port, '/sub');
    check('/sub → sub/index.html', sub.status === 200 && sub.body.includes('SUB_MARK'));
  }

  // 3) 404 / 트래버설 차단
  {
    console.log('\n[S3] 없는 파일 / 경로 트래버설 방어');
    const notFound = await get(port, '/nope.html');
    check('없는 파일 404', notFound.status === 404);
    const trav = await get(port, '/..%2f..%2f..%2fetc%2fpasswd');
    check('상위 경로 접근 차단(403 또는 404)', trav.status === 403 || trav.status === 404);
    check('시스템 파일 내용이 새지 않음', !/root:.*:0:0:/.test(trav.body));
  }

  // 4) 열린 버퍼 우선 제공 (저장 안 한 변경 미리보기)
  {
    console.log('\n[S4] 열린 에디터 버퍼 우선 제공');
    srv.readText = (abs) => (abs === path.join(dir, 'index.html'))
      ? '<html><body>UNSAVED_BUFFER</body></html>' : undefined;
    const html = await get(port, '/index.html');
    check('디스크 대신 버퍼 내용 제공', html.body.includes('UNSAVED_BUFFER') && !html.body.includes('PAGE_MARK'));
    check('버퍼 HTML에도 라이브리로드 주입', html.body.includes('EventSource'));
    srv.readText = null;
  }

  // 5) SSE 라이브리로드: 연결 후 notifyReload → reload 수신
  {
    console.log('\n[S5] SSE 라이브리로드 신호');
    const sse = await openSse(port);
    check('SSE 연결 수립', !!sse.res);
    await tick(20);
    check('현재 연결된 클라이언트 1', srv.clients.size === 1);
    srv.notifyReload();
    // reload 메시지 수신 대기
    const got = await new Promise((resolve) => {
      let buf = '';
      sse.res.on('data', (c) => { buf += c.toString('utf8'); if (/data:\s*reload/.test(buf)) resolve(true); });
      setTimeout(() => resolve(/data:\s*reload/.test(buf)), 400);
    });
    check('reload 신호 수신', got === true);
    // CSS 전용 신호
    const sse2 = await openSse(port);
    await tick(20);
    srv.notify('css');
    const gotCss = await new Promise((resolve) => {
      let buf = '';
      sse2.res.on('data', (c) => { buf += c.toString('utf8'); if (/data:\s*css/.test(buf)) resolve(true); });
      setTimeout(() => resolve(/data:\s*css/.test(buf)), 400);
    });
    check('notify("css") → css 신호 수신', gotCss === true);
    try { sse.req.destroy(); sse2.req.destroy(); } catch (_) {}
    await tick(30);
    check('연결 종료 후 클라이언트 정리', srv.clients.size === 0);
  }

  // 6) HTTP Range (비디오/오디오 탐색 · 대용량 스트리밍)
  {
    console.log('\n[S6] HTTP Range 부분 응답');
    fs.writeFileSync(path.join(dir, 'data.bin'), 'ABCDEFGHIJ'); // 10바이트
    const full = await get(port, '/data.bin');
    check('Accept-Ranges 헤더 노출', full.headers['accept-ranges'] === 'bytes');
    const part = await get(port, '/data.bin', { Range: 'bytes=2-5' });
    check('부분 요청 206', part.status === 206);
    check('요청 구간만 반환(CDEF)', part.body === 'CDEF');
    check('Content-Range 헤더', part.headers['content-range'] === 'bytes 2-5/10');
    const bad = await get(port, '/data.bin', { Range: 'bytes=999-' });
    check('범위 초과 416', bad.status === 416);
  }

  // 7) 콘솔 전달: /__log POST → onClientLog 호출, 주입 토글
  {
    console.log('\n[S7] 콘솔 전달 (/__log + 주입 토글)');
    let received = null;
    srv.onClientLog = (e) => { received = e; };
    const post = (body) => new Promise((resolve) => {
      const req = http.request({ host: '127.0.0.1', port, path: '/__log', method: 'POST' }, (res) => {
        res.on('data', () => {}); res.on('end', () => resolve(res.statusCode));
      });
      req.end(body);
    });
    const st = await post(JSON.stringify({ level: 'error', msg: 'FROM_PAGE' }));
    await tick(20);
    check('/__log 204 응답', st === 204);
    check('onClientLog 로 전달됨', received && received.level === 'error' && received.msg === 'FROM_PAGE');

    srv.forwardConsole = true;
    const withCons = await get(port, '/index.html');
    check('forwardConsole=true 면 콘솔 후킹 주입', withCons.body.includes('sendBeacon'));
    srv.forwardConsole = false; srv.showErrorOverlay = false;
    const noCons = await get(port, '/index.html');
    check('둘 다 off면 후킹/오버레이 미주입', !noCons.body.includes('sendBeacon') && !noCons.body.includes('data-hlv-err') && noCons.body.includes('EventSource'));
    srv.forwardConsole = true; srv.showErrorOverlay = true;
  }

  // 8) 에러 화면 오버레이 주입
  {
    console.log('\n[S8] 에러 화면 오버레이');
    srv.showErrorOverlay = true;
    const on = await get(port, '/index.html');
    check('showErrorOverlay=true 면 오버레이 활성(OV=1)', on.body.includes('data-hlv-err') && on.body.includes('OV=1'));
    check('window.error/rejection 후킹 포함', on.body.includes('addEventListener("error"') && on.body.includes('unhandledrejection'));
    check('에러 카운트(errcount) 전파 포함', on.body.includes('errcount') && on.body.includes('function bump'));
    check('사람이 읽기 쉬운 설명(explain) 포함', on.body.includes('function explain') && on.body.includes('찾을 수 없어요'));
    check('CSS 핫리로드 로직 주입', on.body.includes('link[rel=stylesheet]') && on.body.includes('e.data==="css"'));
    check('스크롤 위치 보존 로직 주입', on.body.includes('__hlv_sy__') && on.body.includes('scrollTo'));
    check('리소스 로드 실패(캡처) 감지 주입', on.body.includes('리소스 로드 실패') && on.body.includes('"resource"'));
    // 품질 점검 토글
    srv.qualityChecks = true;
    const qcOn = await get(port, '/index.html');
    check('qualityChecks=true 면 점검 코드 주입', qcOn.body.includes('img:not([alt])') && qcOn.body.includes('깨진 링크'));
    srv.qualityChecks = false;
    const qcOff = await get(port, '/index.html');
    check('qualityChecks=false 면 미주입', !qcOff.body.includes('img:not([alt])'));
    // 주입된 스크립트가 문법적으로 유효한지 검증 (이스케이프 오류 방지)
    const js = (on.body.match(/<script data-hlv-client>([\s\S]*?)<\/script>/) || [])[1] || '';
    let ok = false; try { new Function(js); ok = true; } catch (e) { console.log('    script error:', e.message); }
    check('주입 스크립트 문법 유효', ok && js.length > 100);
    srv.showErrorOverlay = false;
    const off = await get(port, '/index.html');
    check('showErrorOverlay=false 면 오버레이 비활성(OV=0)', on.body.includes('data-hlv-err') && off.body.includes('OV=0'));
    srv.showErrorOverlay = true;
  }

  // 9) SPA 폴백
  {
    console.log('\n[S9] SPA 폴백');
    const noFb = await get(port, '/some/route');
    check('폴백 꺼짐: 없는 경로 404', noFb.status === 404);
    srv.spaFallback = true;
    const fb = await get(port, '/some/route');
    check('폴백 켜짐: 확장자 없는 경로 → index.html(200)', fb.status === 200 && fb.body.includes('PAGE_MARK'));
    const css = await get(port, '/nope.css');
    check('확장자 있는 없는 파일은 폴백 안 함(404)', css.status === 404);
    srv.spaFallback = false;
  }

  // 9b) 디렉터리 목록 (index.html 없는 폴더)
  {
    console.log('\n[S9b] 디렉터리 목록');
    fs.mkdirSync(path.join(dir, 'pages'));
    fs.writeFileSync(path.join(dir, 'pages', 'about.html'), '<html><body>A</body></html>');
    fs.writeFileSync(path.join(dir, 'pages', 'note.txt'), 'x');
    const ls = await get(port, '/pages');
    check('index 없는 폴더 → 200 목록', ls.status === 200 && /text\/html/.test(ls.type));
    check('파일 링크 포함', ls.body.includes('/pages/about.html') && ls.body.includes('note.txt'));
    check('index 있는 폴더는 여전히 index 서빙', (await get(port, '/sub')).body.includes('SUB_MARK'));
  }

  // 9c) 요소 검사/스크롤 동기화 코드 주입
  {
    console.log('\n[S9c] 요소 검사·스크롤 수신 주입');
    const on = await get(port, '/index.html');
    check('inspect/pick 코드 주입', on.body.includes('__hlv==="inspect"') && on.body.includes('"pick"'));
    check('scroll 수신 코드 주입', on.body.includes('__hlv==="scroll"'));
    check('nth(몇 번째 요소) 계산 주입', on.body.includes('info.nth='));
    const js = (on.body.match(/<script data-hlv-client>([\s\S]*?)<\/script>/) || [])[1] || '';
    let ok = false; try { new Function(js); ok = true; } catch (e) { console.log('    err:', e.message); }
    check('주입 스크립트 문법 유효(재검증)', ok);
  }

  // 10) host 바인딩 파라미터
  {
    console.log('\n[S10] host 바인딩');
    const s2 = new PreviewServer(dir);
    await s2.start(0, '127.0.0.1');
    check('host 지정 시 해당 주소로 기동', s2.host === '127.0.0.1' && s2.port > 0);
    const r = await get(s2.port, '/index.html');
    check('지정 host로 응답', r.status === 200);
    s2.dispose();
  }

  srv.dispose();
  console.log('\n' + pass + ' passed, ' + fail + ' failed');
  process.exit(fail ? 1 : 0);
})().catch((e) => { console.error('SERVER TEST ERROR:', e); process.exit(2); });
