---
name: figma-bridge
description: 通过本地桥接读取与生成 Figma UI：解析 figma.com 链接读取设计稿结构（REST API + 免费个人 token），由 AI 生成界面（SVG/节点）并通过 WebSocket 桥接写回 Figma 桌面端。当用户给出 Figma 链接要求读取/分析/复刻设计稿，或要求在 Figma 中生成、修改、补充 UI 页面时使用。Read, generate and edit Figma UI pages via a local WebSocket bridge.
---

# Figma Bridge：读取设计稿 + 生成 UI 写回 Figma

通过 `figma-bridge` MCP 服务器的工具完成。分两类：**读**（`figma_get_file`、`figma_get_images`，走 REST API，需要用户的免费 Figma token）和**写**（`create_frame`、`create_text`、`create_node_from_svg`、`export_node_image`、`execute_figma_code`，走本地 WebSocket 桥，需要 Figma 桌面端运行 companion 插件）。

## 0. 每次开始前

1. 调用 `bridge_status` 检查状态。`ws_server` 显示 listening 且 `plugin_connected: true` 才能写回。
2. 若未连接：提示用户打开 Figma 桌面端 → 菜单 插件 → 开发中 → 运行 "Figma Bridge (ZCode)" → 点"连接"。**不要反复重试写工具**，等用户确认。
3. `bridge_status` 返回的 `info` 里有当前文件名、页面、选区——写回时优先用 `pageId`/选区节点作为目标，并向用户确认目标文件。

## 1. 解析 Figma 链接

链接形如 `https://www.figma.com/design/<fileKey>/<名称>?node-id=<n>-<m>`。工具直接接受完整链接（内部提取 fileKey 和 node-id），不必手工解析。REST 调用中 node-id 的 `-` 要写成 `:`。

## 2. 读取/分析设计稿

1. `figma_get_file`（可带 `depth: 1` 先看顶层，再对关键节点取深层）。
2. 拿到节点 ID 后用 `figma_get_images` 渲染截图查看外观。
3. 若报"缺少 token"：请用户提供 token——figma.com → Settings → Security → Personal access tokens（免费，只读权限即可），然后本次调用传入 `token` 参数；用户若已设置 `FIGMA_TOKEN` 环境变量则无需此步。**不要把 token 写进任何文件。**

## 3. 生成 UI 写回（核心流程）

1. **定目标**：和用户确认写入哪个文件/页面。新页面用 `execute_figma_code` 创建：
   `const p = figma.createPage(); p.name = "AI 生成"; return { pageId: p.id };`
2. **生成整页 UI**：优先用 `create_node_from_svg` 一次性导入每个界面（一屏一个 SVG）。
   - 根元素必须带 `width`、`height`、`viewBox`，尺寸即设计稿尺寸（如 390×844 移动端、1440×900 桌面端）。
   - 绝对坐标布局，自己计算每个元素的位置；背景用大矩形。
   - 颜色用十六进制 fill；圆角用 `rx`；图标用简单 path/几何形状画，不要引用外部图片。
   - `<text>` 会转成矢量轮廓（视觉正确但不可编辑）；**中文绝不能写进 SVG 的 `<text>`**——Figma 的 SVG 渲染器不做字体回退，中文字形会被直接丢弃（英文/数字正常）。SVG 里只放图形、图标和英文/数字；所有中文文案用 `create_text` 按坐标叠加（可自动回退中文字体、可编辑）。
3. **可编辑结构**（用户需要维护图层结构时）：用 `create_frame`/`create_text` 搭骨架，或 `execute_figma_code` 设置自动布局。
4. **自查迭代**：拿到返回的节点 id，调 `export_node_image`（scale 1~2）查看截图；对照预期修正位置、配色、字号（重点检查中文是否缺失）后再导出确认。至少自查一轮。

## 4. 故障排查

- `没有插件连接到桥`：用户没运行插件或没点连接；端口需与插件面板里的地址一致（默认 ws://localhost:3055，服务端口可用环境变量 `FIGMA_BRIDGE_PORT` 改）。
- 面板日志显示`密钥校验失败`：服务端设置了 `FIGMA_BRIDGE_SECRET` 而插件面板密钥缺失或不一致，请用户改一致后重连。
- `ws server error: EADDRINUSE`：另一个 ZCode 会话已启动了桥。让那个会话执行写操作，或用户换端口（两边都要改）。
- REST 401/403：token 无效或无文件权限，重新生成 token 并确认账号能打开该文件。
- 生成物位置不对：用 `bridge_status` 里的 `pageId` 明确指定，或让用户切到目标页面。
