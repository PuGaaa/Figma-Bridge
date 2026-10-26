#!/usr/bin/env node
// figma-bridge MCP server
// - stdio: speaks the Model Context Protocol (newline-delimited JSON-RPC 2.0)
// - WebSocket bridge on ws://localhost:PORT: the companion Figma desktop plugin
//   connects here; write tools are forwarded to it as commands.
// - Read tools call the Figma REST API with the user's personal access token
//   (env FIGMA_TOKEN, or a per-call `token` argument).
// Zero runtime dependencies; requires only Node >= 18 (fetch built in).

import { createServer } from 'node:http';
import { createHash, randomUUID } from 'node:crypto';
import { createInterface } from 'node:readline';

const VERSION = '0.1.0';
const PORT = Number(process.env.FIGMA_BRIDGE_PORT || 3055);
const CMD_TIMEOUT_MS = Number(process.env.FIGMA_BRIDGE_TIMEOUT_MS || 60000);
const FIGMA_API = 'https://api.figma.com';

const log = (...a) => console.error('[figma-bridge]', ...a);

class BridgeError extends Error {}
class ApiError extends Error {}

/* ------------------------------------------------------------------ */
/* WebSocket bridge (RFC 6455, minimal server side)                    */
/* ------------------------------------------------------------------ */

const channels = new Map(); // channel name -> { socket, info, connectedAt }
const pending = new Map(); // callId -> { resolve, reject, timer }
let wsServerError = null;

const WS_GUID = '258EAFA5-E914-47DA-95CA-C5AB0DC85B11';
function wsAccept(key) {
  return createHash('sha1').update(key + WS_GUID).digest('base64');
}

function wsFrame(opcode, payload) {
  const len = payload.length;
  let header;
  if (len < 126) {
    header = Buffer.from([0x80 | opcode, len]);
  } else if (len < 65536) {
    header = Buffer.alloc(4);
    header[0] = 0x80 | opcode;
    header[1] = 126;
    header.writeUInt16BE(len, 2);
  } else {
    header = Buffer.alloc(10);
    header[0] = 0x80 | opcode;
    header[1] = 127;
    header.writeBigUInt64BE(BigInt(len), 2);
  }
  return Buffer.concat([header, payload]);
}

function send(socket, obj) {
  if (socket.destroyed) return;
  socket.write(wsFrame(0x1, Buffer.from(JSON.stringify(obj), 'utf8')));
}

function attachWebSocket(socket) {
  let buf = Buffer.alloc(0);
  let frags = [];
  let fragOpcode = 0;
  socket.setNoDelay(true);

  function parseOne() {
    if (buf.length < 2) return null;
    const b0 = buf[0];
    const b1 = buf[1];
    const fin = (b0 & 0x80) !== 0;
    const opcode = b0 & 0x0f;
    const masked = (b1 & 0x80) !== 0;
    let len = b1 & 0x7f;
    let off = 2;
    if (len === 126) {
      if (buf.length < off + 2) return null;
      len = buf.readUInt16BE(off);
      off += 2;
    } else if (len === 127) {
      if (buf.length < off + 8) return null;
      len = Number(buf.readBigUInt64BE(off));
      off += 8;
    }
    if (len > 64 * 1024 * 1024) throw new Error('frame too large');
    const maskLen = masked ? 4 : 0;
    if (buf.length < off + maskLen + len) return null;
    let payload = buf.subarray(off + maskLen, off + maskLen + len);
    if (masked) {
      const mask = buf.subarray(off, off + 4);
      const out = Buffer.allocUnsafe(len);
      for (let i = 0; i < len; i++) out[i] = payload[i] ^ mask[i & 3];
      payload = out;
    }
    buf = buf.subarray(off + maskLen + len);
    return { fin, opcode, payload };
  }

  function handleFrame(socket, f) {
    if (f.opcode === 0x8) {
      socket.write(wsFrame(0x8, f.payload.subarray(0, 2)));
      socket.end();
      return;
    }
    if (f.opcode === 0x9) {
      socket.write(wsFrame(0xa, f.payload));
      return;
    }
    if (f.opcode === 0xa) return;

    if (f.opcode === 0x1 || f.opcode === 0x2 || f.opcode === 0x0) {
      if (!f.fin) {
        if (f.opcode !== 0x0) {
          fragOpcode = f.opcode;
          frags = [f.payload];
        } else if (frags.length) {
          frags.push(f.payload);
        }
        return;
      }
      let payload = f.payload;
      if (f.opcode === 0x0) {
        frags.push(payload);
        payload = Buffer.concat(frags);
        frags = [];
      }
      let msg;
      try {
        msg = JSON.parse(payload.toString('utf8'));
      } catch {
        return;
      }
      handlePluginMessage(socket, msg);
    }
  }

  socket.on('data', (chunk) => {
    buf = Buffer.concat([buf, chunk]);
    try {
      for (;;) {
        const f = parseOne();
        if (!f) break;
        handleFrame(socket, f);
      }
    } catch (e) {
      log('ws parse error:', e.message);
      socket.destroy();
    }
  });

  const cleanup = () => {
    const name = socket._channel;
    if (name && channels.get(name)?.socket === socket) {
      channels.delete(name);
      log('plugin disconnected from channel', name);
    }
  };
  socket.on('close', cleanup);
  socket.on('error', cleanup);
}

const SECRET = process.env.FIGMA_BRIDGE_SECRET || '';

function handlePluginMessage(socket, msg) {
  if (msg.type === 'hello') {
    if (SECRET && msg.secret !== SECRET) {
      send(socket, { type: 'auth_error', message: '共享密钥缺失或不匹配（FIGMA_BRIDGE_SECRET）' });
      log('rejected plugin hello: bad/missing secret');
      socket.destroy();
      return;
    }
    const name = String(msg.channel || 'default');
    channels.set(name, { socket, info: msg.info || null, connectedAt: Date.now() });
    socket._channel = name;
    send(socket, { type: 'hello_ack', channel: name });
    log(`plugin connected on channel "${name}"`);
    return;
  }
  if (msg.type === 'info') {
    const c = channels.get(socket._channel);
    if (c) c.info = msg.info || c.info;
    return;
  }
  if (msg.type === 'pong') return;
  if (msg.id !== undefined && pending.has(msg.id)) {
    const p = pending.get(msg.id);
    pending.delete(msg.id);
    clearTimeout(p.timer);
    if (msg.ok) p.resolve(msg.result);
    else p.reject(new BridgeError(msg.error || '插件执行出错（无错误信息）'));
  }
}

function bridgeCall(channelName, command, params) {
  const name = channelName || 'default';
  const c = channels.get(name);
  if (!c) {
    throw new BridgeError(
      `没有插件连接到桥（channel "${name}"）。请让用户：1) 打开 Figma 桌面端；2) 运行 Figma Bridge (ZCode) 插件；3) 在插件面板点击"连接"。` +
        `可用 bridge_status 查看当前连接状态。`
    );
  }
  const id = randomUUID();
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      pending.delete(id);
      reject(new BridgeError(`插件响应超时（${CMD_TIMEOUT_MS}ms）：命令 ${command}。请用 bridge_status 检查连接是否仍然存在。`));
    }, CMD_TIMEOUT_MS);
    pending.set(id, { resolve, reject, timer });
    send(c.socket, { id, command, params: params || {} });
  });
}

const httpServer = createServer((req, res) => {
  res.writeHead(200, { 'Content-Type': 'text/plain' });
  res.end('figma-bridge websocket server\n');
});
httpServer.on('upgrade', (req, socket) => {
  const key = req.headers['sec-websocket-key'];
  if (!key) {
    socket.destroy();
    return;
  }
  socket.write(
    'HTTP/1.1 101 Switching Protocols\r\n' +
      'Upgrade: websocket\r\n' +
      'Connection: Upgrade\r\n' +
      `Sec-WebSocket-Accept: ${wsAccept(key)}\r\n\r\n`
  );
  attachWebSocket(socket);
});
httpServer.on('error', (e) => {
  wsServerError = e;
  log('ws server error:', e.message);
});
httpServer.listen(PORT, '127.0.0.1', () => log(`ws bridge listening on ws://127.0.0.1:${PORT} (loopback only)`));

/* ------------------------------------------------------------------ */
/* Figma REST helpers                                                  */
/* ------------------------------------------------------------------ */

function parseTarget(input) {
  if (!input) throw new ApiError('缺少 file：请传入完整 Figma 链接或 fileKey。');
  const s = String(input).trim();
  const m = s.match(/figma\.com\/(?:design|file|proto|board|slides)\/([A-Za-z0-9]+)/);
  if (m) {
    let nodeId = null;
    const nm = s.match(/node-id=([\d.-]+)/);
    if (nm) nodeId = nm[1].replace(/-/g, ':');
    return { fileKey: m[1], nodeId };
  }
  if (/^[A-Za-z0-9]{6,}$/.test(s)) return { fileKey: s, nodeId: null };
  throw new ApiError(`无法识别的 Figma 链接或 fileKey: ${s}`);
}

async function figmaApi(path, token) {
  const t = token || process.env.FIGMA_TOKEN;
  if (!t) {
    throw new ApiError(
      '缺少 Figma token。请用户在 figma.com → Settings → Security → Personal access tokens 免费生成只读 token，' +
        '然后设置环境变量 FIGMA_TOKEN，或在本次调用传入 token 参数。'
    );
  }
  let res;
  try {
    res = await fetch(FIGMA_API + path, { headers: { 'X-Figma-Token': t } });
  } catch (e) {
    throw new ApiError(`访问 Figma API 失败（网络错误: ${e.message}）。请检查网络连接。`);
  }
  if (res.status === 403) throw new ApiError('Figma API 返回 403：token 无效，或该 token 的账号没有此文件的访问权限。');
  if (res.status === 404) throw new ApiError('Figma API 返回 404：文件不存在或 fileKey 有误。');
  if (res.status === 429) throw new ApiError('Figma API 限流（429），请稍后重试。');
  if (!res.ok) throw new ApiError(`Figma API 错误 ${res.status}: ${(await res.text()).slice(0, 300)}`);
  return res.json();
}

function hexToFills(hex) {
  if (hex == null) return undefined;
  const list = Array.isArray(hex) ? hex : [hex];
  return list.map((h) => {
    let s = String(h).trim().replace(/^#/, '');
    if (/^[0-9a-fA-F]{3}$/.test(s)) s = s.split('').map((c) => c + c).join('');
    let a = 1;
    if (s.length === 8) {
      a = parseInt(s.slice(6, 8), 16) / 255;
      s = s.slice(0, 6);
    }
    if (s.length !== 6) throw new ApiError(`无法解析颜色: ${h}（请用 #RRGGBB 或 #RRGGBBAA）`);
    const n = parseInt(s, 16);
    return {
      type: 'SOLID',
      color: { r: ((n >> 16) & 255) / 255, g: ((n >> 8) & 255) / 255, b: (n & 255) / 255 },
      opacity: a,
    };
  });
}

/* ------------------------------------------------------------------ */
/* MCP tools                                                           */
/* ------------------------------------------------------------------ */

const text = (s) => ({ content: [{ type: 'text', text: s }] });
const jtext = (obj) => text(typeof obj === 'string' ? obj : JSON.stringify(obj, null, 2));

const channelProp = {
  channel: { type: 'string', description: '桥接频道名，默认 default。与 Figma 插件面板里填写的频道一致。' },
};

const TOOLS = [
  {
    name: 'bridge_status',
    description:
      '查看 Figma 桥接状态：WebSocket 服务是否在监听、哪些频道有 Figma 插件连接、插件所在文件/当前页面/选中图层。写回 Figma 之前先调用它确认连接。',
    inputSchema: { type: 'object', properties: {} },
    run: async () =>
      jtext({
        ws_server: wsServerError ? `error: ${wsServerError.message}` : `listening on ws://localhost:${PORT}`,
        plugin_connected: channels.size > 0,
        channels: [...channels.entries()].map(([n, c]) => ({
          channel: n,
          connected_at: new Date(c.connectedAt).toISOString(),
          info: c.info,
        })),
      }),
  },
  {
    name: 'figma_get_file',
    description:
      '通过 Figma REST API 读取文件或指定节点的结构（需要 Figma token）。接受完整 Figma 链接或 fileKey。用于分析已有设计稿的布局、样式与图层。',
    inputSchema: {
      type: 'object',
      properties: {
        file: { type: 'string', description: '完整 Figma 链接或 fileKey' },
        node_id: { type: 'string', description: '可选：只读取该节点子树。链接中 node-id 的 "-" 需写成 ":"，如 1:2。链接里带 node-id 时自动使用。' },
        depth: { type: 'number', description: '可选：遍历深度，1 只取顶层。建议先浅后深。' },
        geometry: { type: 'string', enum: ['paths'], description: '可选：返回矢量路径数据。' },
        token: { type: 'string', description: '可选：未设置 FIGMA_TOKEN 环境变量时直接传入 token。' },
      },
      required: ['file'],
    },
    run: async (a) => {
      const { fileKey, nodeId } = parseTarget(a.file);
      const q = new URLSearchParams();
      const ids = a.node_id || nodeId;
      if (ids) q.set('ids', ids);
      if (a.depth) q.set('depth', String(a.depth));
      if (a.geometry) q.set('geometry', a.geometry);
      const qs = q.toString();
      const data = await figmaApi(`/v1/files/${fileKey}${qs ? '?' + qs : ''}`, a.token);
      return jtext(data);
    },
  },
  {
    name: 'figma_get_images',
    description: '通过 Figma REST API 渲染文件中节点的截图 URL（需要 Figma token）。返回可直接下载的 PNG/SVG 链接，用于查看设计稿外观。',
    inputSchema: {
      type: 'object',
      properties: {
        file: { type: 'string', description: '完整 Figma 链接或 fileKey' },
        node_ids: { type: 'string', description: '要渲染的节点 ID，逗号分隔（如 "1:2,3:4"）' },
        scale: { type: 'number', description: '缩放倍数，默认 1' },
        format: { type: 'string', enum: ['png', 'svg', 'jpg'], description: '默认 png' },
        token: { type: 'string', description: '可选：未设置 FIGMA_TOKEN 环境变量时直接传入 token。' },
      },
      required: ['file', 'node_ids'],
    },
    run: async (a) => {
      const { fileKey, nodeId } = parseTarget(a.file);
      const ids = a.node_ids || nodeId;
      if (!ids) throw new ApiError('缺少 node_ids（或链接中带 node-id）。');
      const list = Array.isArray(ids) ? ids.join(',') : ids;
      const fmt = a.format || 'png';
      const scale = a.scale || 1;
      const data = await figmaApi(`/v1/images/${fileKey}?ids=${encodeURIComponent(list)}&format=${fmt}&scale=${scale}`, a.token);
      return jtext(data);
    },
  },
  {
    name: 'create_frame',
    description: '【写回】在 Figma 中创建画板/容器（Frame）。需要在 Figma 桌面端运行 companion 插件并连接桥。',
    inputSchema: {
      type: 'object',
      properties: {
        name: { type: 'string' },
        x: { type: 'number' },
        y: { type: 'number' },
        width: { type: 'number' },
        height: { type: 'number' },
        parent_id: { type: 'string', description: '可选：父节点 ID，默认当前页面。' },
        fills: { type: ['string', 'array'], description: "可选：十六进制颜色，如 #FFFFFF 或 [\"#EEE\", \"#FFF\"]（多填充叠加）。" },
        corner_radius: { type: 'number', description: '可选：圆角半径。' },
        ...channelProp,
      },
      required: ['name', 'x', 'y', 'width', 'height'],
    },
    run: async (a) => jtext(await bridgeCall(a.channel, 'create_frame', a)),
  },
  {
    name: 'create_text',
    description: '【写回】在 Figma 中创建可编辑文本图层。默认字体 Inter Regular；其他字体需文件中可用。',
    inputSchema: {
      type: 'object',
      properties: {
        text: { type: 'string' },
        x: { type: 'number' },
        y: { type: 'number' },
        parent_id: { type: 'string', description: '可选：父节点 ID，默认当前页面。' },
        font_size: { type: 'number', description: '默认 14' },
        font_family: { type: 'string', description: '默认 Inter' },
        font_style: { type: 'string', description: '默认 Regular，如 Medium/Bold' },
        fills: { type: ['string', 'array'], description: '可选：十六进制颜色。' },
        width: { type: 'number', description: '可选：固定宽度（自动高度换行）。' },
        text_align_horizontal: { type: 'string', enum: ['LEFT', 'CENTER', 'RIGHT', 'JUSTIFIED'] },
        ...channelProp,
      },
      required: ['text', 'x', 'y'],
    },
    run: async (a) => jtext(await bridgeCall(a.channel, 'create_text', a)),
  },
  {
    name: 'create_node_from_svg',
    description:
      '【写回·整页 UI 首选】把一段 SVG 导入为 Figma 图层组（createNodeFromSvg）。适合整页 UI：布局、形状、图标一次成型。' +
      '注意：SVG 中的 <text> 会转为矢量轮廓（视觉正确但不可直接编辑），需要可编辑文案时再用 create_text 叠加。',
    inputSchema: {
      type: 'object',
      properties: {
        svg: { type: 'string', description: '完整 SVG 文本，根元素需带 width/height/viewBox' },
        parent_id: { type: 'string', description: '可选：放入指定 Frame 内；默认当前页面。' },
        name: { type: 'string', description: '可选：图层名。' },
        x: { type: 'number' },
        y: { type: 'number' },
        ...channelProp,
      },
      required: ['svg'],
    },
    run: async (a) => jtext(await bridgeCall(a.channel, 'create_node_from_svg', a)),
  },
  {
    name: 'export_node_image',
    description:
      '【写回】导出 Figma 中某个节点的 PNG 截图（在插件端用 exportAsync 完成，无需 REST token）。生成 UI 后用它自查视觉效果并迭代。',
    inputSchema: {
      type: 'object',
      properties: {
        node_id: { type: 'string' },
        scale: { type: 'number', description: '默认 1' },
        ...channelProp,
      },
      required: ['node_id'],
    },
    run: async (a) => {
      const r = await bridgeCall(a.channel, 'export_node_image', { node_id: a.node_id, scale: a.scale || 1 });
      const b64 = r && r.base64 ? String(r.base64) : '';
      if (!b64) throw new BridgeError('插件未返回图像数据。');
      return {
        content: [
          { type: 'image', data: b64, mimeType: 'image/png' },
          { type: 'text', text: `节点 ${a.node_id} 的 PNG（${a.scale || 1}x）已返回，请检查视觉效果。` },
        ],
      };
    },
  },
  {
    name: 'execute_figma_code',
    description:
      '【写回·逃生舱】在 Figma 插件沙箱中执行任意 Plugin API 代码。code 是 async 函数体（figma 在作用域内），返回值会 JSON 化后带回。' +
      '例：创建页面 `const p = figma.createPage(); p.name = "AI UI"; return { pageId: p.id };`；也可用于移动/删除节点、设置自动布局、加载节点树等。',
    inputSchema: {
      type: 'object',
      properties: {
        code: { type: 'string' },
        ...channelProp,
      },
      required: ['code'],
    },
    run: async (a) => jtext(await bridgeCall(a.channel, 'execute_figma_code', { code: a.code })),
  },
];

/* ------------------------------------------------------------------ */
/* MCP stdio JSON-RPC                                                  */
/* ------------------------------------------------------------------ */

const httpPending = new Map(); // id -> http control response (for --control endpoint)

function sendRpc(obj) {
  if (obj.id !== undefined && httpPending.has(obj.id)) {
    const res = httpPending.get(obj.id);
    httpPending.delete(obj.id);
    try {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify(obj));
    } catch (e) {
      log('control response error:', e.message);
    }
    return;
  }
  process.stdout.write(JSON.stringify(obj) + '\n');
}

function handleRpc(msg) {
  const { id, method, params } = msg;
  if (id === undefined || id === null) return; // notification
  switch (method) {
    case 'initialize':
      sendRpc({
        jsonrpc: '2.0',
        id,
        result: {
          protocolVersion: (params && params.protocolVersion) || '2024-11-05',
          capabilities: { tools: { listChanged: false } },
          serverInfo: { name: 'figma-bridge', title: 'Figma Bridge', version: VERSION },
        },
      });
      break;
    case 'ping':
      sendRpc({ jsonrpc: '2.0', id, result: {} });
      break;
    case 'tools/list':
      sendRpc({
        jsonrpc: '2.0',
        id,
        result: {
          tools: TOOLS.map((t) => ({ name: t.name, description: t.description, inputSchema: t.inputSchema })),
        },
      });
      break;
    case 'tools/call':
      handleCall(id, params || {});
      break;
    default:
      sendRpc({ jsonrpc: '2.0', id, error: { code: -32601, message: `Method not found: ${method}` } });
  }
}

async function handleCall(id, params) {
  const tool = TOOLS.find((t) => t.name === params.name);
  if (!tool) {
    sendRpc({ jsonrpc: '2.0', id, error: { code: -32602, message: `Unknown tool: ${params.name}` } });
    return;
  }
  try {
    const out = await tool.run(params.arguments || {});
    sendRpc({ jsonrpc: '2.0', id, result: out });
  } catch (e) {
    sendRpc({
      jsonrpc: '2.0',
      id,
      result: { content: [{ type: 'text', text: String((e && e.message) || e) }], isError: true },
    });
  }
}

const STANDALONE = process.argv.includes('--standalone');

const rl = createInterface({ input: process.stdin, terminal: false });
rl.on('line', (line) => {
  const s = line.trim();
  if (!s) return;
  let msg;
  try {
    msg = JSON.parse(s);
  } catch {
    return;
  }
  handleRpc(msg);
});
rl.on('close', () => {
  if (STANDALONE) log('stdin closed; staying alive (standalone mode)');
  else process.exit(0);
});

// Optional local-only HTTP control endpoint for debugging/automation:
// POST a JSON-RPC message to http://127.0.0.1:<port>/ and get the reply.
const ctrlIdx = process.argv.indexOf('--control');
const CTRL_PORT = ctrlIdx >= 0 ? Number(process.argv[ctrlIdx + 1]) : 0;
if (CTRL_PORT > 0) {
  createServer((req, res) => {
    if (req.method !== 'POST') {
      res.writeHead(405, { 'Content-Type': 'text/plain' });
      res.end('POST JSON-RPC only\n');
      return;
    }
    let body = '';
    req.on('data', (c) => (body += c));
    req.on('end', () => {
      let msg;
      try {
        msg = JSON.parse(body);
      } catch {
        res.writeHead(400, { 'Content-Type': 'text/plain' });
        res.end('bad json\n');
        return;
      }
      if (msg.id === undefined || msg.id === null) {
        handleRpc(msg);
        res.writeHead(204);
        res.end();
        return;
      }
      httpPending.set(msg.id, res);
      handleRpc(msg);
      const timer = setTimeout(() => {
        if (httpPending.has(msg.id)) {
          httpPending.delete(msg.id);
          try {
            res.writeHead(504, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ error: { message: 'control timeout' } }));
          } catch {}
        }
      }, CMD_TIMEOUT_MS + 5000);
      timer.unref();
    });
  }).listen(CTRL_PORT, '127.0.0.1', () => log(`control endpoint on http://127.0.0.1:${CTRL_PORT}`));
}

process.on('uncaughtException', (e) => log('uncaught:', e.message));
process.on('unhandledRejection', (e) => log('unhandled:', (e && e.message) || e));
