/* Упрощённое «проявление» DNG без встроенного превью (часто у телефонов: Xiaomi, Samsung, Pixel…).
 * Поддерживается: CFA-байер 2×2, без сжатия (Compression=1), 8/10/12/14/16 бит, полосы или тайлы.
 * Шаги: линеаризация (чёрный/белый уровень) → GainMap из OpcodeList2 (виньетирование) → бининг 2×2
 * (половинное разрешение, без демозаики) → баланс белого (AsShotNeutral) → ForwardMatrix → sRGB →
 * автоэкспозиция + мягкая тональная кривая → гамма sRGB.
 * Это не замена Lightroom: цвета и тон приблизительные, но быстро и без сторонних библиотек.
 * Спецификация: Adobe DNG Specification 1.6.
 * Экспортирует globalThis.RawDNG = { decode(buf, { step }) → { width, height, data: Uint8ClampedArray RGBA, orientation } }.
 */
(function () {
  'use strict';
  const TYPE_SIZE = { 1: 1, 2: 1, 3: 2, 4: 4, 5: 8, 6: 1, 7: 1, 8: 2, 9: 4, 10: 8, 11: 4, 12: 8, 13: 4, 16: 8 };

  function parseTiff(buf) {
    const dv = new DataView(buf);
    const le = dv.getUint16(0) === 0x4949;
    if (dv.getUint16(2, le) !== 42) throw new Error('не TIFF/DNG');
    const ifds = [];
    function value(t, c, off) {
      const out = [];
      for (let i = 0; i < c; i++) {
        const o = off + i * TYPE_SIZE[t];
        switch (t) {
          case 1: case 7: out.push(dv.getUint8(o)); break;
          case 6: out.push(dv.getInt8(o)); break;
          case 3: out.push(dv.getUint16(o, le)); break;
          case 8: out.push(dv.getInt16(o, le)); break;
          case 4: case 13: out.push(dv.getUint32(o, le)); break;
          case 9: out.push(dv.getInt32(o, le)); break;
          case 5: { const d = dv.getUint32(o + 4, le); out.push(d ? dv.getUint32(o, le) / d : 0); break; }
          case 10: { const d = dv.getInt32(o + 4, le); out.push(d ? dv.getInt32(o, le) / d : 0); break; }
          case 11: out.push(dv.getFloat32(o, le)); break;
          case 12: out.push(dv.getFloat64(o, le)); break;
          default: out.push(0);
        }
      }
      return out;
    }
    function readIfd(off, depth) {
      if (!off || off >= buf.byteLength || depth > 4 || ifds.some(x => x.off === off)) return;
      const n = dv.getUint16(off, le), tags = new Map();
      for (let i = 0; i < n; i++) {
        const e = off + 2 + 12 * i, tag = dv.getUint16(e, le), t = dv.getUint16(e + 2, le), c = dv.getUint32(e + 4, le);
        const sz = (TYPE_SIZE[t] || 1) * c;
        const vo = sz <= 4 ? e + 8 : dv.getUint32(e + 8, le);
        if (vo + sz > buf.byteLength) continue;
        tags.set(tag, t === 7 && c > 16 ? { raw: new Uint8Array(buf, vo, c) } : value(t, c, vo));
      }
      const ifd = { off, tags };
      ifds.push(ifd);
      const sub = tags.get(330); if (sub) for (const so of sub) readIfd(so, depth + 1);
      readIfd(dv.getUint32(off + 2 + 12 * n, le), depth);
    }
    readIfd(dv.getUint32(4, le), 0);
    return { dv, le, ifds };
  }

  // OpcodeList: всегда big-endian. Берём только GainMap (ID 9) — коррекция виньетирования/цветовых пятен
  function parseGainMaps(raw) {
    if (!raw) return [];
    const dv = new DataView(raw.buffer, raw.byteOffset, raw.byteLength), maps = [];
    let p = 0; const n = dv.getUint32(p); p += 4;
    for (let k = 0; k < n && p + 16 <= dv.byteLength; k++) {
      const id = dv.getUint32(p), bytes = dv.getUint32(p + 12); p += 16;
      if (id === 9) {
        let q = p; const u = () => { const v = dv.getUint32(q); q += 4; return v; }, d = () => { const v = dv.getFloat64(q); q += 8; return v; };
        const m = { top: u(), left: u(), bottom: u(), right: u(), plane: u(), planes: u(), rowPitch: u(), colPitch: u(),
          pv: u(), ph: u(), sv: d(), sh: d(), ov: d(), oh: d(), mapPlanes: u() };
        m.gain = new Float32Array(m.pv * m.ph * m.mapPlanes);
        for (let i = 0; i < m.gain.length; i++) { m.gain[i] = dv.getFloat32(q); q += 4; }
        maps.push(m);
      }
      p += bytes;
    }
    return maps;
  }

  const mul3 = (a, b) => [0, 1, 2].map(r => [0, 1, 2].map(c => a[r * 3] * b[c] + a[r * 3 + 1] * b[3 + c] + a[r * 3 + 2] * b[6 + c])).flat();
  function inv3(m) {
    const [a, b, c, d, e, f, g, h, i] = m, A = e * i - f * h, B = -(d * i - f * g), C = d * h - e * g, det = a * A + b * B + c * C;
    if (!det) return null;
    return [A, -(b * i - c * h), b * f - c * e, B, a * i - c * g, -(a * f - c * d), C, -(a * h - b * g), a * e - b * d].map(x => x / det);
  }
  // XYZ (D50) → линейный sRGB (D65), адаптация Брэдфорда
  const XYZD50_TO_SRGB = [3.1338561, -1.6168667, -0.4906146, -0.9787684, 1.9161415, 0.0334540, 0.0719453, -0.2289914, 1.4052427];

  function decode(buf, opts = {}) {
    const step = Math.max(1, opts.step | 0 || 1);       // для миниатюр: брать каждый step-й блок 2×2
    const { dv, le, ifds } = parseTiff(buf);
    const ifd0 = ifds[0].tags;
    const rawIfd = ifds.find(x => (x.tags.get(262) || [])[0] === 32803 && !(((x.tags.get(254) || [0])[0]) & 1));
    if (!rawIfd) throw new Error('в DNG нет данных CFA (возможно, это Linear DNG — пока не поддерживается)');
    const T = rawIfd.tags, g = (k, d) => T.has(k) ? T.get(k) : (ifd0.has(k) ? ifd0.get(k) : d);
    const W = T.get(256)[0], H = T.get(257)[0], bps = (T.get(258) || [16])[0], comp = (T.get(259) || [1])[0];
    if (comp !== 1) throw new Error(`сжатие DNG ${comp} пока не поддерживается (только без сжатия)`);
    if ((T.get(277) || [1])[0] !== 1) throw new Error('ожидался один канал CFA');
    const rep = g(33421, [2, 2]), pat = g(33422, [0, 1, 1, 2]);
    if (rep[0] !== 2 || rep[1] !== 2) throw new Error('поддерживается только CFA 2×2');

    // доступ к сырым значениям: полосы или тайлы
    let rowOff;                                                   // rowOff(r) → [смещение начала строки r, шаг по колонкам в тайле]
    const bytesRow = Math.ceil(W * bps / 8);
    if (T.has(324)) {                                             // тайлы
      const tw = T.get(322)[0], th = T.get(323)[0], to = T.get(324), across = Math.ceil(W / tw), tileRowBytes = Math.ceil(tw * bps / 8);
      rowOff = null;
      var sample = (r, c) => {
        const ti = Math.floor(r / th) * across + Math.floor(c / tw), base = to[ti] + (r % th) * tileRowBytes;
        return readAt(base, c % tw);
      };
    } else {
      const so = T.get(273), rps = (T.get(278) || [H])[0];
      rowOff = (r) => so[Math.floor(r / rps)] + (r % rps) * bytesRow;
      var sample = (r, c) => readAt(rowOff(r), c);
      // быстрый путь: 16 бит, little-endian, полосы подряд — один типизированный массив на весь кадр
      const contiguous = so.every((o, i) => i === 0 || o === so[i - 1] + rps * bytesRow);
      if (bps === 16 && le && contiguous && so[0] % 2 === 0 && so[0] + H * bytesRow <= buf.byteLength) {
        const u16 = new Uint16Array(buf, so[0], H * W);
        sample = (r, c) => u16[r * W + c];
      }
    }
    function readAt(base, c) {                                    // значение c-го отсчёта в строке, начинающейся с base
      if (bps === 16) return dv.getUint16(base + 2 * c, le);
      if (bps === 8) return dv.getUint8(base + c);
      const bit = c * bps, o = base + (bit >> 3), sh = bit & 7;   // упакованные 10/12/14 бит — big-endian поток битов (DNG)
      const v = (dv.getUint8(o) << 16) | ((dv.getUint8(o + 1) || 0) << 8) | (o + 2 < dv.byteLength ? dv.getUint8(o + 2) : 0);
      return (v >> (24 - sh - bps)) & ((1 << bps) - 1);
    }

    // активная область и кадрирование
    const aa = g(50829, [0, 0, H, W]);                            // top, left, bottom, right
    const dco = g(50719, [0, 0]), dcs = g(50720, [aa[3] - aa[1], aa[2] - aa[0]]);
    const top = aa[0] + Math.round(dco[1]), left = aa[1] + Math.round(dco[0]);
    const cw = Math.min(Math.round(dcs[0]), W - left), ch = Math.min(Math.round(dcs[1]), H - top);

    // чёрный/белый уровни (BlackLevel с повтором 2×2 или одно число), DeltaH/V не учитываем
    const blRep = g(50713, [1, 1]), bl = g(50714, [0]), wl = (g(50717, [(1 << bps) - 1]))[0];
    const black = (r, c) => bl.length >= 4 && blRep[0] === 2 ? bl[(r & 1) * 2 + (c & 1)] : bl[0];

    // GainMap: заранее считаем коэффициенты по строкам/колонкам (координаты — в активной области)
    const gm = parseGainMaps(ifd0.has(51009) ? ifd0.get(51009).raw : T.has(51009) ? T.get(51009).raw : null)
      .filter(m => m.mapPlanes >= 1 && m.pv >= 1 && m.ph >= 1);
    const gmFor = (r, c) => {                                     // r, c — в координатах активной области
      for (const m of gm) if (r >= m.top && r < m.bottom && c >= m.left && c < m.right &&
        (r - m.top) % m.rowPitch === 0 && (c - m.left) % m.colPitch === 0) return m;
      return null;
    };
    // быстрый путь: 4 карты (по фазам байера, шаг 2) на всю область — таблицы индексов/весов по строкам и колонкам
    const byPhase = gm.length === 4 && gm.every(m => m.rowPitch === 2 && m.colPitch === 2 && m.top < 2 && m.left < 2) ? [] : null;
    if (byPhase) for (const m of gm) {
      const Hn = m.bottom - m.top, Wn = m.right - m.left, rows = Math.max(0, aa[2] - aa[0]), cols = Math.max(0, aa[3] - aa[1]);
      const rv0 = new Int32Array(rows), rv1 = new Int32Array(rows), rfv = new Float32Array(rows);
      for (let r = 0; r < rows; r++) { let v = ((r - m.top) / Math.max(1, Hn) - m.ov) / (m.sv || 1); v = Math.min(Math.max(v, 0), m.pv - 1); rv0[r] = Math.floor(v); rv1[r] = Math.min(rv0[r] + 1, m.pv - 1); rfv[r] = v - rv0[r]; }
      const ch0 = new Int32Array(cols), ch1 = new Int32Array(cols), cfh = new Float32Array(cols);
      for (let c = 0; c < cols; c++) { let h = ((c - m.left) / Math.max(1, Wn) - m.oh) / (m.sh || 1); h = Math.min(Math.max(h, 0), m.ph - 1); ch0[c] = Math.floor(h); ch1[c] = Math.min(ch0[c] + 1, m.ph - 1); cfh[c] = h - ch0[c]; }
      byPhase[(m.top & 1) * 2 + (m.left & 1)] = { m, rv0, rv1, rfv, ch0, ch1, cfh };
    }
    const gainFast = (r, c) => {
      const t = byPhase[(r & 1) * 2 + (c & 1)]; if (!t) return 1;
      const m = t.m, P = m.mapPlanes, ph = m.ph, G = m.gain, a = t.rv0[r], b = t.rv1[r], fv = t.rfv[r], x0 = t.ch0[c], x1 = t.ch1[c], fh = t.cfh[c];
      return (G[(a * ph + x0) * P] * (1 - fh) + G[(a * ph + x1) * P] * fh) * (1 - fv) + (G[(b * ph + x0) * P] * (1 - fh) + G[(b * ph + x1) * P] * fh) * fv;
    };
    const gain = (m, r, c) => {
      const v = ((r - m.top) / Math.max(1, m.bottom - m.top) - m.ov) / (m.sv || 1);
      const h = ((c - m.left) / Math.max(1, m.right - m.left) - m.oh) / (m.sh || 1);
      const vi = Math.min(Math.max(v, 0), m.pv - 1), hi = Math.min(Math.max(h, 0), m.ph - 1);
      const v0 = Math.floor(vi), h0 = Math.floor(hi), v1 = Math.min(v0 + 1, m.pv - 1), h1 = Math.min(h0 + 1, m.ph - 1), fv = vi - v0, fh = hi - h0, P = m.mapPlanes;
      const G = (a, b) => m.gain[(a * m.ph + b) * P];
      return (G(v0, h0) * (1 - fh) + G(v0, h1) * fh) * (1 - fv) + (G(v1, h0) * (1 - fh) + G(v1, h1) * fh) * fv;
    };

    // баланс белого и цвет
    const neutral = g(50728, null);
    const wb = neutral ? [1 / neutral[0], 1 / neutral[1], 1 / neutral[2]] : [1, 1, 1];
    const wbn = wb.map(x => x / wb[1]);
    const ill1 = (g(50778, [0]))[0], ill2 = (g(50779, [0]))[0];
    const fm = (ill2 === 21 || ill2 === 23) && T.has(50965) || ifd0.has(50965) && (ill2 === 21 || ill2 === 23) ? g(50965) : g(50964, null);
    let cam2srgb = null;
    if (fm && fm.length === 9) {
      // ForwardMatrix отображает «нейтрализованные» данные камеры в XYZ D50; нормируем, чтобы белый остался белым
      const m = mul3(XYZD50_TO_SRGB, fm), s = [0, 1, 2].map(r => m[r * 3] + m[r * 3 + 1] + m[r * 3 + 2]);
      cam2srgb = m.map((x, i) => x / s[Math.floor(i / 3)]);
    } else {
      const cm = g(50721, null), ci = cm && cm.length === 9 ? inv3(cm) : null;      // запасной путь: ColorMatrix1⁻¹
      if (ci) { const m = mul3(XYZD50_TO_SRGB, ci), s = [0, 1, 2].map(r => m[r * 3] + m[r * 3 + 1] + m[r * 3 + 2]); cam2srgb = m.map((x, i) => x / s[Math.floor(i / 3)]); }
    }

    // бининг 2×2 → линейные RGB (баланс белого и GainMap уже применены)
    const ow = Math.floor(cw / 2 / step), oh = Math.floor(ch / 2 / step);
    const lin = new Float32Array(ow * oh * 3);
    const colorAt = [pat[0], pat[1], pat[2], pat[3]];             // 0=R 1=G 2=B для (r&1, c&1) от начала CFA
    const aTop = top - aa[0], aLeft = left - aa[1];              // смещение кадрирования внутри активной области
    for (let y = 0; y < oh; y++) {
      for (let x = 0; x < ow; x++) {
        const r0 = top + y * 2 * step, c0 = left + x * 2 * step;
        let R = 0, G = 0, B = 0, nG = 0;
        for (let dy = 0; dy < 2; dy++) for (let dx = 0; dx < 2; dx++) {
          const r = r0 + dy, c = c0 + dx;
          let v = (sample(r, c) - black(r, c)) / (wl - black(r, c));
          if (byPhase) v *= gainFast(r - aa[0], c - aa[1]);
          else if (gm.length) { const ar = r - aa[0], ac = c - aa[1], m = gmFor(ar, ac); if (m) v *= gain(m, ar, ac); }
          const col = colorAt[((r - aa[0]) & 1) * 2 + ((c - aa[1]) & 1)];
          if (col === 0) R += v; else if (col === 2) B += v; else { G += v; nG++; }
        }
        const i = (y * ow + x) * 3;
        lin[i] = Math.min(Math.max(R * wbn[0], 0), 1);           // ограничение после ББ: пересвет остаётся белым, а не розовым
        lin[i + 1] = Math.min(Math.max(G / (nG || 1) * wbn[1], 0), 1);
        lin[i + 2] = Math.min(Math.max(B * wbn[2], 0), 1);
      }
    }
    void aTop; void aLeft;

    // цвет → sRGB (линейный); яркость для автоэкспозиции
    const n = ow * oh, lum = new Float32Array(n);
    for (let k = 0, i = 0; k < n; k++, i += 3) {
      let r = lin[i], gg = lin[i + 1], b = lin[i + 2];
      if (cam2srgb) {
        const m = cam2srgb;
        const R = m[0] * r + m[1] * gg + m[2] * b, G = m[3] * r + m[4] * gg + m[5] * b, Bb = m[6] * r + m[7] * gg + m[8] * b;
        r = R; gg = G; b = Bb;
      }
      lin[i] = Math.max(r, 0); lin[i + 1] = Math.max(gg, 0); lin[i + 2] = Math.max(b, 0);
      lum[k] = 0.2126 * lin[i] + 0.7152 * lin[i + 1] + 0.0722 * lin[i + 2];
    }
    // автоэкспозиция: средний логарифм яркости → «средне-серый» 0.18; ограничиваем, чтобы не пересветить
    let sl = 0, cnt = 0;
    for (let k = 0; k < n; k += 7) { sl += Math.log(lum[k] + 1e-4); cnt++; }
    const baseline = Math.pow(2, (g(50730, [0]))[0] || 0);
    const key = Math.exp(sl / Math.max(1, cnt));
    const sorted = Float32Array.from({ length: Math.ceil(n / 13) }, (_, j) => lum[j * 13] || 0).sort();
    const p99 = sorted[Math.floor(sorted.length * 0.995)] || 1;
    const expo = Math.min(Math.max(0.18 / Math.max(key, 1e-4), 1), 6, 3 / Math.max(p99, 1e-4)) * baseline;
    const Wt = Math.max(p99 * expo, 1);                           // «белая точка» тональной кривой
    const out = new Uint8ClampedArray(n * 4);
    const toS = (x) => { x = x * (1 + x / (Wt * Wt)) / (1 + x); return 255 * (x <= 0.0031308 ? 12.92 * x : 1.055 * Math.pow(x, 1 / 2.4) - 0.055); };
    for (let k = 0, i = 0, o = 0; k < n; k++, i += 3, o += 4) {
      out[o] = toS(lin[i] * expo); out[o + 1] = toS(lin[i + 1] * expo); out[o + 2] = toS(lin[i + 2] * expo); out[o + 3] = 255;
    }
    return { width: ow, height: oh, data: out, orientation: (ifd0.get(274) || [1])[0], info: { W, H, bps, gainMaps: gm.length, expo: +expo.toFixed(2), wb: wbn.map(x => +x.toFixed(3)) } };
  }

  // Есть ли в файле CFA-данные без сжатия (чтобы не читать файл впустую)
  globalThis.RawDNG = { decode, parseTiff };
})();
