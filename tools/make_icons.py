"""生成飞牛应用图标：深色圆角方块 + 白色音符。

输出：
  ICON.PNG            48x48
  ICON_256.PNG        256x256
  app/ui/images/icon_64.png
  app/ui/images/icon_256.png
"""
import os
from PIL import Image, ImageDraw

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))


def rounded(size, radius_ratio=0.22):
    img = Image.new("RGBA", (size, size), (0, 0, 0, 0))
    d = ImageDraw.Draw(img)
    r = int(size * radius_ratio)
    # 背景渐变（自上而下）
    for y in range(size):
        t = y / max(1, size - 1)
        c = (
            int(28 + (18 - 28) * t),
            int(46 + (28 - 46) * t),
            int(78 + (44 - 78) * t),
            255,
        )
        d.line([(0, y), (size, y)], fill=c)
    # 圆角遮罩
    mask = Image.new("L", (size, size), 0)
    ImageDraw.Draw(mask).rounded_rectangle([0, 0, size - 1, size - 1], radius=r, fill=255)
    img.putalpha(mask)
    return img


def note(img):
    """在图标中央画一个音符"""
    size = img.size[0]
    d = ImageDraw.Draw(img)
    u = size / 100.0

    # 符干
    x = 62 * u
    d.rounded_rectangle(
        [x - 3.2 * u, 26 * u, x + 3.2 * u, 66 * u],
        radius=3.2 * u,
        fill=(236, 244, 255, 255),
    )
    # 符头（椭圆）
    d.ellipse(
        [x - 15 * u, 58 * u, x + 1 * u, 74 * u],
        fill=(236, 244, 255, 255),
    )
    # 符尾
    d.polygon(
        [
            (x + 3 * u, 26 * u),
            (x + 20 * u, 33 * u),
            (x + 20 * u, 44 * u),
            (x + 3 * u, 37 * u),
        ],
        fill=(236, 244, 255, 255),
    )
    # 左下角小装饰点
    d.ellipse([24 * u, 64 * u, 30 * u, 70 * u], fill=(76, 154, 255, 255))
    return img


def make(size):
    return note(rounded(size))


def save(img, rel):
    path = os.path.join(ROOT, rel)
    os.makedirs(os.path.dirname(path), exist_ok=True)
    img.save(path, "PNG")
    print("wrote", rel, img.size)


if __name__ == "__main__":
    base = make(256)
    save(base.resize((48, 48), Image.LANCZOS), "ICON.PNG")
    save(base, "ICON_256.PNG")
    save(base.resize((64, 64), Image.LANCZOS), "app/ui/images/icon_64.png")
    save(base, "app/ui/images/icon_256.png")
