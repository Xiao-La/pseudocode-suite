# 开发说明

## 目录

```
pseudocode-suite/
├── main.js            ← 构建产物（发布用）
├── styles.css         ← 构建产物（发布用，内嵌字体）
├── manifest.json      ← 发布用
├── versions.json      ← 插件版本 → 最低 Obsidian 版本
├── build.py           ← 拼接 src/ → main.js，内嵌字体 → styles.css
├── src/
│   ├── core.js        ← AST、LaTeX 解析 / 生成、打字识别（typedLine）、纯文本粘贴解析（parsePlain）
│   ├── render.js      ← 渲染器（AST → DOM）
│   ├── builder.js     ← 可视化搭建器（含提示面板、底部提示）
│   ├── main.js        ← 插件入口（命令、代码块处理器、设置页）
│   └── styles.css
├── fonts/
│   ├── *.woff2        ← tools/make-fonts.py 生成的子集
│   ├── source/        ← 原始字体
│   └── LICENSE.md
├── docs/images/       ← README 截图
├── tools/make-fonts.py
└── tests/             ← node tests/test-*.js
```

## 构建与发布

```bash
python3 build.py
for t in core render main builder; do node tests/test-$t.js; done
```

本地开发：仓库在 `~/Code/Obsidian/pseudocode-suite`，两个库的 `.obsidian/plugins/pseudocode-suite` 都是指向它的符号链接；改完 `python3 build.py`，在 Obsidian 里重载插件即可。`data.json`（设置）不进仓库。

发布新版本：

1. 改 `manifest.json` 的 `version`；如果提高了最低 Obsidian 版本，在 `versions.json` 加一行 `"版本": "最低 Obsidian 版本"`。
2. `python3 build.py`，跑测试，提交并推送（`main.js`、`styles.css` 也要提交，工作流会检查它们和源码一致）。
3. 推送与版本号完全相同的 tag（不加 `v`）：`git tag 2.2.1 && git push origin 2.2.1`。`.github/workflows/release.yml` 会构建、测试，并建 Release 上传 `main.js`、`manifest.json`、`styles.css`。

首次上架（只做一次）：在 `obsidianmd/obsidian-releases` 的 `community-plugins.json` 末尾加一项，提 PR，等自动检查和人工审核。之后发新版只需要发 Release。

Obsidian 安装插件时只下载 `main.js`、`manifest.json`、`styles.css`，所以字体必须内嵌在 `styles.css` 里（`build.py` 负责）。

## 上架规范自查（已处理）

- 不用正则后行断言（iOS 16.4 以前不支持）：需要时在替换回调里检查前一个字符（`precededBy`、`inCommand`）。
- 不往页面插 `<style>`；样式全在 `styles.css`，动态值用 CSS 变量 + `setCssProps`，显隐用 class。
- 不用 `navigator.platform`，用 `Platform`；不用 `innerHTML`；不用全局 `app`；没有默认快捷键；命令 id / 名称不含插件名。
- 文件修改用 `Vault.process`（后台）或 `Editor`（当前编辑器）。
- `document.activeElement` 用 `activeDocument`（弹出窗口）。
- UI 文字用 sentence case。
- 另一个插件已注册 `pseudo` 代码块时不报错退出，而是提示用户。
- 目录审核的 CSS 检查：不用 `!important`、`:has`（有注释的块由渲染器加 class `ps-commented`）、`display: contents` 和 `subgrid`（每行的单元格直接放进整块的 grid，带着该行的 class 和缩进；审核按 Obsidian 1.4.5 即 Chrome 114 检查）、`column-gap`（用 `gap` 简写）、自定义元素选择器（`mjx-mo`）。
- `LICENSE` 保持标准 MIT 原文，GitHub 才能识别；字体许可放在 `fonts/LICENSE.md`。
- 发布工作流给 `main.js`、`manifest.json`、`styles.css` 生成 GitHub artifact attestation。

## 实现要点

- 渲染器直接产出 CLRS 版式的 DOM；导出 PDF 时一致。
- 数学片段用 Obsidian 的 `renderMath` 同步排版（`PS.typesetMath`），输出与笔记中的行内公式相同；出错时退回 `MarkdownRenderer`。`finishRenderMath()` 较慢（约 100ms，块在此之前隐藏，class `ps-pending`），所以排好的公式按 TeX 缓存（LRU，4000 条），重绘时直接克隆。缓存不跨会话。
- 操作符别名（`\gets`、`:=`、`&&`…）和 ASCII → TeX 的转换在 `core.js` 里各只有一张表，搭建器、序列化和渲染共用。
- 编辑按钮点击时才用 `getSectionInfo` 取当前行号，再按块内容核对；内容相同的块取离该行最近的一个。
- 解析器把数学上下文记在 AST 里（`textMath` / `condMath` / `argsMath`…），渲染时还原 `$...$`，下标不会以源码形式漏出。
- 搭建器预览走 `serialize → parse → render`，与保存后的结果一致。
- 打字转换只在“刚打出”时触发（与上一次的值 `settled` 比较），输入法组字期间跳过，`compositionend` 时再判断；每次转换是一个撤销步骤。
- 手写块里的独立 `\Comment{…}` 行并到上一条语句的行尾（LaTeX 的语义）；搭建器里输入或粘贴的 `// …` 行保存为 `\State \Comment{…}`，单独占一行。
- 设置里的 `builderTips` 记录提示面板是否展开；它不影响渲染，所以用 `saveSettingsOnly` 保存，不重绘已渲染的块。
- 存储用的方言和导出不同：保存时写插件自己认的命令（`\Elif`、`\Print`、`\To`、`\ParFor`、`\Switch`/`\Case`/`\Default`、`% highlight`、`\setcounter{ALG@line}{k}`），`PS.exportLatex` 另外生成标准 algpseudocode（`\ElsIf`、`\State \Return`、`\textbf{to}`、`\makeatletter…`，需要的 `\algdef` 写在开头注释里）。
- 行的附加信息（`\label`、高亮）记在节点上，键名由 `PS.metaKey(prefix, name)` 决定：if 的 else 行是 `elseLabel` / `elseMark`，repeat 的 until 行是 `untilLabel` / `untilMark`，elif 分支记在各自的 branch 上。`\ref{}` 在 `PS.buildRows` 里解析成行号。
- 不带 `\` 的输入框内容序列化时经 `escapePlain` 转义 `% & # $ { }`（`^` / `_` 后的组除外），`snake_case` 写成 `\mathit{a\_b}`；`fromMath` 读回时再还原，所以输入框里看到的就是打的字。
- `\End…` 只关闭同类的最近一层（`closeTo`），对不上的忽略；`\Case` / `\Default` 遇到下一个 case 自动收尾。
- 粘贴解析（`parsePlain`）先判断风格：`python`（行尾 `:`）、`braces`（`{ }`）或显式 end；不带大括号的 `if` / `for` 只拥有下一条语句（`settle()`）。
- Canvas 文件是 JSON：编辑时按内容找到卡片；画布开着就通过 `view.canvas.nodes` 的 `setText` 修改（内部接口，可能变），否则用 `vault.process` 只替换那张卡片的 `text` 字符串。
