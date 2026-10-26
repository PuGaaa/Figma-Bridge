# figma-bridge

**让 AI 编码助手直接读写 Figma。** 给一个 figma.com 链接即可读取设计稿结构，由 AI 生成整套 UI 页面并写回你的 Figma 文件——本地 WebSocket 桥接，无需 Figma 付费席位，无需官方 MCP。

*Let your AI coding assistant read and write Figma: parse design files by link, generate whole UI pages, and push them back into your file via a local WebSocket bridge. No paid Figma seat, no official MCP required.*

## 功能

- **读**：`figma_get_file` / `figma_get_images` 通过 Figma REST API 读取文件结构、图层样式和节点截图（需免费个人 token）
- **写**：`create_frame` / `create_text` / `create_node_from_svg` / `execute_figma_code` 通过本机桥接在 Figma 中创建画板、文本、整页 SVG 和执行任意 Plugin API 代码
- **自查**：`export_node_image` 直接从 Figma 导出 PNG，AI 生成后自动截图检查、迭代修正
- **技能编排**：内置 SKILL 指导 AI 走完「读链接 → 分析 → 生成 → 写回 → 截图自查」全流程

组成：`mcp/server.mjs`（零依赖 MCP 服务器，Node ≥ 18）+ `skills/figma-bridge/`（技能）+ `figma-plugin/`（Figma 桌面端 companion 插件）。

## 安全模型（使用前必读）

- 桥接服务**仅监听 127.0.0.1**，只有本机进程可以连接；未配置密钥时任何本机进程均可驱动你的 Figma，如在多人共用机器上建议启用共享密钥（见环境变量）。
- `execute_figma_code` 允许 AI 在你的 Figma 文件中执行任意操作（创建/删除图层、新建页面等）。这是设计能力，请只在你能接受该风险的文件中使用。
- Figma token 只经环境变量或会话内参数传递，本插件不存储、不外传任何密钥。
- 写操作以你桌面端已登录的身份执行，与手绘图层无异。

## 安装（三步）

1. **装 ZCode 插件**：把本仓库克隆到本地，在 ZCode 里 插件市场 → 添加 → 添加插件市场 → 选择本目录（含 `marketplace.json`）→ 个人 → Figma Bridge → 安装。
2. **装 Figma 端插件**：打开 Figma **桌面端**（浏览器版不支持），双击打开任意设计文件进入编辑器 → 左上角 Figma 主菜单 → Plugins → Development → **Import plugin from manifest…** → 选择 `figma-plugin/manifest.json`。
3. **生成 Figma token（可选，仅读取设计稿时需要）**：figma.com → Settings → Security → Personal access tokens → 生成（免费账号即可，只读权限足够）。

## 使用

1. Figma 桌面端打开目标文件，运行 Plugins → Development → **Figma Bridge (ZCode)**，点"连接"，保持窗口开着。
2. 在 ZCode 新建任务，选 Figma Bridge 技能，例如：

   > 直接制作一个移动端记账 App 的设计稿：首页、记账页、统计页
   >
   > 读取 https://www.figma.com/design/<fileKey>/xxx 的风格，在这个文件里生成一套同风格的登录页

3. AI 自动建页、生成 UI、导出截图自查后交付。

## 环境变量

| 变量 | 说明 |
| --- | --- |
| `FIGMA_TOKEN` | Figma 个人访问令牌，读取设计稿时需要。GUI 版 ZCode：`launchctl setenv FIGMA_TOKEN figd_xxx` 后重启 ZCode；或按次把 token 直接发给 AI |
| `FIGMA_BRIDGE_SECRET` | 可选共享密钥。设置后，Figma 插件面板须填入相同密钥才能连接 |
| `FIGMA_BRIDGE_PORT` | 桥接端口，默认 3055；修改后 Figma 插件面板地址需同步修改 |
| `FIGMA_BRIDGE_TIMEOUT_MS` | 写命令超时，默认 60000 |

## 已知边界与经验

- **Figma 不允许 API 创建云端新文件**：先手动新建/打开一个文件，其余全部交给 AI。
- **SVG 里的中文会丢失**（重要经验）：Figma 的 `createNodeFromSvg` 不做字体回退，SVG `<text>` 中的 CJK 字形被直接丢弃（英文/数字正常），且 SVG 文本会转为不可编辑的矢量轮廓。正确姿势：SVG 只画图形、图标和英文，中文文案一律用 `create_text` 叠加真实文本图层——本插件内置的技能流程已强制执行此规则。
- 生成质量取决于模型；整页 UI 推荐"一屏一个 SVG + 中文文本叠加"的模式。

## 故障排查

| 现象 | 处理 |
| --- | --- |
| 面板显示"连接失败" | 桥接服务未启动：在 ZCode 会话里调用任一 figma-bridge 工具即可拉起，然后再点连接 |
| 日志出现"密钥校验失败" | 面板密钥与服务端 `FIGMA_BRIDGE_SECRET` 不一致，改一致后重连 |
| `没有插件连接到桥` | Figma 桌面端未运行插件或未点连接；确认面板地址端口与服务端一致 |
| REST 401/403 | token 无效或账号无该文件权限，重新生成 token |
| `EADDRINUSE` | 另一个会话已启动桥；让那个会话执行写操作，或两边同步改端口 |

## 致谢

架构受 [cursor-talk-to-figma-mcp](https://github.com/sonnylazuardi/cursor-talk-to-figma-mcp) 一类「本地 WebSocket 桥 + Figma 端插件」方案的启发，实现为原创代码，并针对 ZCode 增加了技能编排、截图自查流程与 CJK 文本处理规则。

## License

[MIT](LICENSE)
