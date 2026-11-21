/* Фоновый поток: проявка DNG (lib/rawdng.js) → поворот по EXIF → JPEG. Сообщение: { id, buf, step, quality } */
importScripts('rawdng.js');
self.onmessage = async (ev) => {
  const { id, buf, step, quality } = ev.data;
  try {
    const r = RawDNG.decode(buf, { step });
    const src = new OffscreenCanvas(r.width, r.height);
    src.getContext('2d').putImageData(new ImageData(r.data, r.width, r.height), 0, 0);
    const o = r.orientation, rot = o >= 5 && o <= 8;
    const dst = new OffscreenCanvas(rot ? r.height : r.width, rot ? r.width : r.height), g = dst.getContext('2d');
    g.translate(dst.width / 2, dst.height / 2);
    if (o === 3) g.rotate(Math.PI); else if (o === 6) g.rotate(Math.PI / 2); else if (o === 8) g.rotate(-Math.PI / 2);
    g.drawImage(src, -r.width / 2, -r.height / 2);
    const blob = await dst.convertToBlob({ type: 'image/jpeg', quality: quality || 0.9 });
    self.postMessage({ id, blob, w: dst.width, h: dst.height, info: r.info });
  } catch (e) {
    self.postMessage({ id, error: e.message || String(e) });
  }
};
