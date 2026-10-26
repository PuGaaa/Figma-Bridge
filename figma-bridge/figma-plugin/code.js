// Figma Bridge (ZCode) — companion plugin, runs inside Figma desktop.
// Receives JSON commands from the local WebSocket bridge (via ui.html) and
// executes them with the Figma Plugin API.

figma.showUI(__html__, { width: 300, height: 300, themeColors: true });

function hexToFills(hex) {
  const list = Array.isArray(hex) ? hex : [hex];
  return list.map((h) => {
    let s = String(h).trim().replace(/^#/, '');
    if (/^[0-9a-fA-F]{3}$/.test(s)) s = s.split('').map((c) => c + c).join('');
    let a = 1;
    if (s.length === 8) {
      a = parseInt(s.slice(6, 8), 16) / 255;
      s = s.slice(0, 6);
    }
    if (s.length !== 6) throw new Error('无法解析颜色: ' + h + '（请用 #RRGGBB 或 #RRGGBBAA）');
    const n = parseInt(s, 16);
    return {
      type: 'SOLID',
      color: { r: ((n >> 16) & 255) / 255, g: ((n >> 8) & 255) / 255, b: (n & 255) / 255 },
      opacity: a,
    };
  });
}

async function getParent(parentId) {
  if (!parentId) return figma.currentPage;
  const node = await figma.getNodeByIdAsync(parentId);
  if (!node) throw new Error('找不到父节点: ' + parentId);
  if (typeof node.appendChild !== 'function') throw new Error('节点 ' + parentId + '（' + node.type + '）不能包含子图层');
  return node;
}

function toPlain(v) {
  try {
    return JSON.parse(
      JSON.stringify(v, (k, x) => {
        if (typeof x === 'function') return undefined;
        if (typeof x === 'bigint') return String(x);
        return x;
      })
    );
  } catch (e) {
    return { stringified: String(v) };
  }
}

function collectInfo() {
  const page = figma.currentPage;
  return {
    fileName: figma.root.name,
    pageName: page.name,
    pageId: page.id,
    selection: page.selection
      .slice(0, 10)
      .map((n) => ({ id: n.id, name: n.name, type: n.type })),
  };
}

const handlers = {
  async get_file_info() {
    return collectInfo();
  },

  async create_frame(p) {
    const parent = await getParent(p.parent_id);
    const f = figma.createFrame();
    f.resize(Number(p.width) || 100, Number(p.height) || 100);
    if (p.name) f.name = String(p.name);
    parent.appendChild(f);
    f.x = Number(p.x) || 0;
    f.y = Number(p.y) || 0;
    if (p.fills) f.fills = hexToFills(p.fills);
    if (p.corner_radius != null) f.cornerRadius = Number(p.corner_radius);
    return { id: f.id, name: f.name, width: f.width, height: f.height };
  },

  async create_text(p) {
    const parent = await getParent(p.parent_id);
    await figma.loadFontAsync({ family: 'Inter', style: 'Regular' });
    const t = figma.createText();
    if (p.font_family && (p.font_family !== 'Inter' || (p.font_style && p.font_style !== 'Regular'))) {
      const style = p.font_style || 'Regular';
      try {
        await figma.loadFontAsync({ family: p.font_family, style });
        t.fontName = { family: p.font_family, style };
      } catch (e) {
        t.remove();
        throw new Error('字体不可用: ' + p.font_family + ' ' + style + '（请改用 Inter 或文件中已安装的字体）');
      }
    }
    t.characters = String(p.text);
    t.fontSize = Number(p.font_size) || 14;
    if (p.fills) t.fills = hexToFills(p.fills);
    parent.appendChild(t);
    t.x = Number(p.x) || 0;
    t.y = Number(p.y) || 0;
    if (p.width != null) {
      t.textAutoResize = 'HEIGHT';
      t.resize(Number(p.width), t.height);
    }
    if (p.text_align_horizontal) t.textAlignHorizontal = p.text_align_horizontal;
    return { id: t.id, width: t.width, height: t.height };
  },

  async create_node_from_svg(p) {
    if (!p.svg) throw new Error('缺少 svg');
    const node = figma.createNodeFromSvg(String(p.svg));
    if (p.name) node.name = String(p.name);
    if (p.parent_id) {
      const parent = await getParent(p.parent_id);
      parent.appendChild(node);
    }
    node.x = Number(p.x) || 0;
    node.y = Number(p.y) || 0;
    return { id: node.id, name: node.name, width: node.width, height: node.height };
  },

  async export_node_image(p) {
    const node = await figma.getNodeByIdAsync(p.node_id);
    if (!node) throw new Error('找不到节点: ' + p.node_id);
    const bytes = await node.exportAsync({
      format: 'PNG',
      constraint: { type: 'SCALE', value: Number(p.scale) || 1 },
    });
    return { bytes };
  },

  async execute_figma_code(p) {
    if (!p.code) throw new Error('缺少 code');
    const AsyncFunction = Object.getPrototypeOf(async function () {}).constructor;
    const fn = new AsyncFunction('figma', String(p.code));
    const result = await fn(figma);
    return { result: toPlain(result === undefined ? null : result) };
  },
};

figma.ui.onmessage = async (msg) => {
  if (msg.type === 'file_info_request') {
    figma.ui.postMessage({ type: 'file_info', info: collectInfo() });
    return;
  }
  const { id, command, params } = msg;
  if (id === undefined || !command) return;
  const handler = handlers[command];
  if (!handler) {
    figma.ui.postMessage({ id, ok: false, error: '未知命令: ' + command });
    return;
  }
  try {
    const result = await handler(params || {});
    figma.ui.postMessage({ id, ok: true, result });
  } catch (e) {
    figma.ui.postMessage({ id, ok: false, error: String((e && e.message) || e) });
  }
};

const pushInfo = () => figma.ui.postMessage({ type: 'file_info', info: collectInfo() });
pushInfo();
figma.on('selectionchange', pushInfo);
figma.on('currentpagechange', pushInfo);
