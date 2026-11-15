# 我的音乐库 · fnOS 音乐应用

把 NAS 上的音乐文件夹变成可以直接播放的曲库。为飞牛 OS（fnOS）开发，按应用中心上架标准构建。

> 无需整理标签、无需上传云端：添加一个目录，打开就能听。

---

## 功能

| | |
|---|---|
| **从界面添加音乐库** | 在应用里选择 NAS 目录，支持多个目录；权限由飞牛授权机制控制 |
| **无损原文件直连** | FLAC / APE / WAV / MP3 / M4A / OGG / WMA，不转码，支持任意位置拖动 |
| **中文标签纠错** | 自研 ID3v2 / Vorbis / RIFF 解析，自动识别 GBK、UTF-16、UTF-8 混用 |
| **封面三级补全** | 内嵌封面 → 同目录图片 → 在线匹配；列表封面不联网 |
| **歌词自动匹配** | 本地 `.lrc` → 网易云 → QQ 音乐，缓存到本地，播放时逐行高亮 |
| **收藏与歌单** | 歌单保存为标准 `.m3u8`，可在文件管理器中查看，VLC / Foobar 可直接打开 |
| **三页面界面** | 曲库列表 / 播放页 / 歌词页 |
| **系统媒体控制** | Media Session，浏览器中支持锁屏播放与通知栏切歌 |

## 截图

| 曲库列表 | 播放页 | 歌词页 |
|---|---|---|
| ![列表](docs/1-曲库列表.png) | ![播放](docs/2-播放页.png) | ![歌词](docs/3-歌词页.png) |

## 安装

### 从应用中心（推荐）

待上架后可直接搜索安装。

### 手动安装

1. 下载 `mycomusic.fpk`
2. 飞牛 OS → 应用中心 → 右上角「手动安装」→ 选择文件
3. 安装完成后在应用列表打开「我的音乐库」
4. 首次进入点「音乐库」→ 添加你的音乐文件夹
5. 点「扫描」建立索引

## 目录结构

```
manifest                # 应用元信息（版本、平台、依赖、网关入口）
cmd/                    # 生命周期脚本（安装/启动/停止/升级/卸载）
config/
  privilege             # 需要的系统权限
  resource              # 数据目录、共享目录、端口声明
wizard/                 # 安装 / 卸载向导
app/
  server/
    server.js           # Node 服务：曲库索引、流播、封面、歌词、收藏、歌单
    tags.js             # 自研标签读取（ID3v2 / Vorbis / RIFF）
    public/index.html   # 单文件前端（列表 / 播放页 / 歌词页）
  ui/                   # 桌面图标与启动配置
tools/                  # 构建与测试工具
```

## 开发

环境要求：Node.js 22。

```powershell
# 安装依赖（pnpm）
cd app/server
pnpm install
# 把 pnpm 的符号链接展开成实体目录（fpk 打包需要）
node ..\..\tools\materialize-modules.js
```

本地调试：

```powershell
$env:TRIM_PKGVAR=".runtime"
$env:TRIM_PKGETC=".config"
$env:TRIM_DATA_ACCESSIBLE_PATHS="D:\music"
$env:PORT="5080"
node app/server/server.js
# 浏览器打开 http://127.0.0.1:5080/
```

打包：

```powershell
$env:TMP="$PWD\.tmp"; $env:TEMP=$env:TMP
fnpack build
python tools\fix_permissions.py mycomusic.fpk
```

## 测试

```powershell
cd tools
pnpm install

# 界面测试（jsdom，19 项断言）
node ui-test.js ..\app\server\public\index.html

# CSS 语法检查（能抓出会让整段样式失效的低级错误）
node css-check.js ..\app\server\public\index.html
```

## 接口

| 路径 | 说明 |
|---|---|
| `GET /api/ping` | 健康检查，返回版本 |
| `GET /api/diag` | 诊断信息（授权目录、索引统计、最近请求） |
| `GET/POST/DELETE /api/library` | 音乐库增删查 |
| `GET /api/scan` · `POST /api/scan?force=1` | 扫描状态 / 触发扫描 |
| `GET /api/songs` | 歌曲列表（搜索、排序） |
| `GET /api/stream?id=` | 音频流，支持 Range / 206 |
| `GET /api/cover?id=&online=` | 封面（`online=0` 只读本地） |
| `GET /api/lyrics?id=` | 歌词（本地 lrc → 网易云 → QQ） |
| `GET/POST /api/favorites` | 收藏 |
| `GET/POST/DELETE /api/playlists` | 歌单 |
| `POST /api/log` | 客户端事件上报（写入访问日志） |

## 说明

- 音频文件始终留在 NAS 上，应用不上传任何音乐文件
- 联网仅用于匹配封面和歌词
- 索引与缓存位于 `/vol1/@appdata/mycomusic`
- 不占用端口，通过飞牛统一网关（Unix Socket）接入

## License

MIT
