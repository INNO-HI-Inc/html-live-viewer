'use strict';
// QR 인코더 구조 검증. 포맷 비트는 스펙 공개 벡터와 대조한다.
const { encode, toSvg, __test } = require('../qr');

let pass = 0, fail = 0;
function check(name, cond) {
  if (cond) { pass++; console.log('  ✓ ' + name); }
  else { fail++; console.log('  ✗ ' + name + '  <-- FAILED'); }
}

console.log('\n[Q1] 포맷 비트(BCH) — 스펙 공개 벡터 대조');
// ISO/IEC 18004 공개 테이블: EC M + mask 0 = 101010000010010, EC L + mask 0 = 111011111000100
check('M/mask0 = 0x5412', __test.bch15(0b00000) === 0b101010000010010);
check('L/mask0 = 0x77C4', __test.bch15(0b01000) === 0b111011111000100);

console.log('\n[Q2] Reed-Solomon');
// EC가 붙은 코드워드는 생성다항식으로 나눠떨어져야 함 → 재계산 시 remainder 전부 0
const d = [32, 91, 11, 120, 209, 114, 220, 77, 67, 64, 236, 17, 236, 17, 236, 17];
const ec = __test.rsRemainder(d, 10);
check('EC 길이 10', ec.length === 10);
const again = __test.rsRemainder(d.concat(ec), 10);
check('데이터+EC 재나눗셈 remainder=0', again.every((v) => v === 0));

console.log('\n[Q3] 매트릭스 구조');
const q = encode('HELLO WORLD');
check('v1 → 21×21', q.size === 21 && q.version === 1);
check('모든 셀이 boolean(미정 없음)', q.modules.every((r) => r.every((v) => typeof v === 'boolean')));
// 파인더 3개: 코너 픽셀/중심 확인
const fOK = (r, c) => q.modules[r][c] === true && q.modules[r + 3][c + 3] === true && q.modules[r + 1][c + 1] === false;
check('파인더 좌상/좌하/우상', fOK(0, 0) && fOK(q.size - 7, 0) && fOK(0, q.size - 7));
check('다크 모듈 (4v+9,8)', q.modules[q.size - 8][8] === true);
// 타이밍 패턴 교대
let timing = true;
for (let i = 8; i < q.size - 8; i++) if (q.modules[6][i] !== (i % 2 === 0)) timing = false;
check('타이밍 패턴 교대', timing);

console.log('\n[Q4] URL 버전 선택 + SVG');
const url = 'http://192.168.100.100:54321/sample/index.html';
const q2 = encode(url);
check('URL(46B) → v3 이상, 정사각', q2.version >= 3 && q2.modules.length === q2.size);
const svg = toSvg(q2);
check('SVG 생성(흰 배경+검정 모듈)', svg.startsWith('<svg') && svg.includes('fill="#fff"') && svg.includes('fill="#000"'));
const q3 = encode(url);
check('결정적(같은 입력→같은 출력)', JSON.stringify(q2.modules) === JSON.stringify(q3.modules));

console.log('\n[Q5] 한계 처리');
let threw = false;
try { encode('x'.repeat(200)); } catch (e) { threw = true; }
check('용량 초과 시 명확한 예외', threw);

console.log('\n' + pass + ' passed, ' + fail + ' failed');
process.exit(fail ? 1 : 0);
