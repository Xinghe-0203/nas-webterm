#!/usr/bin/env python3
"""把 Nerd Font 裁成一份精简子集，交给 Web 终端内置。

为什么要子集：完整 Nerd Font 有 1MB+（woff2），但终端里实际用到的
只是几十个图标字形。裁完只剩几十 KB，装进 fpk 几乎没有负担。

裁剪策略：
  * 保留 ASCII + 常用拉丁 + CJK 常用区（终端要显示中文）
  * 保留 Nerd Font 私有区里「最常用」的一段（U+E000–U+F8FF 的常用图标）
  * 输出 woff2（浏览器直接用）

用法：
  python3 tools/subset-font.py <源字体.woff2> <输出.woff2>
"""

import sys
from fontTools import subset
from fontTools.ttLib import TTFont


def main() -> None:
    if len(sys.argv) != 3:
        print("用法: python3 tools/subset-font.py <源.woff2> <输出.woff2>", file=sys.stderr)
        sys.exit(2)
    src, dst = sys.argv[1], sys.argv[2]

    font = TTFont(src)
    cmap = font.getBestCmap()
    if cmap is None:
        print("字体没有 cmap 表", file=sys.stderr)
        sys.exit(1)

    keep = set()
    # ASCII
    keep.update(range(0x20, 0x7F))
    # 常用拉丁补充
    keep.update(range(0xA0, 0x100))
    # 常用标点 / 符号
    for cp in (0x2013, 0x2014, 0x2018, 0x2019, 0x201C, 0x201D, 0x2022, 0x2026,
               0x2190, 0x2191, 0x2192, 0x2193, 0x21B5, 0x2212, 0x00D7, 0x00B7,
               0x25A0, 0x25A1, 0x25B2, 0x25B6, 0x25BC, 0x25C0, 0x25CF, 0x2605,
               0x2606, 0x2713, 0x2714, 0x2717, 0x2718, 0x2764, 0x2B50):
        keep.add(cp)
    # CJK 常用汉字区（终端里要显示中文）
    keep.update(range(0x4E00, 0x9FA6))
    # CJK 符号与标点
    keep.update(range(0x3000, 0x3040))
    keep.update(range(0xFF00, 0xFFEF))
    # Nerd Font 私有区：**完整保留**。
    #
    # 私有区一共 3500 个码点，全留只让 woff2 多了约 200KB，换来的是
    # 任何主题（oh-my-posh / starship / powerline prompt）用到的图标
    # 都能正常显示——按需挑码点总会漏掉几个，用户看到的还是方块。
    keep.update(range(0xE000, 0xF8FF))

    # 只保留字体里真实存在的码点
    present = sorted(cp for cp in keep if cp in cmap)
    options = subset.Options()
    options.flavor = "woff2"
    options.desubroutinize = True
    options.drop_tables += ["DSIG"]
    options.layout_features = ["*"]
    options.name_IDs = ["*"]
    options.notdef_outline = True
    options.recalc_bounds = True
    options.recalc_timestamp = False

    subsetter = subset.Subsetter(options=options)
    subsetter.populate(unicodes=present)
    subsetter.subset(font)

    # 注意：OS/2 的 unicode-range 位图在 woff2 保存时会被重算，
    # 改不动也没关系——前端在 @font-face 里显式声明了 unicode-range，
    # 浏览器据此判断覆盖范围。

    font.flavor = "woff2"
    font.save(dst)
    print(f"子集完成：{len(present)} 个码点 → {dst}")


if __name__ == "__main__":
    main()
