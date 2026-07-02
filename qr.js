'use strict';
// 최소 QR 인코더 — byte 모드, EC level M, version 1~6 (URL용으로 충분: 최대 106바이트).
// 외부 의존성 없음. GF(256) Reed-Solomon + 표준 마스크/포맷 비트.

// ---- GF(256) ----
const EXP = new Uint8Array(512), LOG = new Uint8Array(256);
(function () {
  let x = 1;
  for (let i = 0; i < 255; i++) { EXP[i] = x; LOG[x] = i; x <<= 1; if (x & 0x100) x ^= 0x11d; }
  for (let i = 255; i < 512; i++) EXP[i] = EXP[i - 255];
})();
const gmul = (a, b) => (a && b) ? EXP[LOG[a] + LOG[b]] : 0;

// version(1~6), EC=M: [블록당 EC 코드워드, [[블록수, 블록당 데이터], ...]]
const BLOCKS = {
  1: [10, [[1, 16]]], 2: [16, [[1, 28]]], 3: [26, [[1, 44]]],
  4: [18, [[2, 32]]], 5: [24, [[2, 43]]], 6: [16, [[4, 27]]]
};
const ALIGN = { 1: [], 2: [6, 18], 3: [6, 22], 4: [6, 26], 5: [6, 30], 6: [6, 34] };

/** 포맷 정보 15비트: (EC비트<<3 | 마스크) → BCH(15,5) + 고정 XOR. */
function bch15(data5) {
  let d = data5 << 10;
  const g = 0b10100110111;
  for (let i = 14; i >= 10; i--) if ((d >> i) & 1) d ^= g << (i - 10);
  return ((data5 << 10) | (d & 0x3FF)) ^ 0b101010000010010;
}

function polyMul(a, b) {
  const r = new Array(a.length + b.length - 1).fill(0);
  for (let i = 0; i < a.length; i++)
    for (let j = 0; j < b.length; j++) r[i + j] ^= gmul(a[i], b[j]);
  return r;
}

function rsRemainder(data, ec) {
  let gen = [1];
  for (let i = 0; i < ec; i++) gen = polyMul(gen, [1, EXP[i]]);
  const buf = data.concat(new Array(ec).fill(0));
  for (let i = 0; i < data.length; i++) {
    const c = buf[i];
    if (c === 0) continue;
    for (let j = 0; j < gen.length; j++) buf[i + j] ^= gmul(gen[j], c);
  }
  return buf.slice(data.length);
}

/** 텍스트 → 최종 코드워드(데이터+EC 인터리브). */
function makeCodewords(text, version) {
  const bytes = Array.from(Buffer.from(String(text), 'utf8'));
  const [ec, groups] = BLOCKS[version];
  const totalData = groups.reduce((s, g) => s + g[0] * g[1], 0);
  const bits = [];
  const push = (val, len) => { for (let i = len - 1; i >= 0; i--) bits.push((val >> i) & 1); };
  push(0b0100, 4);            // byte 모드
  push(bytes.length, 8);      // v1~9: 8비트 길이
  for (const b of bytes) push(b, 8);
  const cap = totalData * 8;
  push(0, Math.min(4, cap - bits.length)); // terminator
  while (bits.length % 8) bits.push(0);
  const data = [];
  for (let i = 0; i < bits.length; i += 8) {
    let v = 0;
    for (let j = 0; j < 8; j++) v = (v << 1) | bits[i + j];
    data.push(v);
  }
  const pads = [0xEC, 0x11];
  for (let i = 0; data.length < totalData; i++) data.push(pads[i % 2]);
  // 블록 분할 → EC 계산 → 인터리브
  const blocks = [];
  let off = 0;
  for (const [n, dlen] of groups) for (let k = 0; k < n; k++) { blocks.push(data.slice(off, off + dlen)); off += dlen; }
  const ecBlocks = blocks.map((b) => rsRemainder(b, ec));
  const out = [];
  const maxD = Math.max.apply(null, blocks.map((b) => b.length));
  for (let i = 0; i < maxD; i++) for (const b of blocks) if (i < b.length) out.push(b[i]);
  for (let i = 0; i < ec; i++) for (const b of ecBlocks) out.push(b[i]);
  return out;
}

const MASKS = [
  (r, c) => (r + c) % 2 === 0,
  (r) => r % 2 === 0,
  (r, c) => c % 3 === 0,
  (r, c) => (r + c) % 3 === 0,
  (r, c) => (Math.floor(r / 2) + Math.floor(c / 3)) % 2 === 0,
  (r, c) => ((r * c) % 2) + ((r * c) % 3) === 0,
  (r, c) => (((r * c) % 2) + ((r * c) % 3)) % 2 === 0,
  (r, c) => (((r + c) % 2) + ((r * c) % 3)) % 2 === 0
];

/** 기능 패턴(파인더/정렬/타이밍)만 놓인 베이스 매트릭스. null=미정. */
function baseMatrix(version) {
  const size = 17 + version * 4;
  const M = Array.from({ length: size }, () => new Array(size).fill(null));
  const finder = (r, c) => {
    for (let dr = -1; dr <= 7; dr++) for (let dc = -1; dc <= 7; dc++) {
      const rr = r + dr, cc = c + dc;
      if (rr < 0 || rr >= size || cc < 0 || cc >= size) continue;
      const on = (dr >= 0 && dr <= 6 && (dc === 0 || dc === 6)) ||
        (dc >= 0 && dc <= 6 && (dr === 0 || dr === 6)) ||
        (dr >= 2 && dr <= 4 && dc >= 2 && dc <= 4);
      M[rr][cc] = on;
    }
  };
  finder(0, 0); finder(size - 7, 0); finder(0, size - 7);
  const pos = ALIGN[version];
  for (const r of pos) for (const c of pos) {
    if (M[r][c] !== null) continue;
    for (let dr = -2; dr <= 2; dr++) for (let dc = -2; dc <= 2; dc++)
      M[r + dr][c + dc] = Math.max(Math.abs(dr), Math.abs(dc)) !== 1;
  }
  for (let i = 8; i < size - 8; i++) {
    if (M[i][6] === null) M[i][6] = i % 2 === 0;
    if (M[6][i] === null) M[6][i] = i % 2 === 0;
  }
  return M;
}

/** 포맷 정보 배치 (EC=M → 상위 2비트 00) + 다크 모듈. */
function placeFormat(M, maskPattern) {
  const size = M.length;
  const bits = bch15((0b00 << 3) | maskPattern);
  for (let i = 0; i < 15; i++) {
    const m = ((bits >> i) & 1) === 1;
    if (i < 6) M[i][8] = m;
    else if (i < 8) M[i + 1][8] = m;
    else M[size - 15 + i][8] = m;
    if (i < 8) M[8][size - i - 1] = m;
    else if (i < 9) M[8][15 - i - 1 + 1] = m;
    else M[8][15 - i - 1] = m;
  }
  M[size - 8][8] = true; // 다크 모듈
}

/** 지그재그 데이터 배치 + 마스크 적용. */
function placeData(M, data, maskPattern) {
  const size = M.length, mask = MASKS[maskPattern];
  let inc = -1, row = size - 1, bitIdx = 7, byteIdx = 0;
  for (let col = size - 1; col > 0; col -= 2) {
    if (col === 6) col--;
    for (;;) {
      for (let c = 0; c < 2; c++) {
        if (M[row][col - c] === null) {
          let dark = false;
          if (byteIdx < data.length) dark = ((data[byteIdx] >>> bitIdx) & 1) === 1;
          if (mask(row, col - c)) dark = !dark;
          M[row][col - c] = dark;
          bitIdx--;
          if (bitIdx === -1) { byteIdx++; bitIdx = 7; }
        }
      }
      row += inc;
      if (row < 0 || row === size) { row -= inc; inc = -inc; break; }
    }
  }
}

/** 표준 4개 페널티 규칙 (마스크 선택용 — 값이 틀려도 스캔 가능성엔 영향 없음). */
function penalty(M) {
  const size = M.length;
  let score = 0;
  const runLine = (get) => {
    for (let i = 0; i < size; i++) {
      let run = 1;
      for (let j = 1; j < size; j++) {
        if (get(i, j) === get(i, j - 1)) { run++; }
        else { if (run >= 5) score += 3 + (run - 5); run = 1; }
      }
      if (run >= 5) score += 3 + (run - 5);
    }
  };
  runLine((i, j) => M[i][j]);
  runLine((i, j) => M[j][i]);
  for (let r = 0; r < size - 1; r++) for (let c = 0; c < size - 1; c++) {
    const v = M[r][c];
    if (v === M[r][c + 1] && v === M[r + 1][c] && v === M[r + 1][c + 1]) score += 3;
  }
  const pat1 = [1, 0, 1, 1, 1, 0, 1, 0, 0, 0, 0], pat2 = [0, 0, 0, 0, 1, 0, 1, 1, 1, 0, 1];
  const checkPat = (get) => {
    for (let i = 0; i < size; i++) for (let j = 0; j <= size - 11; j++) {
      let m1 = true, m2 = true;
      for (let k = 0; k < 11; k++) {
        const v = get(i, j + k) ? 1 : 0;
        if (v !== pat1[k]) m1 = false;
        if (v !== pat2[k]) m2 = false;
      }
      if (m1) score += 40;
      if (m2) score += 40;
    }
  };
  checkPat((i, j) => M[i][j]);
  checkPat((i, j) => M[j][i]);
  let dark = 0;
  for (let r = 0; r < size; r++) for (let c = 0; c < size; c++) if (M[r][c]) dark++;
  score += Math.floor(Math.abs((dark * 100) / (size * size) - 50) / 5) * 10;
  return score;
}

/** 텍스트 → {size, modules(2차원 boolean)} */
function encode(text) {
  const byteLen = Buffer.byteLength(String(text), 'utf8');
  let version = 0;
  for (let v = 1; v <= 6; v++) {
    const totalData = BLOCKS[v][1].reduce((s, g) => s + g[0] * g[1], 0);
    if (4 + 8 + byteLen * 8 <= totalData * 8) { version = v; break; }
  }
  if (!version) throw new Error('QR: 데이터가 너무 깁니다 (최대 ~106바이트)');
  const data = makeCodewords(text, version);
  const base = baseMatrix(version);
  let best = null, bestScore = Infinity;
  for (let mp = 0; mp < 8; mp++) {
    const M = base.map((r) => r.slice());
    placeFormat(M, mp);
    placeData(M, data, mp);
    const s = penalty(M);
    if (s < bestScore) { bestScore = s; best = M; }
  }
  return { size: best.length, modules: best, version };
}

/** 매트릭스 → SVG 문자열 (흰 배경 + quiet zone 4모듈). */
function toSvg(qrObj, scale, margin) {
  scale = scale || 6; margin = margin == null ? 4 : margin;
  const size = qrObj.size, dim = (size + margin * 2) * scale;
  let rects = '';
  for (let r = 0; r < size; r++) for (let c = 0; c < size; c++) {
    if (qrObj.modules[r][c]) {
      rects += '<rect x="' + (c + margin) * scale + '" y="' + (r + margin) * scale +
        '" width="' + scale + '" height="' + scale + '"/>';
    }
  }
  return '<svg xmlns="http://www.w3.org/2000/svg" width="' + dim + '" height="' + dim +
    '" viewBox="0 0 ' + dim + ' ' + dim + '" shape-rendering="crispEdges">' +
    '<rect width="100%" height="100%" fill="#fff"/><g fill="#000">' + rects + '</g></svg>';
}

module.exports = { encode, toSvg, __test: { bch15, rsRemainder, makeCodewords, baseMatrix } };
