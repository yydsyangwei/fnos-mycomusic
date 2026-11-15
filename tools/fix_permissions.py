#!/usr/bin/env python3
"""给 fpk 里的 cmd/* 补上可执行权限。

背景：fnpack 的 Windows 版从 NTFS 读文件，拿不到 Unix 执行位，
打出来的包里 cmd/main 是 -rw-rw-rw-。fnOS 要用这些脚本做装/卸/启停，
所以这里重新打一次包，把 cmd/ 下的文件设成 0755，目录 0755，其余 0644。

用法：python tools/fix_permissions.py [fpk路径]
"""

import io
import os
import sys
import tarfile

DEFAULT = os.path.join(
    os.path.dirname(os.path.dirname(os.path.abspath(__file__))), "mycomusic.fpk"
)

EXEC_DIRS = ("cmd/",)


def should_exec(name: str) -> bool:
    return any(name.startswith(d) for d in EXEC_DIRS)


def main() -> int:
    path = sys.argv[1] if len(sys.argv) > 1 else DEFAULT
    if not os.path.isfile(path):
        print("找不到文件：" + path)
        return 1

    entries = []
    with tarfile.open(path, "r:gz") as tf:
        for m in tf.getmembers():
            data = tf.extractfile(m).read() if m.isfile() else None
            entries.append((m, data))

    buggy = 0
    fixed = []
    for m, data in entries:
        if m.isdir():
            m.mode = 0o755
        elif should_exec(m.name) and not m.name.endswith("/"):
            if (m.mode & 0o111) == 0:
                buggy += 1
            m.mode = 0o755
        else:
            m.mode = 0o644
        m.uid = m.gid = 0
        m.uname = m.gname = "root"
        fixed.append((m, data))

    buf = io.BytesIO()
    with tarfile.open(fileobj=buf, mode="w:gz") as out:
        for m, data in fixed:
            if data is not None:
                m.size = len(data)
                out.addfile(m, io.BytesIO(data))
            else:
                out.addfile(m)

    with open(path, "wb") as f:
        f.write(buf.getvalue())

    print(f"已修复 {buggy} 个脚本的执行位，重新打包完成：{path}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
