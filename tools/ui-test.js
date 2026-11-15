/**
 * 界面自动化测试（jsdom）
 *
 * 覆盖：列表渲染、播放页、歌词页、进度条（拖动/点击/±15s）、收藏、歌单。
 * 用法：node ui-test.js <public/index.html 路径>
 */

const fs = require('fs');
const path = require('path');
const { JSDOM, VirtualConsole } = require('jsdom');

const htmlPath = process.argv[2] || path.join(__dirname, '..', 'app', 'server', 'public', 'index.html');
const html = fs.readFileSync(htmlPath, 'utf8');

let failures = 0;
function check(name, cond, extra = '') {
  if (cond) {
    console.log(`  ✅ ${name}`);
  } else {
    failures++;
    console.log(`  ❌ ${name} ${extra}`);
  }
}

const SONGS = [
  { id: 'a1', name: 'a.flac', title: '海阔天空', artist: 'BEYOND', album: '乐与怒', duration: 325, size: 1000, hasCover: false },
  { id: 'a2', name: 'b.flac', title: '最爱', artist: '周慧敏', album: 'ELEMENTS', duration: 265, size: 1000, hasCover: false },
];
const LRC = '[00:00.00]作词 : 黄家驹\n[00:05.00]今天我\n[00:10.00]寒夜里看雪飘过\n[00:15.00]怀着冷却了的心窝漂远方\n';
const FAV = new Set();

function fakeFetch(url, opt) {
  const u = String(url);
  const json = (o) => Promise.resolve({ ok: true, status: 200, json: () => Promise.resolve(o) });
  const isPost = opt && opt.method && opt.method !== 'GET';
  const body = opt && opt.body ? JSON.parse(opt.body) : {};

  if (u.includes('/api/ping')) return json({ ok: true });
  if (u.includes('/api/songs')) return json({ total: SONGS.length, count: SONGS.length, songs: SONGS });
  if (u.includes('/api/favorites')) {
    if (isPost) {
      const id = body.id;
      if (body.on === undefined) { if (FAV.has(id)) FAV.delete(id); else FAV.add(id); }
      else if (body.on) FAV.add(id); else FAV.delete(id);
      return json({ ok: true, on: FAV.has(id) });
    }
    return json({ ids: [...FAV] });
  }
  if (u.includes('/api/lyrics')) return json({ source: '网易云', lrc: LRC });
  if (u.includes('/api/playlists')) {
    if (isPost) return json({ ok: true, name: body.name });
    return json({ playlists: [{ name: '我的最爱', count: 2 }], dir: '/tmp' });
  }
  if (u.includes('/api/playlist')) return json({ name: '我的最爱', ids: ['a1'] });
  if (u.includes('/api/library')) return json({ libraries: ['/music'], authorized: ['/music'], songs: 2 });
  if (u.includes('/api/scan/status')) return json({ running: false, scanned: 2, total: 2 });
  if (u.includes('/api/diag')) return json({ recentRequests: [] });
  if (u.includes('/api/log')) return json({ ok: true });
  return json({});
}

(async () => {
  const vc = new VirtualConsole();
  const errors = [];
  vc.on('jsdomError', (e) => { if (!/Could not parse CSS/.test(e.message)) errors.push(e.message); });
  vc.on('error', (m) => errors.push(String(m)));

  const dom = new JSDOM(html, {
    url: 'http://localhost/app/mycomusic',
    runScripts: 'dangerously',
    pretendToBeVisual: true,
    virtualConsole: vc,
    beforeParse(window) {
      window.fetch = (u, o) => fakeFetch(u, o);
      window.HTMLMediaElement.prototype.play = function () { return Promise.resolve(); };
      window.HTMLMediaElement.prototype.pause = function () {};
      window.HTMLMediaElement.prototype.load = function () {};
      Object.defineProperty(window.HTMLMediaElement.prototype, 'duration', { get() { return 325; }, configurable: true });
      window.alert = () => {};
      window.confirm = () => true;
      window.prompt = () => null;
    },
  });

  const { window } = dom;
  const doc = window.document;
  const wait = (ms) => new Promise((r) => setTimeout(r, ms));
  const click = (el) => el.dispatchEvent(new window.MouseEvent('click', { bubbles: true }));
  await wait(300);

  console.log('\n[1] 列表');
  check('脚本无报错', errors.length === 0, JSON.stringify(errors.slice(0, 2)));
  check('渲染出歌曲行', doc.querySelectorAll('#list .row').length === 2, '实际 ' + doc.querySelectorAll('#list .row').length);
  check('播放页初始隐藏', doc.getElementById('playerScreen').classList.contains('hidden'));

  console.log('\n[2] 点歌 → 播放页');
  click(doc.querySelectorAll('#list .row')[0]);
  await wait(200);
  const ps = doc.getElementById('playerScreen');
  check('播放页已打开', !ps.classList.contains('hidden'));
  check('标题正确', doc.getElementById('psTitle').textContent === '海阔天空', doc.getElementById('psTitle').textContent);
  check('歌手正确', doc.getElementById('psArtist').textContent.includes('BEYOND'));

  console.log('\n[3] 播放页 → 歌词页 → 返回');
  click(doc.getElementById('psLyric'));
  await wait(300);
  const ls = doc.getElementById('lyricScreen');
  check('歌词页已打开', !ls.classList.contains('hidden'));
  const lines = doc.querySelectorAll('#lsBody .lyric-line');
  check('歌词已渲染', lines.length === 4, '实际 ' + lines.length);

  // 高亮
  const audio = doc.getElementById('audio');
  let current = 0;
  Object.defineProperty(audio, 'currentTime', { get() { return current; }, set(v) { current = v; }, configurable: true });
  current = 12;
  audio.dispatchEvent(new window.Event('timeupdate'));
  await wait(80);
  const on = doc.querySelectorAll('#lsBody .lyric-line.on');
  check('歌词高亮到第 3 行', on.length === 1 && on[0].textContent.includes('寒夜里'), on[0] ? on[0].textContent : '无');

  click(doc.getElementById('lsBack'));
  await wait(60);
  check('返回后歌词页关闭', ls.classList.contains('hidden'));
  check('播放页仍在', !ps.classList.contains('hidden'));

  console.log('\n[4] 进度条（播放页）');
  const wrap = doc.getElementById('psSeekWrap');
  wrap.querySelector('.seek-track').getBoundingClientRect = () => ({ left: 0, width: 100, top: 0, bottom: 4, right: 100, height: 4 });
  wrap.dispatchEvent(new window.MouseEvent('click', { bubbles: true, clientX: 50 }));
  await wait(80);
  check('点击 50% 跳到一半', Math.abs(current - 162.5) < 2, '实际 ' + current);

  current = 100;
  audio.dispatchEvent(new window.Event('timeupdate'));
  click(doc.getElementById('psFwd15'));
  await wait(60);
  check('+15 秒', Math.abs(current - 115) < 1, '实际 ' + current);
  click(doc.getElementById('psBack15'));
  await wait(60);
  check('-15 秒', Math.abs(current - 100) < 1, '实际 ' + current);

  console.log('\n[4.5] 拖动进度条（模拟手指，touchend 的 touches 为空）');
  const touch = (type, x, extra = {}) => {
    const ev = new window.Event(type, { bubbles: true, cancelable: true });
    ev.touches = type === 'touchend' ? [] : [{ clientX: x }];
    ev.changedTouches = [{ clientX: x }];
    Object.assign(ev, extra);
    return ev;
  };
  wrap.dispatchEvent(touch('touchstart', 10));
  await wait(30);
  wrap.dispatchEvent(touch('touchmove', 60));
  await wait(30);
  window.dispatchEvent(touch('touchend', 80));
  await wait(80);
  check('松手后跳到 80%', Math.abs(current - 260) < 6, '实际 ' + current);

  console.log('\n[4.6] 播放页进度条视觉更新');
  current = 162;
  audio.dispatchEvent(new window.Event('timeupdate'));
  await wait(60);
  const fill = doc.getElementById('psSeekFill').style.width;
  const thumb = doc.getElementById('psSeekThumb').style.left;
  const cur = doc.getElementById('psCur').textContent;
  const dur = doc.getElementById('psDur').textContent;
  check('填充宽度已更新', parseFloat(fill) > 40, 'fill=' + fill);
  check('滑块位置已更新', parseFloat(thumb) > 40, 'thumb=' + thumb);
  check('当前时间显示', cur === '2:42', 'cur=' + cur);
  check('总时长显示', dur === '5:25', 'dur=' + dur);

  console.log('\n[5] 关闭播放页');
  click(doc.getElementById('psClose'));
  await wait(60);
  check('播放页关闭', ps.classList.contains('hidden'));
  check('底部播放条仍在', !doc.getElementById('player').classList.contains('hidden'));

  console.log('\n[6] 收藏与歌单');
  const favBtn = doc.querySelectorAll('#list .row .act')[0];
  click(favBtn);
  await wait(120);
  check('收藏切换为实心', favBtn.textContent === '♥', '实际 ' + favBtn.textContent);

  click(doc.querySelector('.chip[data-filter="pl"]'));
  await wait(250);
  const plRows = doc.querySelectorAll('#list .row');
  check('列出歌单', plRows.length === 1 && plRows[0].textContent.includes('我的最爱'), '实际 ' + plRows.length);

  console.log('\n[7] 运行时错误');
  check('无报错', errors.length === 0, JSON.stringify(errors.slice(0, 3)));

  console.log(`\n结果：${failures === 0 ? '全部通过 ✅' : failures + ' 项失败 ❌'}`);
  process.exit(failures === 0 ? 0 : 1);
})();
