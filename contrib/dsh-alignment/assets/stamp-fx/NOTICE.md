# 来源与授权

## 原作

- 作品:IP, PLEASE · 请出示你的 IP —— https://ip-please.github.io/
- 源码:https://github.com/ip-please/ip-please.github.io (查看于 2026-10-22,提交 a9ee903)
- 作者:ctnyanya(主要作者);提交记录里另有 Calvin Li、Hinson Chu 的贡献
- 代码许可:MIT,Copyright (c) 2026 ctnyanya
- 像素字体:Fusion Pixel Font(TakWolf),SIL Open Font License 1.1,只用于原版 `tools/assets/fonts/` 和 `assets.js` 里渲染出的字形
- README 说明:画面、音乐、音效均由程序生成;音效全部在浏览器里现场合成,没有音频文件

本目录随对齐页插件分发：`stamp-fx.js` 内联进 `cli/template.html`（`@stamp-fx-begin` / `@stamp-fx-end` 之间），改组件后跑 `assets/stamp-fx/tools/sync-template.mjs`。

## 本目录用了什么

- `stamp-fx.js`:按拆解重写的 DOM 实现。时长常量、震动偏移表、缺墨算法和盖章音效的合成方式(`sfx.js` 的 `stamp()` 与 `rng`、`biquad`)移植自原作代码,属于 MIT 授权范围,保留下方版权声明即可使用。
- 没有复制原作的图片、图集(`assets.js`)或字体文件。印迹在运行时画出：中文章字用内嵌的 Noto Serif SC 子集，其余文字用系统字体，见下文「字体」。
- `media/` 里的对比视频和逐帧截图含原作游戏画面(画面由 MIT 授权的代码生成,画面里的字形来自 OFL 字体),用于说明和对比,保留署名。

## 字体

- 中文章字内嵌了 Noto Serif SC 的子集（`stamp-fx.js` 里的 `SERIF_WOFF2`，字族名「StampFx Serif」）：© 2017-2023 Adobe，SIL Open Font License 1.1（https://openfontlicense.org ），原字体没有 Reserved Font Name。做法：取本机 `NotoSerifSC-VF.ttf`，用 fontTools 固定到字重 900，只留「已发送回复确认待修改暂缓放弃恢复」15 个字，存成 woff2（4.5 KB）。OFL 允许这样修改并随软件分发，条件是每份副本都带上版权声明和许可全文、字体本身不单独出售：全文在同目录的 `OFL.txt`，子集的字体 name 表也保留了许可说明和链接（nameID 13 / 14）。
- 一行字里有子集之外的中文（比如选项名）时，这一行整行按系统字体链取：Noto Serif SC / Source Han Serif SC（装了才有，不是 Windows 默认字体），否则宋体（SimSun、Songti SC），同一枚章不混用两种字重。不内嵌。
- 英文和数字（章上的日期）用 Windows 10 起自带的 Bahnschrift，只按字体名调用，不打包、不分发；没有时退到 DIN / Arial Narrow / 无衬线。

## MIT 许可原文(原作)

~~~text
MIT License

Copyright (c) 2026 ctnyanya

Permission is hereby granted, free of charge, to any person obtaining a copy
of this software and associated documentation files (the "Software"), to deal
in the Software without restriction, including without limitation the rights
to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
copies of the Software, and to permit persons to whom the Software is
furnished to do so, subject to the following conditions:

The above copyright notice and this permission notice shall be included in all
copies or substantial portions of the Software.

THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
SOFTWARE.
~~~
