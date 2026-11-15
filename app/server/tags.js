'use strict';
/**
 * 轻量标签读取器（ID3v2 / Vorbis Comment）。
 *
 * 为什么要自己解析：`music-metadata` 按 ID3 声明的编码解码，遇到编码字节与实际
 * 内容不符的中文标签（国内很常见）会直接产出丢失信息的字符串，事后无法还原。
 * 这里拿到原始字节，按"多种编码各解一次、挑最像人话的结果"来兜底。
 */

const fs = require('fs');
const iconv = require('iconv-lite');

const TAG_READ_BYTES = 512 * 1024;   // 只读文件头，足够覆盖标签区

/** 简繁/日韩/英文都算"像人话"，替换符和控制符扣分 */
function scoreText(s) {
  if (!s) return -1e9;
  let score = 0;
  for (const ch of s) {
    const c = ch.codePointAt(0);
    if (c === 0xfffd) score -= 50;
    else if (c < 0x20 && c !== 0x09) score -= 30;
    else if (c >= 0x4e00 && c <= 0x9fff) score += 10;      // 汉字
    else if (c >= 0x3040 && c <= 0x30ff) score += 8;       // 假名
    else if (c >= 0xac00 && c <= 0xd7af) score += 6;       // 韩文
    else if (c >= 0x20 && c <= 0x7e) score += 2;           // ASCII
    else if (c >= 0x3000 && c <= 0x303f) score += 3;       // 中文标点
    else if (c >= 0x80 && c <= 0xff) score -= 2;           // 拉丁高位
    else score += 1;
  }
  return score / Math.max(1, s.length);
}

function bestText(candidates) {
  let best = null;
  let bestScore = -1e9;
  for (const raw of candidates) {
    if (!raw) continue;
    const s = String(raw).replace(/\u0000+$/g, '').trim();
    if (!s) continue;
    const sc = scoreText(s);
    if (sc > bestScore) {
      bestScore = sc;
      best = s;
    }
  }
  return bestScore > -5 ? best : null;
}

/* ------------------------------- ID3v2 ------------------------------- */

function decodeId3Text(buf, enc) {
  const body = Buffer.from(buf);
  const cands = [];

  if (enc === 1 || enc === 2) {
    if (body.length >= 2) {
      const b0 = body[0];
      const b1 = body[1];
      if (b0 === 0xff && b1 === 0xfe) {
        cands.push(iconv.decode(body.subarray(2), 'utf16le'));
      } else if (b0 === 0xfe && b1 === 0xff) {
        cands.push(iconv.decode(body.subarray(2), 'utf16be'));
      }
    }
    cands.push(iconv.decode(body, 'utf16le'));
    cands.push(iconv.decode(body, 'utf16be'));
    cands.push(iconv.decode(body, 'gb18030'));
  } else if (enc === 3) {
    cands.push(body.toString('utf8'));
    cands.push(iconv.decode(body, 'gb18030'));
    cands.push(iconv.decode(body, 'big5'));
  } else {
    cands.push(iconv.decode(body, 'latin1'));
    cands.push(iconv.decode(body, 'gb18030'));
    cands.push(iconv.decode(body, 'big5'));
    cands.push(body.toString('utf8'));
  }
  // 多值用 NUL 分隔，取第一段
  return bestText(cands.map((s) => (s || '').split('\u0000')[0]));
}

function readId3v2(buf) {
  if (buf.length < 10) return null;
  if (buf.toString('latin1', 0, 3) !== 'ID3') return null;

  const major = buf[3];
  const flags = buf[5];
  const size =
    ((buf[6] & 0x7f) << 21) |
    ((buf[7] & 0x7f) << 14) |
    ((buf[8] & 0x7f) << 7) |
    (buf[9] & 0x7f);

  let pos = 10;
  // 扩展头
  if (flags & 0x40) {
    if (pos + 4 > buf.length) return null;
    const extSize = major === 4
      ? ((buf[pos] & 0x7f) << 21) | ((buf[pos + 1] & 0x7f) << 14) | ((buf[pos + 2] & 0x7f) << 7) | (buf[pos + 3] & 0x7f)
      : buf.readUInt32BE(pos);
    pos += extSize;
  }

  const end = Math.min(buf.length, 10 + size);
  const out = {};
  const idLen = major === 2 ? 3 : 4;

  while (pos + idLen + 4 <= end) {
    const id = buf.toString('latin1', pos, pos + idLen);
    if (!/^[A-Z0-9]{3,4}$/.test(id)) break;   // 到了填充区

    let frameSize;
    if (major === 2) {
      frameSize = (buf[pos + 3] << 16) | (buf[pos + 4] << 8) | buf[pos + 5];
    } else if (major === 4) {
      const p = pos + 4;
      frameSize =
        ((buf[p] & 0x7f) << 21) |
        ((buf[p + 1] & 0x7f) << 14) |
        ((buf[p + 2] & 0x7f) << 7) |
        (buf[p + 3] & 0x7f);
    } else {
      frameSize = buf.readUInt32BE(pos + 4);
    }
    const headerLen = major === 2 ? 6 : 10;
    const dataStart = pos + headerLen;
    if (frameSize <= 0 || dataStart + frameSize > end) break;

    const key = { TIT2: 'title', TT2: 'title', TPE1: 'artist', TP1: 'artist', TALB: 'album', TAL: 'album' }[id];
    if (key && !out[key]) {
      const data = buf.subarray(dataStart, dataStart + frameSize);
      if (data.length > 1) {
        const text = decodeId3Text(data.subarray(1), data[0]);
        if (text) out[key] = text;
      }
    }
    pos = dataStart + frameSize;
  }
  return Object.keys(out).length ? out : null;
}

/* --------------------------- Vorbis Comment --------------------------- */

function strictUtf8(buf) {
  try {
    return new TextDecoder('utf-8', { fatal: true }).decode(buf);
  } catch {
    return null;
  }
}

function decodeVorbisValue(buf) {
  // WAV 的 INFO 字段常带尾部 NUL，统一清掉
  const clean = (s) => (s == null ? s : String(s).replace(/\u0000/g, '').trim()) || null;
  const utf8 = strictUtf8(buf);
  if (utf8) return clean(utf8);
  return clean(bestText([iconv.decode(buf, 'gb18030'), iconv.decode(buf, 'big5'), iconv.decode(buf, 'latin1')]));
}

function readVorbisComments(buf) {
  if (buf.length < 4) return null;
  if (buf.toString('latin1', 0, 4) !== 'fLaC') return null;

  let pos = 4;
  while (pos + 4 <= buf.length) {
    const header = buf[pos];
    const type = header & 0x7f;
    const last = (header & 0x80) !== 0;
    const size = (buf[pos + 1] << 16) | (buf[pos + 2] << 8) | buf[pos + 3];
    const start = pos + 4;
    const stop = start + size;
    if (stop > buf.length) break;

    if (type === 4) {
      let p = start;
      if (p + 4 > stop) return null;
      const vendorLen = buf.readUInt32LE(p);
      p += 4 + vendorLen;
      if (p + 4 > stop) return null;
      const count = buf.readUInt32LE(p);
      p += 4;

      const out = {};
      for (let i = 0; i < count && p + 4 <= stop; i++) {
        const len = buf.readUInt32LE(p);
        p += 4;
        if (p + len > stop) break;
        const entry = buf.subarray(p, p + len);
        p += len;
        const eq = entry.indexOf(0x3d);
        if (eq <= 0) continue;
        const key = entry.toString('latin1', 0, eq).toLowerCase();
        const value = decodeVorbisValue(entry.subarray(eq + 1));
        if (!value) continue;
        if (key === 'title' && !out.title) out.title = value;
        if (key === 'artist' && !out.artist) out.artist = value;
        if (key === 'album' && !out.album) out.album = value;
      }
      return Object.keys(out).length ? out : null;
    }
    if (last) break;
    pos = stop;
  }
  return null;
}

/* ------------------------------ WAV RIFF ------------------------------ */

/**
 * WAV 的 LIST/INFO 块。
 *
 * 规范里这些字段是 ASCII，但国内下载的 WAV 普遍塞的是 UTF-8（甚至 GBK），
 * 解析库按规范读就会得到 `e\u0011(f` 这种鬼东西。这里直接读原始字节按多编码试。
 */
function readRiffInfo(buf) {
  if (buf.length < 12) return null;
  if (buf.toString('latin1', 0, 4) !== 'RIFF') return null;
  if (buf.toString('latin1', 8, 12) !== 'WAVE') return null;

  const out = {};
  let pos = 12;

  while (pos + 8 <= buf.length) {
    const id = buf.toString('latin1', pos, pos + 4);
    const size = buf.readUInt32LE(pos + 4);
    const start = pos + 8;
    const stop = Math.min(buf.length, start + size);
    if (stop <= start) break;

    if (id === 'LIST' && buf.toString('latin1', start, start + 4) === 'INFO') {
      let p = start + 4;
      while (p + 8 <= stop) {
        const sid = buf.toString('latin1', p, p + 4);
        const ssize = buf.readUInt32LE(p + 4);
        const s0 = p + 8;
        const s1 = Math.min(stop, s0 + ssize);
        if (s1 > s0) {
          const val = decodeVorbisValue(buf.subarray(s0, s1));
          if (val) {
            if (sid === 'INAM' && !out.title) out.title = val;
            if (sid === 'IART' && !out.artist) out.artist = val;
            if ((sid === 'IPRD' || sid === 'IALB') && !out.album) out.album = val;
          }
        }
        p = s0 + ssize + (ssize & 1);
      }
    } else if (id === 'id3 ' || id === 'ID3 ') {
      const id3 = readId3v2(buf.subarray(start, stop));
      if (id3) {
        if (id3.title && !out.title) out.title = id3.title;
        if (id3.artist && !out.artist) out.artist = id3.artist;
        if (id3.album && !out.album) out.album = id3.album;
      }
    }

    pos = start + size + (size & 1);
  }
  return Object.keys(out).length ? out : null;
}

/* ------------------------------- 入口 ------------------------------- */

async function readTags(filePath) {
  let fh;
  try {
    // 用异步 I/O：扫描大 WAV 时不能阻塞事件循环，否则网关会超时断开
    fh = await fs.promises.open(filePath, 'r');
    const buf = Buffer.alloc(TAG_READ_BYTES);
    const { bytesRead } = await fh.read(buf, 0, TAG_READ_BYTES, 0);
    const head = buf.subarray(0, bytesRead);

    if (head.toString('latin1', 0, 4) === 'RIFF') return readRiffInfo(head);
    if (head.toString('latin1', 0, 3) === 'ID3') return readId3v2(head);
    if (head.toString('latin1', 0, 4) === 'fLaC') return readVorbisComments(head);
    // MP3 无 ID3 标签、或其它格式：交给上层
    return null;
  } catch {
    return null;
  } finally {
    if (fh) {
      try { await fh.close(); } catch { /* ignore */ }
    }
  }
}

module.exports = { readTags, scoreText };
