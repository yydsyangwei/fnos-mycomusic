#!/usr/bin/env node
/**
 * 我的音乐库 —— 飞牛 fnOS 应用后端
 *
 * 设计要点：
 *  - 只读用户明确授权的目录（TRIM_DATA_ACCESSIBLE_PATHS），所有带路径的接口都做白名单校验
 *  - 曲库索引存 TRIM_PKGVAR（内部数据，不进用户可见的共享目录）
 *  - 走统一网关（Unix Socket）时不用额外端口，登录态由 fnOS 负责
 *  - 音频流全程 createReadStream + Range，不把大文件读进内存
 */

const http = require('http');
const fs = require('fs');
const fsp = fs.promises;
const path = require('path');
const crypto = require('crypto');

// ------------------------------------------------------------------ 环境

const ENV = process.env;
const PKGVAR = ENV.TRIM_PKGVAR || path.join(__dirname, '.runtime');
const PKGETC = ENV.TRIM_PKGETC || path.join(__dirname, '.config');
const DATA_SHARE = ENV.TRIM_DATA_SHARE_PATHS || '';
const SOCKET_PATH = ENV.SOCKET_PATH || '';
const PORT = Number(ENV.PORT || 5001);
const GATEWAY_PREFIX = (ENV.GATEWAY_PREFIX || '').replace(/\/$/, '');
/** 需要剥离的路径前缀：环境变量优先，否则按约定兜底 */
const PREFIXES = [...new Set([GATEWAY_PREFIX, '/app/mycomusic'].filter(Boolean))];
const PUBLIC_DIR = path.join(__dirname, 'public');

/** 索引结构版本：改了标签解析方式就 +1，旧索引自动作废重扫 */
const INDEX_VERSION = 6;

const LIBRARY_FILE = path.join(PKGETC, 'libraries.json');
const INDEX_FILE = path.join(PKGVAR, 'index.json');
const COVER_DIR = path.join(PKGVAR, 'covers');
const ACCESS_LOG = path.join(PKGVAR, 'access.log');

const AUDIO_EXT = new Set([
  'mp3', 'flac', 'wav', 'm4a', 'aac', 'ogg', 'oga', 'opus', 'wma', 'ape'
]);

/**
 * 拆分冒号分隔的路径列表。
 *
 * fnOS 用 ":" 分隔多个路径，但 Windows 下 "E:\music" 的盘符本身就带冒号，
 * 直接 split 会被切坏（本地开发调试时会踩到）。这里把"单字母段 + 后一段"
 * 重新拼起来，Linux 上行为不变。
 */
function splitPaths(raw) {
  const parts = String(raw || '').split(':');
  const out = [];
  for (let i = 0; i < parts.length; i++) {
    const p = parts[i];
    if (/^[A-Za-z]$/.test(p) && i + 1 < parts.length) {
      out.push(p + ':' + parts[i + 1]);
      i++;
    } else if (p) {
      out.push(p);
    }
  }
  return out;
}

/** 用户授权的可访问目录 */
function accessibleRoots() {
  return splitPaths(ENV.TRIM_DATA_ACCESSIBLE_PATHS)
    .map((s) => s.trim())
    .filter(Boolean)
    .map((s) => path.resolve(s));
}

// ------------------------------------------------------------------ 状态

let libraries = [];        // 已添加的音乐库根目录
let index = [];            // [{id, path, size, mtime, title, artist, album, duration, hasCover}]
let indexById = new Map();
let scanState = { running: false, scanned: 0, total: 0, added: 0, removed: 0, current: '', error: null };
let mm = null;             // music-metadata（懒加载）

async function loadState() {
  // 访问日志超过 2MB 就清空，避免无限增长
  try {
    const st = await fsp.stat(ACCESS_LOG);
    if (st.size > 2 * 1024 * 1024) await fsp.writeFile(ACCESS_LOG, '');
  } catch { /* 还没有日志文件 */ }

  await fsp.mkdir(PKGVAR, { recursive: true });
  await fsp.mkdir(PKGETC, { recursive: true });
  await fsp.mkdir(COVER_DIR, { recursive: true });
  await fsp.mkdir(LYRIC_DIR, { recursive: true });

  try {
    const raw = await fsp.readFile(LIBRARY_FILE, 'utf8');
    const parsed = JSON.parse(raw);
    libraries = Array.isArray(parsed.libraries) ? parsed.libraries : [];
  } catch {
    libraries = [];
  }
  try {
    const raw = await fsp.readFile(INDEX_FILE, 'utf8');
    const parsed = JSON.parse(raw);
    index = (parsed.v === INDEX_VERSION && Array.isArray(parsed.songs)) ? parsed.songs : [];
  } catch {
    index = [];
  }
  rebuildIdMap();
  await loadFavorites();
}

function rebuildIdMap() {
  indexById = new Map(index.map((s) => [s.id, s]));
}

async function saveLibraries() {
  await fsp.writeFile(LIBRARY_FILE, JSON.stringify({ libraries }, null, 2), 'utf8');
}

async function saveIndex() {
  await fsp.writeFile(INDEX_FILE, JSON.stringify({ v: INDEX_VERSION, songs: index }, null, 0), 'utf8');
}

// ------------------------------------------------------------------ 安全

/** 把用户传进来的路径解析成绝对路径，并确保落在某个允许的根目录里 */
function safeResolve(input, roots) {
  if (typeof input !== 'string' || input.length === 0) return null;
  const abs = path.resolve(input);
  for (const root of roots) {
    if (abs === root) return abs;
    if (abs.startsWith(root + path.sep)) return abs;
  }
  return null;
}

/**
 * 授权校验（带 realpath）。
 *
 * fnOS 的「团队文件」「公共目录」等共享目录往往是指向存储池的软链接，
 * 直接比对字符串前缀会把合法路径判成越权。这里先按字面比，再按 realpath 比，
 * 两边都过不了才拒绝。
 */
async function resolveAllowed(input, roots) {
  const abs = safeResolve(input, roots);
  if (abs) return abs;

  if (typeof input !== 'string' || !input) return null;
  const real = await realpathSafe(path.resolve(input));
  if (!real) return null;

  for (const root of roots) {
    const rr = (await realpathSafe(root)) || root;
    if (real === rr || real.startsWith(rr + path.sep)) return real;
  }
  return null;
}

/** 允许访问的根：授权目录 ∪ 已添加的音乐库 */
function allowedRoots() {
  return [...new Set([...accessibleRoots(), ...libraries.map((p) => path.resolve(p))])];
}

async function realpathSafe(input) {
  try {
    return await fsp.realpath(input);
  } catch {
    return null;
  }
}

// ------------------------------------------------------------------ 编码修复

const iconv = require('iconv-lite');
const { readTags } = require('./tags');

/** 中日韩字符占比，用来判断哪种解码更像人话 */
function cjkRatio(s) {
  if (!s || !s.length) return 0;
  const cjk = (s.match(/[\u4e00-\u9fff\u3040-\u30ff\uac00-\ud7af]/g) || []).length;
  return cjk / s.length;
}

/** 出现这些迹象就认为标签解码错了 */
function looksBroken(s) {
  if (!s) return false;
  if (/[\uFFFD\u25A1\u25A0\u25A2]/.test(s)) return true;                 // 替换符 / 方块
  if (/[\u0000-\u0008\u000B\u000C\u000E-\u001F]/.test(s)) return true;   // 控制字符（UTF-16 误读的典型症状）
  const nonAscii = (s.match(/[^\x00-\x7F]/g) || []).length;
  if (nonAscii > 0 && cjkRatio(s) === 0) return true;                    // 有非 ASCII 但没有一个汉字
  return false;
}

/**
 * 修复中文标签乱码。
 *
 * 两种常见情况：
 *  1. GBK 字节被当 ISO-8859-1 读 → 高位字符一片，没有汉字
 *  2. UTF-16 字节被当 Latin-1 读 → 夹杂 NUL / 控制字符
 * 做法：按 Latin-1 取回原始字节，用几种编码各解一次，挑汉字占比最高的结果。
 */
function fixEncoding(s) {
  if (!s || !looksBroken(s)) return s;

  let buf;
  try {
    buf = Buffer.from(s, 'latin1');
  } catch {
    return s;
  }

  // 按"乱码特征"决定尝试顺序：
  //  - 夹杂 NUL / 控制字符 → 多半是 UTF-16 被当 Latin-1 读
  //  - 否则先试 UTF-8（UTF-8 字节被当 Latin-1 读也很常见），再试 GBK / Big5
  const hasControl = /[\u0000-\u0008\u000B\u000C\u000E-\u001F]/.test(s);
  const order = hasControl
    ? ['utf16le', 'utf16be', 'utf8', 'gb18030', 'gbk', 'big5']
    : ['utf8', 'gb18030', 'gbk', 'big5', 'utf16le', 'utf16be'];

  for (const enc of order) {
    let out;
    try {
      out = enc === 'utf8' ? buf.toString('utf8') : iconv.decode(buf, enc);
    } catch {
      continue;
    }
    if (!out || /[\uFFFD]/.test(out)) continue;
    if (/[\u0000-\u0008\u000B\u000C\u000E-\u001F]/.test(out)) continue;
    // 至少要有两成是汉字/日韩文字，否则说明解出来还是垃圾
    if (cjkRatio(out) >= 0.2) return out.trim();
  }
  return s;
}

/** 修完还是乱，就当没有这个字段 */
function cleanTag(s) {
  const fixed = fixEncoding(s || '').trim();
  if (!fixed) return '';
  return looksBroken(fixed) ? '' : fixed;
}

// ------------------------------------------------------------------ 标签可信度

function hasCJK(s) {
  return /[\u4e00-\u9fff]/.test(s || '');
}

function cjkChars(s) {
  return new Set((String(s || '').match(/[\u4e00-\u9fff]/g) || []));
}

function cjkOverlap(a, b) {
  const A = cjkChars(a);
  const B = cjkChars(b);
  if (!A.size || !B.size) return 0;
  let hit = 0;
  for (const c of A) if (B.has(c)) hit++;
  return hit;
}

/**
 * 标签是否可信。
 *
 * 有些文件的标签被写成了错误编码，解出来是"看起来像汉字、其实是乱码"的字符串，
 * 单看字符串判断不出来。这里拿文件名做参照：
 *   - 文件名里有汉字，标签里一个汉字都没有 → 不可信
 *   - 两边都有汉字，但**一个都不重合** → 不可信
 *   - 含替换符/方块 → 不可信
 */
function tagTrustWorthy(tag, fileName) {
  if (!tag) return false;
  if (/[\uFFFD\u25A1\u25A0\u25A2]/.test(tag)) return false;

  const fileHasCJK = hasCJK(fileName);
  const tagHasCJK = hasCJK(tag);

  if (fileHasCJK && tagHasCJK) {
    // 两边都有汉字，一个都不重合 → 标签是乱码
    return cjkOverlap(tag, fileName) > 0;
  }
  if (fileHasCJK && !tagHasCJK) {
    // 标签里没有汉字：纯 ASCII（英文歌手/歌名）可信；
    // 出现西里尔、韩文、注音、IPA 扩展这类字符，基本就是错编码解出来的垃圾
    return !/[\u0400-\u04FF\uAC00-\uD7AF\u0250-\u02FF\u1E00-\u1EFF\u0E00-\u0E7F]/.test(tag);
  }
  return true;
}

function idOf(filePath) {
  return crypto.createHash('sha1').update(filePath).digest('hex').slice(0, 16);
}

async function getMetadata(filePath) {
  if (!mm) mm = require('music-metadata');
  try {
    const meta = await mm.parseFile(filePath, { duration: true, skipCovers: false });
    const baseName = path.basename(filePath);

    // 先用自己的解析器读原始字节（能绕过编码字节写错的情况）
    const own = (await readTags(filePath)) || {};
    const rawTitle = own.title || meta.common?.title || '';
    const rawArtist = own.artist || meta.common?.artist || '';
    const rawAlbum = own.album || meta.common?.album || '';

    const title = cleanTag(rawTitle);
    const artist = cleanTag(rawArtist);
    const album = cleanTag(rawAlbum);

    // 标签不可信（编码坏了）就退回文件名：解析「歌手 - 歌名」
    let finalTitle = title;
    let finalArtist = artist;
    if (!finalTitle || !tagTrustWorthy(finalTitle, baseName)) finalTitle = '';
    if (!finalArtist || !tagTrustWorthy(finalArtist, baseName)) finalArtist = '';

    if (!finalTitle || !finalArtist) {
      const parsed = parseNamePair(baseName);
      if (!finalTitle) finalTitle = parsed.title;
      if (!finalArtist) finalArtist = parsed.artist;
    }

    return {
      title: finalTitle,
      artist: finalArtist,
      album: tagTrustWorthy(album, baseName) ? album : '',
      duration: meta.format?.duration ? Math.round(meta.format.duration) : 0,
      hasCover: Array.isArray(meta.common?.picture) && meta.common.picture.length > 0,
      rawTitle,
      rawArtist
    };
  } catch {
    const parsed = parseNamePair(path.basename(filePath));
    return { title: parsed.title, artist: parsed.artist, album: '', duration: 0, hasCover: false };
  }
}

/** 「BEYOND - 海阔天空.mp3」→ { artist: 'BEYOND', title: '海阔天空' } */
function parseNamePair(fileName) {
  const base = fileName
    .replace(/\.[^.]+$/, '')
    .replace(/^\d{1,3}[\s._-]+/, '')
    .trim();
  const m = /^(.*?)\s+[-–—]\s+(.*)$/.exec(base);
  if (m && m[1].trim() && m[2].trim()) {
    return { artist: m[1].trim(), title: m[2].trim() };
  }
  return { artist: '', title: base || fileName };
}

async function walk(dir, out, depth = 0) {
  if (depth > 16) return;
  let entries;
  try {
    entries = await fsp.readdir(dir, { withFileTypes: true });
  } catch {
    return;
  }
  for (const e of entries) {
    if (e.name.startsWith('.')) continue;
    const full = path.join(dir, e.name);
    if (e.isDirectory()) {
      await walk(full, out, depth + 1);
    } else if (e.isFile()) {
      const ext = e.name.substring(e.name.lastIndexOf('.') + 1).toLowerCase();
      if (AUDIO_EXT.has(ext)) out.push(full);
    }
  }
}

async function scanAll({ force = false } = {}) {
  if (scanState.running) return;
  scanState = { running: true, scanned: 0, total: 0, added: 0, removed: 0, current: '', error: null };

  try {
    const files = [];
    for (const lib of libraries) {
      const ok = safeResolve(lib, accessibleRoots());
      if (!ok) continue;
      await walk(ok, files);
    }

    scanState.total = files.length;
    const previous = new Map(index.map((s) => [s.path, s]));
    const next = [];

    for (const file of files) {
      scanState.current = file;
      scanState.scanned++;
      if (scanState.scanned % 10 === 0) await new Promise((r) => setImmediate(r));
      let st;
      try {
        st = await fsp.stat(file);
      } catch {
        continue;
      }
      const old = previous.get(file);
      if (!force && old && old.size === st.size && old.mtime === Math.floor(st.mtimeMs)) {
        next.push(old);           // 没变，直接复用（省掉解析开销）
        continue;
      }
      const meta = await getMetadata(file);
      const id = idOf(file);
      next.push({
        id,
        path: file,
        size: st.size,
        mtime: Math.floor(st.mtimeMs),
        title: meta.title || cleanName(path.basename(file)),
        rawTitle: meta.rawTitle || '',
        rawArtist: meta.rawArtist || '',
        artist: meta.artist || '',
        album: meta.album || '',
        duration: meta.duration,
        hasCover: meta.hasCover
      });
      scanState.added++;
    }

    scanState.removed = Math.max(0, index.length - next.filter((s) => previous.has(s.path)).length);
    index = next;
    rebuildIdMap();
    await saveIndex();
  } catch (e) {
    scanState.error = e.message || String(e);
  } finally {
    scanState.running = false;
    scanState.current = '';
  }
}

/** 文件名清洗成标题：歌手 - 歌名 */
function cleanName(base) {
  const noExt = base.replace(/\.[^.]+$/, '');
  return noExt.replace(/^\d{1,3}[\s._-]+/, '').trim() || base;
}

// ------------------------------------------------------------------ 歌词

/** 严格 UTF-8 解码，失败返回 null */
function strictUtf8(buf) {
  try { return new TextDecoder('utf-8', { fatal: true }).decode(buf); } catch { return null; }
}

const LYRIC_DIR = path.join(PKGVAR, 'lyrics');

/** 读本地 .lrc（UTF-8 优先，失败按 GB18030） */
async function readLocalLrc(songPath) {
  const base = songPath.replace(/\.[^.]+$/, '');
  for (const ext of ['.lrc', '.LRC', '.txt']) {
    const p = base + ext;
    try {
      const buf = await fsp.readFile(p);
      const utf8 = strictUtf8(buf);
      const text = utf8 || iconv.decode(buf, 'gb18030');
      if (text && /\[\d{1,2}:\d{2}/.test(text)) return { source: 'local', lrc: text };
      if (text && text.trim()) return { source: 'local', lrc: text };
    } catch { /* 没有这个文件 */ }
  }
  return null;
}

async function neteaseLyric(title, artist) {
  if (Date.now() < neteaseBlockedUntil) return null;
  const kw = `${artist} ${title}`.trim();
  const url = 'https://music.163.com/api/search/get/web?s=' + encodeURIComponent(kw) + '&type=1&offset=0&total=true&limit=8';
  const raw = await fetchText(url);
  if (!raw) return null;
  if (raw.includes('"code":405') || raw.includes('操作频繁')) {
    neteaseBlockedUntil = Date.now() + 90000;
    return null;
  }
  let songs;
  try {
    songs = JSON.parse(raw).result?.songs;
  } catch {
    return null;
  }
  if (!Array.isArray(songs) || !songs.length) return null;

  const best = pickBest(songs, title, artist, (s) => s.name, (s) => (s.artists || s.ar || []).map((a) => a.name));
  if (!best) return null;

  const detail = await fetchText(`https://music.163.com/api/song/lyric?id=${best.id}&lv=-1&kv=-1&tv=-1`);
  if (!detail) return null;
  try {
    const j = JSON.parse(detail);
    const lrc = j.lrc?.lyric || '';
    if (lrc && /\[\d{1,2}:\d{2}/.test(lrc)) return { source: '网易云', lrc };
  } catch { /* ignore */ }
  return null;
}

async function qqLyric(title, artist) {
  const kw = `${artist} ${title}`.trim();
  const sUrl = 'https://c.y.qq.com/soso/fcgi-bin/client_search_cp?format=json&n=8&p=1&w=' + encodeURIComponent(kw);
  const raw = await fetchText(sUrl, { Referer: 'https://y.qq.com/' });
  if (!raw) return null;
  let list;
  try {
    list = JSON.parse(raw).data?.song?.list;
  } catch {
    return null;
  }
  if (!Array.isArray(list) || !list.length) return null;

  const best = pickBest(list, title, artist, (s) => s.songname, (s) => (s.singer || []).map((g) => g.name));
  if (!best || !best.songmid) return null;

  const lUrl = 'https://c.y.qq.com/lyric/fcgi-bin/fcg_query_lyric_new.fcg?songmid=' +
    encodeURIComponent(best.songmid) + '&format=json&nobase64=1&g_tk=5381';
  const lraw = await fetchText(lUrl, { Referer: 'https://y.qq.com/portal/player.html' });
  if (!lraw) return null;
  try {
    let text = lraw.trim();
    if (!text.startsWith('{')) {
      const i = text.indexOf('{');
      if (i < 0) return null;
      text = text.slice(i, text.lastIndexOf('}') + 1);
    }
    const j = JSON.parse(text);
    let lyric = j.lyric || '';
    // 有的返回是 base64
    if (lyric && !/\[\d{1,2}:\d{2}/.test(lyric)) {
      try {
        const dec = Buffer.from(lyric, 'base64').toString('utf8');
        if (/\[\d{1,2}:\d{2}/.test(dec)) lyric = dec;
      } catch { /* ignore */ }
    }
    if (lyric && /\[\d{1,2}:\d{2}/.test(lyric)) return { source: 'QQ音乐', lrc: lyric };
  } catch { /* ignore */ }
  return null;
}

/** 在候选里挑最匹配的一条（歌名权重高，歌手做辅助） */
function pickBest(list, title, artist, nameOf, singersOf) {
  const wantTitle = norm(title);
  const wantArtist = norm(artist);
  let best = null;
  let bestScore = -1;
  for (const item of list.slice(0, 8)) {
    const t = similarity(wantTitle, norm(nameOf(item)));
    let score = t * (wantArtist ? 0.8 : 1);
    if (wantArtist) {
      const ap = Math.max(0, ...singersOf(item).map((n) => similarity(wantArtist, norm(n))));
      if (ap < 45 && t < 92) continue;
      score += ap * 0.2;
    }
    if (score > bestScore) {
      bestScore = score;
      best = item;
    }
  }
  return bestScore >= 60 ? best : null;
}

async function serveLyrics(res, song) {
  const cached = path.join(LYRIC_DIR, song.id + '.lrc');
  const send = (data) => json(res, 200, data);

  // 0) 缓存
  try {
    const text = await fsp.readFile(cached, 'utf8');
    return send({ source: 'cache', lrc: text });
  } catch { /* 没缓存 */ }

  // 1) 同目录 .lrc
  const local = await readLocalLrc(song.path);
  if (local) {
    await fsp.writeFile(cached, local.lrc, 'utf8').catch(() => {});
    return send(local);
  }

  // 2) 在线（串行，避免限流）
  const title = song.title || cleanName(path.basename(song.path));
  const artist = song.artist || '';
  const online = await enqueueOnline(async () => {
    return (await neteaseLyric(title, artist)) || (artist ? await neteaseLyric(title, '') : null)
      || (await qqLyric(title, artist)) || (artist ? await qqLyric(title, '') : null);
  });
  if (online) {
    await fsp.writeFile(cached, online.lrc, 'utf8').catch(() => {});
    return send(online);
  }

  return json(res, 404, { error: '没有找到歌词' });
}

// ------------------------------------------------------------------ 收藏 / 歌单

const STATE_FILE = path.join(PKGVAR, 'state.json');

/** 歌单存到用户可见的共享目录，标准 m3u8，别的播放器也能用 */
function playlistDir() {
  const share = splitPaths(DATA_SHARE)[0];
  return share ? path.join(share) : path.join(PKGVAR, 'playlists');
}

let favorites = new Set();

async function loadFavorites() {
  try {
    const raw = await fsp.readFile(STATE_FILE, 'utf8');
    const j = JSON.parse(raw);
    favorites = new Set(Array.isArray(j.favorites) ? j.favorites : []);
  } catch {
    favorites = new Set();
  }
}

async function saveFavorites() {
  await fsp.writeFile(STATE_FILE, JSON.stringify({ favorites: [...favorites] }, null, 0), 'utf8');
}

function safePlaylistName(name) {
  const n = String(name || '').trim().replace(/[\\/:*?"<>|]/g, '_').slice(0, 60);
  return n || '';
}

function playlistPath(name) {
  return path.join(playlistDir(), safePlaylistName(name) + '.m3u8');
}

async function listPlaylists() {
  const dir = playlistDir();
  await fsp.mkdir(dir, { recursive: true }).catch(() => {});
  const out = [];
  try {
    const files = await fsp.readdir(dir);
    for (const f of files) {
      if (!/\.m3u8?$/i.test(f)) continue;
      const p = path.join(dir, f);
      let count = 0;
      try {
        const text = await fsp.readFile(p, 'utf8');
        count = text.split(/\r?\n/).filter((l) => l && !l.startsWith('#')).length;
      } catch { /* ignore */ }
      out.push({ name: f.replace(/\.m3u8?$/i, ''), count });
    }
  } catch { /* 目录读不了 */ }
  return out.sort((a, b) => a.name.localeCompare(b.name, 'zh'));
}

async function readPlaylist(name) {
  try {
    const text = await fsp.readFile(playlistPath(name), 'utf8');
    const paths = text.split(/\r?\n/).filter((l) => l && !l.startsWith('#'));
    // 路径 → 歌曲 id
    const byPath = new Map(index.map((s) => [s.path, s.id]));
    return paths.map((p) => byPath.get(p)).filter(Boolean);
  } catch {
    return [];
  }
}

async function writePlaylist(name, songIds) {
  const dir = playlistDir();
  await fsp.mkdir(dir, { recursive: true }).catch(() => {});
  const lines = ['#EXTM3U', '#PLAYLIST:' + safePlaylistName(name)];
  for (const id of songIds) {
    const s = indexById.get(id);
    if (!s) continue;
    lines.push(`#EXTINF:${s.duration || -1},${s.artist ? s.artist + ' - ' : ''}${s.title}`);
    lines.push(s.path);
  }
  await fsp.writeFile(playlistPath(name), lines.join('\n') + '\n', 'utf8');
}

// ------------------------------------------------------------------ HTTP

function json(res, code, data) {
  const body = JSON.stringify(data);
  res.writeHead(code, {
    'Content-Type': 'application/json; charset=utf-8',
    'Content-Length': Buffer.byteLength(body),
    'Cache-Control': 'no-store'
  });
  res.end(body);
}

/**
 * 安全地把文件流写到响应。
 *
 * 手机端经常在加载图片/音频时直接中断连接，如果不管，写入已关闭的 socket 会抛
 * EPIPE/ECONNRESET，未捕获就整个进程退出 —— 表现就是之后所有请求
 * ERR_CONNECTION_ABORTED（应用"打不开"）。
 */
function pipeFile(res, stream) {
  stream.on('error', () => {
    try { res.destroy(); } catch { /* ignore */ }
  });
  res.on('close', () => {
    try { stream.destroy(); } catch { /* ignore */ }
  });
  res.on('error', () => {
    try { stream.destroy(); } catch { /* ignore */ }
  });
  stream.pipe(res);
}

function mimeOf(p) {
  switch (path.extname(p).toLowerCase()) {
    case '.mp3': return 'audio/mpeg';
    case '.flac': return 'audio/flac';
    case '.wav': return 'audio/wav';
    case '.m4a': return 'audio/mp4';
    case '.aac': return 'audio/aac';
    case '.ogg':
    case '.oga': return 'audio/ogg';
    case '.opus': return 'audio/opus';
    case '.jpg':
    case '.jpeg': return 'image/jpeg';
    case '.png': return 'image/png';
    case '.html': return 'text/html; charset=utf-8';
    case '.js': return 'application/javascript; charset=utf-8';
    case '.css': return 'text/css; charset=utf-8';
    case '.svg': return 'image/svg+xml';
    default: return 'application/octet-stream';
  }
}

/** 带 Range 的音频流 */
async function streamFile(req, res, filePath) {
  let st;
  try {
    st = await fsp.stat(filePath);
  } catch {
    return json(res, 404, { error: '文件不存在' });
  }
  const size = st.size;
  const range = req.headers.range;

  if (!range) {
    res.writeHead(200, {
      'Content-Type': mimeOf(filePath),
      'Content-Length': size,
      'Accept-Ranges': 'bytes'
    });
    if (req.method === 'HEAD') return res.end();
    return pipeFile(res, fs.createReadStream(filePath));
  }

  const m = /^bytes=(\d*)-(\d*)$/.exec(range.trim());
  if (!m) {
    res.writeHead(416, { 'Content-Range': `bytes */${size}` });
    return res.end();
  }
  let start = m[1] === '' ? size - Number(m[2]) : Number(m[1]);
  let end = m[1] === '' || m[2] === '' ? size - 1 : Number(m[2]);
  if (Number.isNaN(start) || Number.isNaN(end) || start > end || start < 0 || end >= size) {
    res.writeHead(416, { 'Content-Range': `bytes */${size}` });
    return res.end();
  }

  res.writeHead(206, {
    'Content-Type': mimeOf(filePath),
    'Content-Length': end - start + 1,
    'Content-Range': `bytes ${start}-${end}/${size}`,
    'Accept-Ranges': 'bytes'
  });
  if (req.method === 'HEAD') return res.end();
  pipeFile(res, fs.createReadStream(filePath, { start, end }));
}

async function serveStatic(req, res, urlPath) {
  let rel = urlPath.replace(/^\/+/, '');
  if (rel === '' || rel.endsWith('/')) rel += 'index.html';
  const abs = path.join(PUBLIC_DIR, rel);
  if (!abs.startsWith(PUBLIC_DIR)) return json(res, 403, { error: 'forbidden' });
  try {
    const st = await fsp.stat(abs);
    if (!st.isFile()) throw new Error('not file');
    res.writeHead(200, {
      'Content-Type': mimeOf(abs),
      'Content-Length': st.size,
      'Cache-Control': abs.endsWith('.html') ? 'no-store, no-cache, must-revalidate, max-age=0' : 'public, max-age=3600',
      'Pragma': 'no-cache',
      'Expires': '0'
    });
    pipeFile(res, fs.createReadStream(abs));
  } catch {
    res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' });
    res.end('Not Found');
  }
}

async function serveCover(res, song, allowOnline = true) {
  const cached = path.join(COVER_DIR, song.id + '.img');
  const send = (buf, mime = 'image/jpeg') => {
    res.writeHead(200, { 'Content-Type': mime, 'Content-Length': buf.length, 'Cache-Control': 'public, max-age=86400' });
    res.end(buf);
  };
  const remember = async (buf, mime) => {
    await fsp.writeFile(cached, buf).catch(() => {});
    return send(buf, mime);
  };

  // 0) 已缓存
  try {
    return send(await fsp.readFile(cached));
  } catch { /* 继续 */ }

  // 1) 内嵌封面（最准，直接给，不再挑大小）
  try {
    if (!mm) mm = require('music-metadata');
    const meta = await mm.parseFile(song.path, { duration: false });
    const pic = meta.common?.picture?.[0];
    if (pic) return remember(Buffer.from(pic.data), pic.format || 'image/jpeg');
  } catch { /* 继续 */ }

  // 2) 同目录封面图
  const local = await findFolderCover(song.path);
  if (local) {
    try {
      return remember(await fsp.readFile(local), mimeOf(local));
    } catch { /* 继续 */ }
  }

  // 3) 在线补全（网易云 → QQ），串行执行避免限流；列表请求会带 online=0 跳过
  if (!allowOnline) return json(res, 404, { error: '没有封面' });
  const online = await enqueueOnline(() =>
    onlineCover(song.title || cleanName(path.basename(song.path)), song.artist || '')
  );
  if (online) return remember(online);

  return json(res, 404, { error: '没有封面' });
}

// ------------------------------------------------------------------ 封面来源

const COVER_NAMES = ['cover', 'folder', 'front', 'album', 'albumart', 'artwork'];
const folderCoverCache = new Map();   // dir -> 文件路径 or ''

/** 同目录里找一张封面图；找不到返回 null */
async function findFolderCover(songPath) {
  const dir = path.dirname(songPath);
  if (folderCoverCache.has(dir)) {
    const hit = folderCoverCache.get(dir);
    return hit || null;
  }
  let found = '';
  try {
    const base = path.basename(songPath).replace(/\.[^.]+$/, '').toLowerCase();
    const entries = await fsp.readdir(dir);
    const images = entries.filter((n) => /\.(jpe?g|png|webp)$/i.test(n));
    // 同名图片优先
    found = images.find((n) => n.replace(/\.[^.]+$/, '').toLowerCase() === base) || '';
    if (!found) {
      for (const want of COVER_NAMES) {
        const hit = images.find((n) => n.replace(/\.[^.]+$/, '').toLowerCase() === want);
        if (hit) { found = hit; break; }
      }
    }
    if (!found && images.length === 1) found = images[0];
  } catch { /* 目录读不了就放弃 */ }
  folderCoverCache.set(dir, found);
  return found ? path.join(dir, found) : null;
}

/** 在线封面请求串行化，避免一屏几十首同时打接口被限流 */
let onlineChain = Promise.resolve();
function enqueueOnline(fn) {
  const run = onlineChain.then(fn, fn);
  onlineChain = run.catch(() => null);
  return run;
}

let neteaseBlockedUntil = 0;
const UA = 'Mozilla/5.0 (Linux; Android 13) MusicLibrary/1.0';

async function fetchText(url, headers = {}, timeout = 8000) {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), timeout);
  try {
    const r = await fetch(url, { headers: { 'User-Agent': UA, Accept: '*/*', ...headers }, signal: ctrl.signal });
    if (!r.ok) return null;
    return await r.text();
  } catch {
    return null;
  } finally {
    clearTimeout(timer);
  }
}

async function fetchBytes(url, timeout = 12000) {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), timeout);
  try {
    const r = await fetch(url, { headers: { 'User-Agent': UA, Accept: '*/*' }, signal: ctrl.signal });
    if (!r.ok) return null;
    const ab = await r.arrayBuffer();
    return Buffer.from(ab);
  } catch {
    return null;
  } finally {
    clearTimeout(timer);
  }
}

/** 最长公共子序列相似度（0~100） */
function similarity(a, b) {
  if (!a || !b) return 0;
  if (a === b) return 100;
  const n = a.length;
  const m = b.length;
  const dp = new Int32Array(m + 1);
  for (let i = 1; i <= n; i++) {
    let prev = 0;
    for (let j = 1; j <= m; j++) {
      const tmp = dp[j];
      dp[j] = a[i - 1] === b[j - 1] ? prev + 1 : Math.max(dp[j], dp[j - 1]);
      prev = tmp;
    }
  }
  return (dp[m] * 2 * 100) / (n + m);
}

/** 归一化：去括号内容、噪声词、标点，只留字母数字汉字 */
function norm(s) {
  return String(s || '')
    .toLowerCase()
    .replace(/[\(（\[【].*?[\)）\]】]/g, '')
    .replace(/(feat|ft|live|remix|remaster|hq|hires|flac|mp3|wav|无损|伴奏|dj|version|ver|edit|mix|official|mv|高清)/g, '')
    .replace(/[^\p{L}\p{N}]+/gu, '');
}

async function neteaseCover(title, artist) {
  if (Date.now() < neteaseBlockedUntil) return null;
  const kw = `${artist} ${title}`.trim();
  const url = 'https://music.163.com/api/search/get/web?s=' + encodeURIComponent(kw) + '&type=1&offset=0&total=true&limit=8';
  const raw = await fetchText(url);
  if (!raw) return null;
  if (raw.includes('"code":405') || raw.includes('操作频繁')) {
    neteaseBlockedUntil = Date.now() + 90000;
    return null;
  }
  let songs;
  try {
    songs = JSON.parse(raw).result?.songs;
  } catch {
    return null;
  }
  if (!Array.isArray(songs) || !songs.length) return null;

  const wantTitle = norm(title);
  const wantArtist = norm(artist);
  let bestId = 0;
  let best = -1;
  for (const s of songs.slice(0, 8)) {
    const t = similarity(wantTitle, norm(s.name));
    let score = t * (wantArtist ? 0.8 : 1);
    if (wantArtist) {
      const ap = Math.max(0, ...(s.artists || s.ar || []).map((a) => similarity(wantArtist, norm(a.name))));
      if (ap < 45 && t < 92) continue;
      score += ap * 0.2;
    }
    if (score > best) { best = score; bestId = s.id; }
  }
  if (!bestId || best < 60) return null;

  const detail = await fetchText('https://music.163.com/api/v3/song/detail?c=' + encodeURIComponent(JSON.stringify([{ id: bestId }])));
  if (!detail) return null;
  try {
    const al = JSON.parse(detail).songs?.[0]?.al;
    const pic = al?.picUrl;
    return pic ? pic.replace('http://', 'https://') : null;
  } catch {
    return null;
  }
}

async function qqCover(title, artist) {
  const kw = `${artist} ${title}`.trim();
  const url = 'https://c.y.qq.com/soso/fcgi-bin/client_search_cp?format=json&n=8&p=1&w=' + encodeURIComponent(kw).replace(/%20/g, '%20');
  const raw = await fetchText(url, { Referer: 'https://y.qq.com/' });
  if (!raw) return null;
  let list;
  try {
    list = JSON.parse(raw).data?.song?.list;
  } catch {
    return null;
  }
  if (!Array.isArray(list) || !list.length) return null;

  const wantTitle = norm(title);
  const wantArtist = norm(artist);
  let bestMid = '';
  let best = -1;
  for (const s of list.slice(0, 8)) {
    if (!s.albummid) continue;
    const t = similarity(wantTitle, norm(s.songname));
    let score = t * (wantArtist ? 0.8 : 1);
    if (wantArtist) {
      const ap = Math.max(0, ...(s.singer || []).map((g) => similarity(wantArtist, norm(g.name))));
      if (ap < 45 && t < 92) continue;
      score += ap * 0.2;
    }
    if (score > best) { best = score; bestMid = s.albummid; }
  }
  if (!bestMid || best < 60) return null;
  return `https://y.gtimg.cn/music/photo_new/T002R300x300M000${bestMid}.jpg`;
}

async function onlineCover(title, artist) {
  const clean = String(artist || '').trim();
  const a = /^(未知歌手|<unknown>)$/i.test(clean) ? '' : clean;

  let pic = await neteaseCover(title, a);
  if (!pic && a) pic = await neteaseCover(title, '');
  if (pic) {
    const buf = await fetchBytes(pic);
    if (buf) { Log2(`封面在线命中（网易云）：${title}`); return buf; }
  }

  pic = await qqCover(title, a);
  if (!pic && a) pic = await qqCover(title, '');
  if (pic) {
    const buf = await fetchBytes(pic);
    if (buf) { Log2(`封面在线命中（QQ）：${title}`); return buf; }
  }
  return null;
}

function Log2(msg) {
  console.log(`[mycomusic] ${msg}`);
}

/** 目录浏览：只能在授权目录内 */
async function browse(res, targetPath) {
  const roots = allowedRoots();
  const base = targetPath ? await resolveAllowed(targetPath, roots) : roots[0];
  if (!base) return json(res, 403, { error: '目录不在授权范围内' });

  const real = await realpathSafe(base);
  if (!real) return json(res, 404, { error: '目录不存在' });

  let entries = [];
  try {
    entries = await fsp.readdir(real, { withFileTypes: true });
  } catch (e) {
    return json(res, 500, { error: e.message });
  }

  const dirs = entries
    .filter((e) => e.isDirectory() && !e.name.startsWith('.'))
    .map((e) => ({ name: e.name, path: path.join(real, e.name) }))
    .sort((a, b) => a.name.localeCompare(b.name, 'zh'));

  json(res, 200, {
    path: real,
    parent: roots.includes(real) ? null : path.dirname(real),
    roots,
    dirs
  });
}

async function handleApi(req, res, url) {
  const { pathname, searchParams } = url;

  if (pathname === '/api/ping') return json(res, 200, { ok: true, app: 'mycomusic', version: ENV.TRIM_APPVER || '1.0.0' });

  // 诊断：排查"添加不了 / 扫不了"时先看这里
  // 客户端上报（播放错误、拖动进度条等），写进访问日志
  if (pathname === '/api/log' && req.method === 'POST') {
    const body = await readJson(req);
    const line =
      new Date().toISOString() +
      ' [client] ' + String(body.event || '') +
      ' ' + String(body.detail || '').slice(0, 300) +
      ' ua="' + String(body.ua || '').slice(0, 120) + '"\n';
    fsp.appendFile(ACCESS_LOG, line).catch(() => {});
    return json(res, 200, { ok: true });
  }

  if (pathname === '/api/diag') {
    const roots = accessibleRoots();
    return json(res, 200, {
      app: 'mycomusic',
      version: ENV.TRIM_APPVER || '',
      node: process.version,
      user: (() => { try { return require('os').userInfo().username; } catch { return ''; } })(),
      cwd: process.cwd(),
      pkgvar: PKGVAR,
      pkgetc: PKGETC,
      socket: SOCKET_PATH || null,
      gatewayPrefix: GATEWAY_PREFIX,
      rawAccessibleEnv: ENV.TRIM_DATA_ACCESSIBLE_PATHS || '',
      accessibleRoots: roots,
      rootInfo: roots.map((r) => {
        try {
          const st = fs.statSync(r);
          let readable = false;
          let entries = -1;
          try {
            entries = fs.readdirSync(r).length;
            readable = true;
          } catch (e2) {
            readable = false;
          }
          return { path: r, exists: true, isDir: st.isDirectory(), real: fs.realpathSync(r), readable, entries };
        } catch (e) {
          return { path: r, exists: false, error: e.code || e.message };
        }
      }),
      libraries,
      songs: index.length,
      recentRequests: await (async () => {
        try {
          const raw = await fsp.readFile(ACCESS_LOG, 'utf8');
          return raw.trim().split('\n').slice(-20);
        } catch {
          return [];
        }
      })(),
      suspiciousSamples: index
        .filter((s) => {
          const t = s.title || '';
          const base = path.basename(s.path);
          return /[\uFFFD\u25A1\u25A0]/.test(t) || !tagTrustWorthy(t, base) || !tagTrustWorthy(s.artist || '', base);
        })
        .slice(0, 8)
        .map((s) => ({
          title: s.title,
          artist: s.artist,
          file: path.basename(s.path),
          rawTitle: s.rawTitle || '',
          rawArtist: s.rawArtist || ''
        }))
    });
  }

  if (pathname === '/api/library' && req.method === 'GET') {
    return json(res, 200, {
      libraries,
      authorized: accessibleRoots(),
      songs: index.length
    });
  }

  if (pathname === '/api/library' && req.method === 'POST') {
    const body = await readJson(req);
    const roots = accessibleRoots();
    const abs = await resolveAllowed(body.path, roots);
    if (!abs) return json(res, 403, { error: '目录不在授权范围内，请先到应用设置里授权该目录' });
    if (!libraries.includes(abs)) libraries.push(abs);
    await saveLibraries();
    return json(res, 200, { ok: true, libraries });
  }

  if (pathname === '/api/library' && req.method === 'DELETE') {
    const body = await readJson(req);
    libraries = libraries.filter((p) => path.resolve(p) !== path.resolve(String(body.path)));
    await saveLibraries();
    index = index.filter((s) => !libraries.some((lib) => s.path.startsWith(lib + path.sep)));
    rebuildIdMap();
    await saveIndex();
    return json(res, 200, { ok: true, libraries });
  }

  if (pathname === '/api/browse') {
    return browse(res, searchParams.get('path') || '');
  }

  if (pathname === '/api/scan' && req.method === 'POST') {
    const force = searchParams.get('force') === '1';
    if (scanState.running) return json(res, 409, { error: '正在扫描中' });
    scanAll({ force }).catch(() => {});
    return json(res, 200, { ok: true });
  }

  if (pathname === '/api/scan/status') {
    return json(res, 200, scanState);
  }

  if (pathname === '/api/favorites') {
    if (req.method === 'GET') return json(res, 200, { ids: [...favorites] });
    const body = await readJson(req);
    const id = String(body.id || '');
    if (!id) return json(res, 400, { error: '缺少 id' });
    if (body.on === false) favorites.delete(id);
    else if (body.on === true) favorites.add(id);
    else if (favorites.has(id)) favorites.delete(id);
    else favorites.add(id);
    await saveFavorites();
    return json(res, 200, { ok: true, on: favorites.has(id) });
  }

  if (pathname === '/api/playlists') {
    if (req.method === 'GET') return json(res, 200, { playlists: await listPlaylists(), dir: playlistDir() });
    const body = await readJson(req);
    const name = safePlaylistName(body.name);
    if (!name) return json(res, 400, { error: '歌单名不能为空' });
    if (req.method === 'POST') {
      if (!(await fsp.stat(playlistPath(name)).then(() => true).catch(() => false))) {
        await writePlaylist(name, []);
      }
      return json(res, 200, { ok: true, name });
    }
    if (req.method === 'DELETE') {
      await fsp.rm(playlistPath(name), { force: true }).catch(() => {});
      return json(res, 200, { ok: true });
    }
  }

  if (pathname === '/api/playlist') {
    if (req.method === 'GET') {
      const name = safePlaylistName(searchParams.get('name'));
      return json(res, 200, { name, ids: await readPlaylist(name) });
    }
    const body = await readJson(req);
    const name = safePlaylistName(body.name);
    const id = String(body.id || '');
    if (!name) return json(res, 400, { error: '缺少歌单名' });
    let ids = await readPlaylist(name);
    if (req.method === 'POST') {
      if (id && !ids.includes(id)) ids.push(id);
    } else if (req.method === 'DELETE') {
      ids = ids.filter((x) => x !== id);
    }
    await writePlaylist(name, ids);
    return json(res, 200, { ok: true, count: ids.length });
  }

  if (pathname === '/api/songs') {
    const q = (searchParams.get('search') || '').trim().toLowerCase();
    const sort = searchParams.get('sort') || 'title';
    const limit = Math.min(Number(searchParams.get('limit') || 2000), 10000);
    let list = index;
    if (q) {
      list = list.filter((s) =>
        (s.title || '').toLowerCase().includes(q) ||
        (s.artist || '').toLowerCase().includes(q) ||
        (s.album || '').toLowerCase().includes(q) ||
        path.basename(s.path).toLowerCase().includes(q)
      );
    }
    const key = { title: 'title', artist: 'artist', album: 'album', duration: 'duration' }[sort] || 'title';
    list = [...list].sort((a, b) => String(a[key] || '').localeCompare(String(b[key] || ''), 'zh'));
    return json(res, 200, {
      total: index.length,
      count: list.length,
      songs: list.slice(0, limit).map((s) => ({
        id: s.id,
        name: path.basename(s.path),
        title: s.title,
        artist: s.artist,
        album: s.album,
        duration: s.duration,
        size: s.size,
        hasCover: s.hasCover
      }))
    });
  }

  if (pathname === '/api/stream') {
    const song = indexById.get(searchParams.get('id') || '');
    if (!song) return json(res, 404, { error: '歌曲不存在' });
    const abs = safeResolve(song.path, allowedRoots());
    if (!abs) return json(res, 403, { error: '不在授权范围内' });
    return streamFile(req, res, abs);
  }

  if (pathname === '/api/lyrics') {
    const song = indexById.get(searchParams.get('id') || '');
    if (!song) return json(res, 404, { error: '歌曲不存在' });
    return serveLyrics(res, song);
  }

  if (pathname === '/api/cover') {
    const song = indexById.get(searchParams.get('id') || '');
    if (!song) return json(res, 404, { error: '歌曲不存在' });
    return serveCover(res, song, searchParams.get('online') !== '0');
  }

  return json(res, 404, { error: 'unknown api' });
}

function readJson(req) {
  return new Promise((resolve) => {
    let data = '';
    req.on('data', (c) => {
      data += c;
      if (data.length > 1e6) req.destroy();
    });
    req.on('end', () => {
      try {
        resolve(JSON.parse(data || '{}'));
      } catch {
        resolve({});
      }
    });
    req.on('error', () => resolve({}));
  });
}

const server = http.createServer(async (req, res) => {
  const started = Date.now();
  const ua = String(req.headers['user-agent'] || '-');
  const host = String(req.headers.host || '-');

  // 访问日志：排查"手机 App 打不开"时，先看请求有没有进来、返回了什么
  res.on('finish', () => {
    const line = `${new Date().toISOString()} ${req.method} ${req.url} -> ${res.statusCode} ` +
      `${Date.now() - started}ms host=${host} ua="${ua}"\n`;
    fsp.appendFile(ACCESS_LOG, line).catch(() => {});
  });

  try {
    const url = new URL(req.url, 'http://localhost');
    let pathname = url.pathname;

    // 统一网关下所有请求都带前缀，剥掉后按普通路径处理。
    // 环境变量没传时也按约定的 /app/mycomusic 兜底，避免页面和接口对不上。
    for (const prefix of PREFIXES) {
      if (pathname === prefix || pathname.startsWith(prefix + '/')) {
        pathname = pathname.slice(prefix.length) || '/';
        url.pathname = pathname;
        break;
      }
    }

    if (pathname.startsWith('/api/')) return handleApi(req, res, url);
    if (req.method !== 'GET' && req.method !== 'HEAD') return json(res, 405, { error: 'method not allowed' });
    return serveStatic(req, res, pathname);
  } catch (e) {
    json(res, 500, { error: e.message || String(e) });
  }
});

// 客户端异常（半截请求、端口探测）直接断开，不影响其它连接
server.on('clientError', (err, socket) => {
  try { socket.end('HTTP/1.1 400 Bad Request\r\n\r\n'); } catch { /* ignore */ }
});

// ------------------------------------------------------------------ 启动

// 兜底：任何漏网的异常只记录，不让进程退出
process.on('uncaughtException', (e) => {
  console.error('[mycomusic] uncaughtException', e && e.stack ? e.stack : e);
});
process.on('unhandledRejection', (e) => {
  console.error('[mycomusic] unhandledRejection', e);
});

(async () => {
  await loadState();

  if (SOCKET_PATH) {
    try { fs.rmSync(SOCKET_PATH, { force: true }); } catch {}
    server.listen(SOCKET_PATH, () => {
      console.log('[mycomusic] listening on socket', SOCKET_PATH);
    });
  } else {
    server.listen(PORT, '0.0.0.0', () => {
      console.log('[mycomusic] listening on port', PORT);
    });
  }

  // 启动后做一次增量扫描（没有音乐库就跳过）
  if (libraries.length > 0) {
    setTimeout(() => { scanAll({ force: false }).catch(() => {}); }, 1500);
  }
})().catch((e) => {
  console.error('[mycomusic] fatal', e);
  process.exit(1);
});
