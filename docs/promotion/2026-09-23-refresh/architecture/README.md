# 搬迁业务工作台与移动受控只读架构图

## 产物概览

- `architecture.json`：架构定义规范源文件。
- `architecture.html`：经 `archify deliver` 检验并原子提交的独立交互式交付物。
- `architecture.share.png`：通过 HTML 内置光栅化导出功能生成的无工具栏纯净静态架构图，分辨率为 5360 × 1776 px，适配高清分享。
- `architecture.deliver.json`：deliver 命令执行输出的原始交付回执数据。
- `architecture.export.json`：内置导出回执记录（包含导出格式、字节数及 DOM 导出属性）。
- `architecture.visual-check.json` 与 `architecture.visual-check.html`：自动化浏览器核验证据回执与联络单。
- `architecture.visual-check.*.png`：自动化浏览器多视口与多主题渲染快照（1440×900 与 2048×1320 的浅色/深色截图）。

---

## 9 项 Artifact 检查与 Showcase 校验

执行 `archify deliver architecture ... --quality showcase` 校验结果全部通过（0 errors, 0 warnings）：

1. `single_svg`：通过（包含唯一有效根 SVG 块）。
2. `finite_svg`：通过（所有几何元素坐标与尺寸均为有限数值）。
3. `orthogonal_arrows`：通过（全部连接为直角正交或轴向平直线）。
4. `label_route_clearance`：通过（测得最小安全间隙为 90.1 px，高于规范要求的 8 px 限制）。
5. `relationship_crossings`：通过（无非规划交叉）。
6. `relationship_corridors`：通过（无重叠或歧义通道）。
7. `container_border_runs`：通过（区域边框未与内部连线共线）。
8. `route_rhythm`：通过（折角数 ≤ 2，拉伸比 1.0，最小线段 100 px）。
9. `legend_clearance`：通过（图例位置与主架构区域留白充分）。

---

## 文件哈希与字节回执（经 fs stat 与 sha256 实际核验）

| 文件名 | 大小 (Bytes / stat.size) | SHA-256 哈希值 | 说明 |
|---|---|---|---|
| `architecture.json` | 6,296 | `b8fa13bde88832496d7b9efaa45800e64337196983a1e2a38bd0a613dd868b50` | 架构定义规范源文件 |
| `architecture.html` | 810,941 | `7b4b538030c0fbe3bad56bf252c923eb028bba3b626f68bf428d0d64527b5994` | 交付原子提交的独立交互式交付物 |
| `architecture.share.png` | 527,362 | `dd0f8e670dac88c6a9b83b6f74298482e1d12dce00b464227958e0dc206d4d2c` | 内置导出的 5360×1776 高清纯净静态架构图 |
| `architecture.deliver.json` | 794 | `71ba5204271eec8a9102a79ec7d4b37b00dfe3f40685b1c9bc5c494397ef5720` | deliver 工具原始执行回执 |
| `architecture.export.json` | 208 | `521ee410821b68ce5f825154aae5b902f0eef9e65bdfceaf6b6e9dd2c46cdc45` | 内置导出记录回执 |
| `architecture.visual-check.json` | 17,122 | `9f0d0e13f267cf2299d3bd410caa25e65f820ed543e1e67103ba19c0f15330be` | 自动化浏览器核验证据回执 |
| `architecture.visual-check.html` | 1,916 | `ff68109bcd17d3636dfc5d71e4b5bd5c0569805dce07ec9704d8762c306645d0` | 自动化浏览器核验联络单 |
| `architecture.visual-check.1440x900.light.png` | 188,934 | `047562c38156b4b5b08990269f6aaa8b1f60cef0bb76b94a7d0d2b7e55146c69` | 自动化浏览器渲染快照（1440×900 浅色） |
| `architecture.visual-check.1440x900.dark.png` | 180,182 | `33fc04e1ba3abcf50addcc81505df89fa122cd3ee9a2e553e9e370c8e9d5c0b3` | 自动化浏览器渲染快照（1440×900 深色） |
| `architecture.visual-check.2048x1320.light.png` | 234,738 | `84e1bb46e03a8c813c764df008c72d27cdc3a5bcfaef8175e8ec9a5ef845e1b6` | 自动化浏览器渲染快照（2048×1320 浅色） |
| `architecture.visual-check.2048x1320.dark.png` | 221,717 | `38e75f28f551759a1f8956b67df3db06027e4f71087438c38f96743d8740fe8d` | 自动化浏览器渲染快照（2048×1320 深色） |

---

## 自动化浏览器验证（Browser Evidence）客观测量事实

使用 Chrome DevTools 协议对交付后的 `architecture.html` 进行无损实机运行测量（`visual-check` 命令）：
- **视口覆盖**：1440×900 (Light / Dark)、1600×1000 (Light)、1920×1080 (Light)、2048×1320 (Light / Dark)。
- **包含性测量**：4 组桌面视口下均测得 `scrollWidth <= innerWidth` 且 `scrollHeight <= innerHeight`，实际未触发横向或纵向外层滚动条。
- **文字投影测量**：测得最小投影字号为 9.0 px（高于 6.0 px 阈值要求）。
- **控件间距测量**：导航坞与图表区保留留白间距为 10.2 px（高于 ≥ 10.0 px 阈值要求）。

---

## 图像审阅事实（Perceptual Visual Review）

基于实机渲染快照与导出图像进行审阅（非人类主观审阅，严格以渲染像素为准）：
1. **拓扑区域**：桌面运行环境与独立只读环境分别呈两个独立橙色虚线框，水平相距 110 px。
2. **走线与文本位置**：连接线均为正交直角线或平直线；标签文字带有白色/深色背景矩形遮罩，位于连线中间段，不阻挡节点主要文字。
3. **内容客观性**：表述严格遵守代码与架构事实，包括本地 SQLite 权威写入、按需白名单快照推送、上传 Bearer 与查询 Basic 凭证分离、独立只读服务基于文件快照持久化且无业务库无写回、手机端不支持离线浏览等，不包含绝对化或夸大词汇。

---

## 内置导出方法与图片规格

- **导出方法**：通过无头 Chrome 实例加载已交付的 `architecture.html`，等待字体与布局就绪后，直接触发页面内的内置函数 `Archify.exportMenu.run(png)`，拦截渲染生成的 PNG Blob 并写入文件，同步完成 DOM 导出属性记录。
- **图片规格**：分辨率为 5360 × 1776 px（基于 viewBox 1340 × 444 的 4x 矢量栅格化），仅包含图表本身与图例，无外部浏览器边框与多余白边。
