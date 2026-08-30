// המרת PNG ל-PDF, ללא תלויות חיצוניות (zlib מובנה בלבד).
//
// הרקע: פייפרלס — יעד ההעברה של הוצאות — מקבל JPG או PDF בלבד, ודוחה PNG.
// הדחייה מגיעה כמייל נפרד אליו, לא אלינו: אצלנו השליחה נרשמה כמוצלחת והמסמך
// פשוט לא הגיע. לכן מסמך שאינו בפורמט קביל מומר לפני השליחה ולא נשלח כמות שהוא.
//
// PDF תומך בתמונה מקודדת Flate עם דגימות גולמיות. PNG הוא Flate של שורות
// מסוננות, ולכן צריך לפרוס: inflate → ביטול הסינון → RGB גולמי → deflate מחדש.
import zlib from 'node:zlib';

const PNG_SIG = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
export const isPng = (buf) => Buffer.isBuffer(buf) && buf.length > 8 && buf.subarray(0, 8).equals(PNG_SIG);

function readChunks(buf) {
  const out = { idat: [], plte: null, trns: null, ihdr: null };
  let pos = 8;
  while (pos + 8 <= buf.length) {
    const len = buf.readUInt32BE(pos);
    const type = buf.toString('ascii', pos + 4, pos + 8);
    const data = buf.subarray(pos + 8, pos + 8 + len);
    if (type === 'IHDR') out.ihdr = { width: data.readUInt32BE(0), height: data.readUInt32BE(4),
      bitDepth: data[8], colorType: data[9], interlace: data[12] };
    else if (type === 'IDAT') out.idat.push(data);
    else if (type === 'PLTE') out.plte = Buffer.from(data);
    else if (type === 'tRNS') out.trns = Buffer.from(data);
    else if (type === 'IEND') break;
    pos += 12 + len;   // אורך + סוג + נתונים + CRC
  }
  return out;
}

const CHANNELS = { 0: 1, 2: 3, 3: 1, 4: 2, 6: 4 };

// ביטול סינון השורות של PNG. כל שורה נפתחת בבייט סוג הסינון.
function unfilter(raw, width, height, bpp, stride) {
  const out = Buffer.alloc(height * stride);
  let pos = 0;
  for (let y = 0; y < height; y++) {
    const ft = raw[pos++];
    const row = raw.subarray(pos, pos + stride); pos += stride;
    const cur = out.subarray(y * stride, (y + 1) * stride);
    const prev = y > 0 ? out.subarray((y - 1) * stride, y * stride) : null;
    for (let x = 0; x < stride; x++) {
      const a = x >= bpp ? cur[x - bpp] : 0;
      const b = prev ? prev[x] : 0;
      const c = (prev && x >= bpp) ? prev[x - bpp] : 0;
      let v = row[x];
      if (ft === 1) v += a;
      else if (ft === 2) v += b;
      else if (ft === 3) v += (a + b) >> 1;
      else if (ft === 4) {                       // Paeth
        const p = a + b - c, pa = Math.abs(p - a), pb = Math.abs(p - b), pc = Math.abs(p - c);
        v += (pa <= pb && pa <= pc) ? a : (pb <= pc ? b : c);
      } else if (ft !== 0) throw new Error('סוג סינון PNG לא נתמך: ' + ft);
      cur[x] = v & 0xff;
    }
  }
  return out;
}

// המרה ל-RGB. ערוץ שקיפות מומזג על רקע לבן — PDF כאן בלי מסכה.
function toRgb(px, { width, height, colorType }, plte, stride) {
  const rgb = Buffer.alloc(width * height * 3);
  let o = 0;
  for (let y = 0; y < height; y++) {
    const row = px.subarray(y * stride, (y + 1) * stride);
    for (let x = 0; x < width; x++) {
      let r, g, b, a = 255;
      if (colorType === 0) { r = g = b = row[x]; }
      else if (colorType === 4) { r = g = b = row[x * 2]; a = row[x * 2 + 1]; }
      else if (colorType === 2) { r = row[x * 3]; g = row[x * 3 + 1]; b = row[x * 3 + 2]; }
      else if (colorType === 6) { r = row[x * 4]; g = row[x * 4 + 1]; b = row[x * 4 + 2]; a = row[x * 4 + 3]; }
      else if (colorType === 3) { const i = row[x] * 3; r = plte[i]; g = plte[i + 1]; b = plte[i + 2]; }
      else throw new Error('סוג צבע PNG לא נתמך: ' + colorType);
      if (a !== 255) { const t = a / 255; r = Math.round(r * t + 255 * (1 - t)); g = Math.round(g * t + 255 * (1 - t)); b = Math.round(b * t + 255 * (1 - t)); }
      rgb[o++] = r; rgb[o++] = g; rgb[o++] = b;
    }
  }
  return rgb;
}

export function pngToPdf(buf) {
  if (!isPng(buf)) throw new Error('אינו קובץ PNG');
  const { ihdr, idat, plte } = readChunks(buf);
  if (!ihdr) throw new Error('PNG פגום — חסר IHDR');
  if (ihdr.interlace) throw new Error('PNG משולב (interlaced) אינו נתמך');
  if (ihdr.bitDepth !== 8) throw new Error('עומק צבע ' + ihdr.bitDepth + ' אינו נתמך');
  if (ihdr.colorType === 3 && !plte) throw new Error('PNG עם פלטה בלי PLTE');
  const ch = CHANNELS[ihdr.colorType];
  if (!ch) throw new Error('סוג צבע PNG לא נתמך: ' + ihdr.colorType);
  const stride = ihdr.width * ch;
  const raw = zlib.inflateSync(Buffer.concat(idat));
  const px = unfilter(raw, ihdr.width, ihdr.height, ch, stride);
  const rgb = toRgb(px, ihdr, plte, stride);
  const img = zlib.deflateSync(rgb, { level: 9 });

  // עמוד A4 עם התמונה ממורכזת ומוקטנת לשוליים
  const PW = 595.28, PH = 841.89, M = 20;
  const scale = Math.min((PW - M * 2) / ihdr.width, (PH - M * 2) / ihdr.height, 1);
  const w = +(ihdr.width * scale).toFixed(2), h = +(ihdr.height * scale).toFixed(2);
  const x = +((PW - w) / 2).toFixed(2), y = +((PH - h) / 2).toFixed(2);
  const content = Buffer.from(`q\n${w} 0 0 ${h} ${x} ${y} cm\n/Im0 Do\nQ\n`, 'latin1');

  const objs = [
    '<< /Type /Catalog /Pages 2 0 R >>',
    '<< /Type /Pages /Kids [3 0 R] /Count 1 >>',
    `<< /Type /Page /Parent 2 0 R /MediaBox [0 0 ${PW} ${PH}] /Resources << /XObject << /Im0 5 0 R >> >> /Contents 4 0 R >>`,
    { stream: content, dict: `<< /Length ${content.length} >>` },
    { stream: img, dict: `<< /Type /XObject /Subtype /Image /Width ${ihdr.width} /Height ${ihdr.height} /ColorSpace /DeviceRGB /BitsPerComponent 8 /Filter /FlateDecode /Length ${img.length} >>` },
  ];
  const parts = [Buffer.from('%PDF-1.4\n', 'latin1')];
  const offsets = [];
  let pos = parts[0].length;
  objs.forEach((o, i) => {
    offsets.push(pos);
    const head = Buffer.from(`${i + 1} 0 obj\n${typeof o === 'string' ? o : o.dict}\n`, 'latin1');
    const body = typeof o === 'string' ? Buffer.alloc(0)
      : Buffer.concat([Buffer.from('stream\n', 'latin1'), o.stream, Buffer.from('\nendstream\n', 'latin1')]);
    const tail = Buffer.from('endobj\n', 'latin1');
    parts.push(head, body, tail);
    pos += head.length + body.length + tail.length;
  });
  let xref = `xref\n0 ${objs.length + 1}\n0000000000 65535 f \n`;
  for (const off of offsets) xref += String(off).padStart(10, '0') + ' 00000 n \n';
  xref += `trailer\n<< /Size ${objs.length + 1} /Root 1 0 R >>\nstartxref\n${pos}\n%%EOF\n`;
  parts.push(Buffer.from(xref, 'latin1'));
  return Buffer.concat(parts);
}

// הפורמטים שפייפרלס מקבל. כל השאר חייב המרה לפני שליחה.
export const ACCEPTED = /(pdf|jpe?g)/i;
export function toAcceptable(buf, contentType) {
  if (ACCEPTED.test(String(contentType || ''))) return { buf, contentType, ext: /pdf/i.test(contentType) ? 'pdf' : 'jpg', converted: false };
  if (isPng(buf)) return { buf: pngToPdf(buf), contentType: 'application/pdf', ext: 'pdf', converted: true };
  throw new Error('פורמט לא נתמך להעברה: ' + (contentType || 'לא ידוע'));
}

export default { isPng, pngToPdf, toAcceptable, ACCEPTED };
