// ═══════════════════════════════════════════════════════════
//  State
// ═══════════════════════════════════════════════════════════
const S = {
  nodes:      {},   // id -> node
  rootId:     null,
  selectedId: null,
  focusId:    null,
  topicName:  '',
  topicId:    null,
  zoom:       1,
  panX:       0,
  panY:       0,
  loading:    false,
  model:      localStorage.getItem('it_model') || 'llama3.2',
};

// ═══════════════════════════════════════════════════════════
//  Persistence
// ═══════════════════════════════════════════════════════════
function persist() {
  if (!S.topicId) return;
  localStorage.setItem(`it_topic_${S.topicId}`, JSON.stringify({
    topicId:   S.topicId,
    nodes:     S.nodes,
    rootId:    S.rootId,
    focusId:   S.focusId,
    topicName: S.topicName,
    zoom:      S.zoom,
    panX:      S.panX,
    panY:      S.panY,
  }));
  let index = JSON.parse(localStorage.getItem('it_index') || '[]');
  const i = index.findIndex(e => e.id === S.topicId);
  const entry = { id: S.topicId, name: S.topicName, updatedAt: Date.now() };
  if (i >= 0) { index[i] = entry; } else { index.push(entry); }
  index.sort((a, b) => b.updatedAt - a.updatedAt);
  localStorage.setItem('it_index', JSON.stringify(index));
}

function hydrate() {
  let index = JSON.parse(localStorage.getItem('it_index') || '[]');

  // Legacy migration: import old it_state as a topic entry
  if (!index.length) {
    const legacy = localStorage.getItem('it_state');
    if (legacy) {
      try {
        const d = JSON.parse(legacy);
        if (d.rootId) {
          const id = mkId();
          index = [{ id, name: d.topicName || 'Imported', updatedAt: Date.now() }];
          localStorage.setItem('it_index', JSON.stringify(index));
          localStorage.setItem(`it_topic_${id}`, JSON.stringify({ ...d, topicId: id }));
          localStorage.removeItem('it_state');
        }
      } catch {}
    }
  }

  if (!index.length) return false;
  const latest = index[0];
  const raw = localStorage.getItem(`it_topic_${latest.id}`);
  if (!raw) return false;
  try {
    const d = JSON.parse(raw);
    Object.assign(S, {
      topicId:   d.topicId   || latest.id,
      nodes:     d.nodes     || {},
      rootId:    d.rootId    || null,
      focusId:   d.focusId   || null,
      topicName: d.topicName || '',
      zoom:      d.zoom      || 1,
      panX:      d.panX      || 0,
      panY:      d.panY      || 0,
    });
    return !!S.rootId;
  } catch { return false; }
}

// ═══════════════════════════════════════════════════════════
//  Node helpers
// ═══════════════════════════════════════════════════════════
function mkId() {
  return Date.now().toString(36) + Math.random().toString(36).slice(2, 5);
}

function addNode(parentId, type, content) {
  const id = mkId();
  S.nodes[id] = { id, parentId, type, content, children: [], x: 0, y: 0, ts: Date.now() };
  if (parentId && S.nodes[parentId]) S.nodes[parentId].children.push(id);
  return id;
}

function depth(id) {
  let d = 0, cur = id;
  while (S.nodes[cur]?.parentId) { d++; cur = S.nodes[cur].parentId; }
  return d;
}

// Build message history by walking up the tree from `fromId`
function buildHistory(fromId) {
  const path = [];
  let cur = fromId;
  while (cur && S.nodes[cur]) { path.unshift(S.nodes[cur]); cur = S.nodes[cur].parentId; }
  return path
    .filter(n => n.type === 'user' || n.type === 'assistant')
    .map(n => ({ role: n.type === 'user' ? 'user' : 'assistant', content: n.content }));
}

// ═══════════════════════════════════════════════════════════
//  Layout — radial tree
// ═══════════════════════════════════════════════════════════
const RADIUS = { 0: 210, 1: 175, other: 155 };

function layout() {
  if (!S.rootId) return;
  const root = S.nodes[S.rootId];
  if (!root.pinned) { root.x = 0; root.y = 0; }
  spreadChildren(S.rootId, 0, 2 * Math.PI);
}

function spreadChildren(id, arcStart, arcEnd) {
  const node = S.nodes[id];
  if (!node || !node.children.length) return;
  const d = depth(id);
  const r = d === 0 ? RADIUS[0] : d === 1 ? RADIUS[1] : RADIUS.other;
  const n = node.children.length;
  const step = (arcEnd - arcStart) / n;

  node.children.forEach((cid, i) => {
    const angle = arcStart + step * (i + 0.5);
    const child = S.nodes[cid];
    if (!child.pinned) {
      child.x = node.x + Math.cos(angle) * r;
      child.y = node.y + Math.sin(angle) * r;
    }
    const childSpread = Math.min(step * 0.88, Math.PI * 0.75);
    spreadChildren(cid, angle - childSpread / 2, angle + childSpread / 2);
  });
}

// ═══════════════════════════════════════════════════════════
//  Render
// ═══════════════════════════════════════════════════════════
const NW = 162, NH = 46; // node box size

function clip(text, len = 20) {
  const t = (text || '').replace(/\s+/g, ' ').trim();
  return t.length > len ? t.slice(0, len) + '\u2026' : t;
}

function svgEl(tag) {
  return document.createElementNS('http://www.w3.org/2000/svg', tag);
}

function renderEdge(parent, child) {
  const dx = child.x - parent.x;
  const path = svgEl('path');
  path.setAttribute('d',
    `M${parent.x},${parent.y} C${parent.x + dx * 0.5},${parent.y} ${parent.x + dx * 0.5},${child.y} ${child.x},${child.y}`
  );
  path.classList.add('edge');
  return path;
}

function renderNode(node) {
  const g = svgEl('g');
  g.classList.add('node', `node-${node.type}`);
  if (node.id === S.selectedId) g.classList.add('selected');
  if (node.id === S.focusId)    g.classList.add('focused');
  g.setAttribute('transform', `translate(${node.x},${node.y})`);
  g.dataset.id = node.id;

  // Box
  const rect = svgEl('rect');
  rect.setAttribute('x', -NW / 2);
  rect.setAttribute('y', -NH / 2);
  rect.setAttribute('width', NW);
  rect.setAttribute('height', NH);
  rect.setAttribute('rx', '8');

  // Type label (top-left)
  const ttype = svgEl('text');
  ttype.classList.add('lbl-type');
  ttype.setAttribute('x', -NW / 2 + 8);
  ttype.setAttribute('y', -NH / 2 + 12);
  ttype.textContent =
    node.type === 'root'      ? '\u25C8 TOPIC'
    : node.type === 'user'    ? '\u25B7 YOU'
    :                           '\u25C6 AI';

  // Content preview (center)
  const tcontent = svgEl('text');
  tcontent.classList.add('lbl-content');
  tcontent.setAttribute('x', 0);
  tcontent.setAttribute('y', 7);
  tcontent.setAttribute('text-anchor', 'middle');
  tcontent.textContent = node.label ? clip(node.label, 22) : clip(node.content);

  g.appendChild(rect);
  g.appendChild(ttype);
  g.appendChild(tcontent);

  // Pointer down starts drag tracking; click is handled in pointerup via nodeDrag
  g.addEventListener('pointerdown', e => { e.stopPropagation(); nodeDrag.start(node.id, e, g); });
  g.addEventListener('click', e => e.stopPropagation()); // prevent canvas deselect

  return g;
}

function render() {
  const el = document.getElementById('edges-layer');
  const nl = document.getElementById('nodes-layer');
  el.innerHTML = '';
  nl.innerHTML = '';

  Object.values(S.nodes).forEach(node => {
    if (node.parentId && S.nodes[node.parentId]) {
      el.appendChild(renderEdge(S.nodes[node.parentId], node));
    }
    nl.appendChild(renderNode(node));
  });

  // Loading spinner on the focused node
  if (S.loading && S.focusId && S.nodes[S.focusId]) {
    const f = S.nodes[S.focusId];
    const circle = svgEl('circle');
    circle.classList.add('spinner');
    circle.setAttribute('cx', f.x);
    circle.setAttribute('cy', f.y);
    circle.setAttribute('r', 34);
    el.appendChild(circle);
  }

  applyTransform();
}

function applyTransform() {
  const canvas = document.getElementById('canvas');
  const gr     = document.getElementById('graph-root');
  const cx = canvas.clientWidth  / 2 + S.panX;
  const cy = canvas.clientHeight / 2 + S.panY;
  gr.setAttribute('transform', `translate(${cx},${cy}) scale(${S.zoom})`);
}

// ═══════════════════════════════════════════════════════════
//  Selection & Focus
// ═══════════════════════════════════════════════════════════
function selectNode(id) {
  S.selectedId = id;
  refreshSidebar();
}

function setFocus(id) {
  S.focusId = id;
  refreshFocusStrip();
  render();
}

function refreshFocusStrip() {
  const lbl  = document.getElementById('focus-node-label');
  const btn  = document.getElementById('send-btn');
  const inp  = document.getElementById('msg-input');
  const node = S.nodes[S.focusId];

  if (node) {
    lbl.textContent = clip(node.content || node.type, 36);
    btn.disabled = S.loading;
    inp.disabled = S.loading;
  } else {
    lbl.textContent = '— select a node first —';
    btn.disabled = true;
    inp.disabled = true;
  }
}

function refreshSidebar() {
  const empty = document.getElementById('sb-empty');
  const inner = document.getElementById('sb-inner');
  const node  = S.nodes[S.selectedId];

  if (!node) {
    empty.style.display = 'flex';
    inner.style.display = 'none';
    return;
  }

  empty.style.display = 'none';
  inner.style.display = 'flex';

  const badge = document.getElementById('sb-badge');
  badge.textContent  = node.type;
  badge.className    = `type-badge badge-${node.type}`;

  document.getElementById('sb-title').textContent =
    node.type === 'root' ? 'Topic Root'
    : node.type === 'user' ? 'Your message'
    : 'AI response';

  document.getElementById('sb-content').textContent = node.content;

  const d = new Date(node.ts);
  document.getElementById('sb-meta').textContent =
    `${d.toLocaleDateString()} ${d.toLocaleTimeString()}  ·  ${node.children.length} branch${node.children.length !== 1 ? 'es' : ''}`;

  // Hide delete button for root node
  document.getElementById('sb-actions').style.display = node.id === S.rootId ? 'none' : 'block';
}

// ═══════════════════════════════════════════════════════════
//  AI API — proxied through backend
// ═══════════════════════════════════════════════════════════
async function generateLabel(nodeId) {
  const node = S.nodes[nodeId];
  if (!node) return;
  try {
    const res = await fetch('/api/chat', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        model: S.model,
        messages: [{ role: 'user', content:
          `2-4 words summarising the topic of this text. ONLY the words, no punctuation:\n\n${node.content.slice(0,400)}` }],
        max_tokens: 12,
        stream: false,
      }),
    });
    if (!res.ok) return;
    const label = (await res.json()).choices?.[0]?.message?.content?.trim();
    if (label && S.nodes[nodeId]) {
      S.nodes[nodeId].label = label;
      render();
      persist();
    }
  } catch {}
}

async function sendMessage(text) {
  if (!S.focusId) return;

  S.loading = true;
  refreshFocusStrip();
  render();

  // Create user node branching from current focus
  const userNodeId = addNode(S.focusId, 'user', text);
  layout();
  render();

  // System prompt from root topic
  const root = S.nodes[S.rootId];
  const system = root
    ? `You are helping the user explore and learn about: "${root.content}". Be concise and insightful. Prefer shorter responses unless depth is needed.`
    : 'Be concise and insightful.';

  const messages = [
    { role: 'system', content: system },
    ...buildHistory(userNodeId),
  ];

  let aiNodeId = null;
  try {
    const res = await fetch('/api/chat', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ model: S.model, messages, max_tokens: 1024, stream: true }),
    });

    if (!res.ok) {
      const err = await res.json().catch(() => ({}));
      throw new Error(err.error || `HTTP ${res.status}`);
    }

    const reader = res.body.getReader();
    const decoder = new TextDecoder();
    let buf = '', aiText = '', renderPending = false;

    const scheduleRender = () => {
      if (renderPending) return;
      renderPending = true;
      requestAnimationFrame(() => { renderPending = false; render(); });
    };

    outer: while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      buf += decoder.decode(value, { stream: true });
      const lines = buf.split('\n');
      buf = lines.pop();
      for (const line of lines) {
        if (!line.startsWith('data: ')) continue;
        const data = line.slice(6).trim();
        if (data === '[DONE]') break outer;
        try {
          const delta = JSON.parse(data).choices?.[0]?.delta?.content;
          if (delta) {
            aiText += delta;
            if (!aiNodeId) {
              aiNodeId = addNode(userNodeId, 'assistant', aiText);
              S.focusId = aiNodeId;
              S.selectedId = aiNodeId;
              refreshFocusStrip();
              layout();
              render();
            } else {
              S.nodes[aiNodeId].content = aiText;
              scheduleRender();
            }
          }
        } catch {}
      }
    }

    if (!aiNodeId) {
      aiNodeId = addNode(userNodeId, 'assistant', '[No response]');
      layout();
    }

  } catch (e) {
    const errId = addNode(userNodeId, 'assistant', `[Error] ${e.message}`);
    if (!aiNodeId) { aiNodeId = errId; layout(); }
    S.focusId = aiNodeId;
    S.selectedId = aiNodeId;
    console.error(e);
  }

  S.loading = false;
  refreshFocusStrip();
  refreshSidebar();
  render();
  persist();
  if (aiNodeId) generateLabel(aiNodeId);
}

// ═══════════════════════════════════════════════════════════
//  Input handlers
// ═══════════════════════════════════════════════════════════
const msgInput = document.getElementById('msg-input');
const sendBtn  = document.getElementById('send-btn');

msgInput.addEventListener('keydown', e => {
  if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); doSend(); }
});
msgInput.addEventListener('input', function () {
  this.style.height = 'auto';
  this.style.height = Math.min(this.scrollHeight, 110) + 'px';
});
sendBtn.addEventListener('click', doSend);

function doSend() {
  const text = msgInput.value.trim();
  if (!text || S.loading || !S.focusId) return;
  msgInput.value = '';
  msgInput.style.height = 'auto';
  sendMessage(text);
}

// ═══════════════════════════════════════════════════════════
//  Node drag
// ═══════════════════════════════════════════════════════════
const nodeDrag = {
  active:  false,
  nodeId:  null,
  el:      null,
  moved:   false,
  startSX: 0,
  startSY: 0,

  start(id, e, el) {
    this.active  = true;
    this.nodeId  = id;
    this.el      = el;
    this.moved   = false;
    this.startSX = e.clientX;
    this.startSY = e.clientY;
  },

  move(e) {
    if (!this.active) return;
    const dx = e.clientX - this.startSX;
    const dy = e.clientY - this.startSY;
    if (!this.moved && Math.hypot(dx, dy) > 5) {
      this.moved = true;
      this.el?.classList.add('dragging');
    }
    if (this.moved) {
      const node = S.nodes[this.nodeId];
      if (node) {
        node.x += dx / S.zoom;
        node.y += dy / S.zoom;
        node.pinned = true;
      }
      this.startSX = e.clientX;
      this.startSY = e.clientY;
      render();
    }
  },

  end(e) {
    if (!this.active) return;
    this.el?.classList.remove('dragging');
    if (!this.moved) {
      // Was a click — handle select/focus
      const node = S.nodes[this.nodeId];
      if (node) {
        if (e.shiftKey) { setFocus(node.id); }
        else { selectNode(node.id); setFocus(node.id); }
      }
    } else {
      persist();
    }
    this.active = false;
    this.nodeId = null;
    this.el     = null;
  },
};

// ═══════════════════════════════════════════════════════════
//  Pan & Zoom
// ═══════════════════════════════════════════════════════════
let panActive = false, panLastX = 0, panLastY = 0;
const cw = document.getElementById('canvas-wrap');

cw.addEventListener('pointerdown', e => {
  if (e.target.closest('.node')) return;
  panActive = true;
  panLastX = e.clientX; panLastY = e.clientY;
  cw.classList.add('grabbing');
  cw.setPointerCapture(e.pointerId);
});

window.addEventListener('pointermove', e => {
  if (panActive) {
    S.panX += e.clientX - panLastX;
    S.panY += e.clientY - panLastY;
    panLastX = e.clientX; panLastY = e.clientY;
    applyTransform();
  }
  nodeDrag.move(e);
});

window.addEventListener('pointerup', e => {
  if (panActive) { panActive = false; cw.classList.remove('grabbing'); }
  nodeDrag.end(e);
});

cw.addEventListener('wheel', e => {
  e.preventDefault();
  doZoom(e.deltaY > 0 ? 0.9 : 1.1);
}, { passive: false });

// Click empty canvas to deselect
cw.addEventListener('click', e => {
  if (!e.target.closest('.node')) {
    S.selectedId = null;
    refreshSidebar();
    render();
  }
});

function doZoom(factor) {
  S.zoom = Math.max(0.15, Math.min(3.5, S.zoom * factor));
  applyTransform();
}

function resetView() {
  S.zoom = 1; S.panX = 0; S.panY = 0;
  applyTransform();
}

// ═══════════════════════════════════════════════════════════
//  Sidebar toggle
// ═══════════════════════════════════════════════════════════
function toggleSidebar() {
  document.getElementById('sidebar').classList.toggle('hidden');
}

// ═══════════════════════════════════════════════════════════
//  Modals
// ═══════════════════════════════════════════════════════════
let _modalCb = null;

function openModal(title, desc, bodyHtml, okLabel, cb) {
  document.getElementById('modal-title').textContent = title;
  document.getElementById('modal-desc').textContent  = desc;
  document.getElementById('modal-body').innerHTML    = bodyHtml;
  document.getElementById('modal-ok').textContent   = okLabel || 'OK';
  _modalCb = cb;
  document.getElementById('modal-overlay').classList.add('open');
}

function closeModal() {
  document.getElementById('modal-overlay').classList.remove('open');
  _modalCb = null;
}

document.getElementById('modal-ok').addEventListener('click', () => { if (_modalCb) _modalCb(); });
document.getElementById('modal-overlay').addEventListener('click', e => {
  if (e.target === document.getElementById('modal-overlay')) closeModal();
});
document.addEventListener('keydown', e => {
  if (e.key === 'Escape') closeModal();
  const tag = document.activeElement?.tagName;
  if (e.key === 'Delete' && tag !== 'INPUT' && tag !== 'TEXTAREA') deleteSelectedNode();
});

function openModelModal() {
  openModal(
    'Ollama Model',
    'Enter the name of any model you have pulled locally (e.g. llama3.2, mistral, gemma2).',
    `<input class="modal-field" type="text" id="model-input" placeholder="llama3.2" value="${S.model || 'llama3.2'}" />`,
    'Save',
    () => {
      const v = document.getElementById('model-input').value.trim();
      if (v) { S.model = v; localStorage.setItem('it_model', v); }
      closeModal();
    }
  );
  setTimeout(() => document.getElementById('model-input')?.focus(), 60);
}

function openTopicModal() {
  openModal(
    'New Topic',
    'Start a fresh mind map. What do you want to explore?',
    `<input class="modal-field" type="text" id="topic-input" placeholder="e.g. How does TCP/IP work?" maxlength="120" />`,
    'Create',
    () => {
      const v = document.getElementById('topic-input').value.trim();
      if (!v) return;
      newTopic(v);
      closeModal();
    }
  );
  setTimeout(() => document.getElementById('topic-input')?.focus(), 60);
}

// ═══════════════════════════════════════════════════════════
//  Delete
// ═══════════════════════════════════════════════════════════
function deleteSubtree(id) {
  const node = S.nodes[id];
  if (!node) return;
  [...node.children].forEach(cid => deleteSubtree(cid));
  delete S.nodes[id];
}

function deleteSelectedNode() {
  const id = S.selectedId;
  if (!id || id === S.rootId || !S.nodes[id]) return;
  const parentId = S.nodes[id].parentId;
  // Detach from parent
  if (parentId && S.nodes[parentId]) {
    S.nodes[parentId].children = S.nodes[parentId].children.filter(c => c !== id);
  }
  deleteSubtree(id);
  // Move selection/focus to parent
  S.selectedId = parentId || null;
  if (!S.nodes[S.focusId]) S.focusId = parentId || null;
  layout();
  refreshSidebar();
  refreshFocusStrip();
  render();
  persist();
}

// ═══════════════════════════════════════════════════════════
//  New topic
// ═══════════════════════════════════════════════════════════
function newTopic(name) {
  if (S.topicId) persist(); // save current topic before wiping
  const topicId = mkId();
  Object.assign(S, {
    topicId, nodes: {}, rootId: null, selectedId: null,
    focusId: null, panX: 0, panY: 0, zoom: 1, topicName: name,
  });
  const rootId = addNode(null, 'root', name);
  S.rootId = rootId;
  document.getElementById('topic-label').textContent = name;
  layout();
  setFocus(rootId);
  selectNode(rootId);
  render();
  persist();
}

function loadTopic(id) {
  persist(); // save current topic first
  const raw = localStorage.getItem(`it_topic_${id}`);
  if (!raw) return;
  try {
    const d = JSON.parse(raw);
    Object.assign(S, {
      topicId:    d.topicId   || id,
      nodes:      d.nodes     || {},
      rootId:     d.rootId    || null,
      focusId:    d.focusId   || null,
      topicName:  d.topicName || '',
      zoom:       d.zoom      || 1,
      panX:       d.panX      || 0,
      panY:       d.panY      || 0,
      selectedId: null,
    });
    document.getElementById('topic-label').textContent = S.topicName || 'untitled';
    layout();
    refreshSidebar();
    refreshFocusStrip();
    render();
  } catch {}
}

function deleteTopic(id) {
  let index = JSON.parse(localStorage.getItem('it_index') || '[]');
  index = index.filter(e => e.id !== id);
  localStorage.setItem('it_index', JSON.stringify(index));
  localStorage.removeItem(`it_topic_${id}`);

  if (S.topicId === id) {
    S.topicId = null; // prevent persist() in loadTopic from re-adding deleted entry
    if (index.length > 0) {
      loadTopic(index[0].id);
    } else {
      closeModal();
      openTopicModal();
      return;
    }
  }

  if (document.getElementById('modal-overlay').classList.contains('open')) {
    document.getElementById('modal-body').innerHTML = buildTopicsBodyHtml();
  }
}

function esc(s) {
  return String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

function relativeDate(ts) {
  const diff = Date.now() - ts;
  const mins = Math.floor(diff / 60000);
  if (mins < 1)  return 'just now';
  if (mins < 60) return `${mins}m ago`;
  const hrs = Math.floor(mins / 60);
  if (hrs < 24)  return `${hrs}h ago`;
  const days = Math.floor(hrs / 24);
  if (days < 30) return `${days}d ago`;
  return new Date(ts).toLocaleDateString();
}

function buildTopicsBodyHtml() {
  const index = JSON.parse(localStorage.getItem('it_index') || '[]');
  if (!index.length) return '<p style="color:var(--muted);font-size:12px;">No saved topics.</p>';
  const rows = index.map(e => {
    const isActive = e.id === S.topicId;
    const name = esc(e.name.length > 40 ? e.name.slice(0, 40) + '\u2026' : e.name);
    const date = relativeDate(e.updatedAt);
    const loadBtn = isActive ? '' : `<button class="btn" onclick="loadTopic('${e.id}');closeModal()">Load</button>`;
    return `<div class="topic-row${isActive ? ' topic-row-active' : ''}">
      <span class="topic-row-name">${name}</span>
      <span class="topic-row-date">${date}</span>
      ${loadBtn}
      <button class="btn danger" onclick="deleteTopic('${e.id}')">Del</button>
    </div>`;
  }).join('');
  return `<div class="topic-list">${rows}</div>`;
}

function openTopicsModal() {
  openModal('Topics', 'Your saved conversations', buildTopicsBodyHtml(), 'Close', closeModal);
}

// ═══════════════════════════════════════════════════════════
//  Center on focus
// ═══════════════════════════════════════════════════════════
function centerOnFocus() {
  if (!S.focusId || !S.nodes[S.focusId]) return;
  const node = S.nodes[S.focusId];
  S.panX = -node.x * S.zoom;
  S.panY = -node.y * S.zoom;
  applyTransform();
}

// ═══════════════════════════════════════════════════════════
//  Export current branch as Markdown
// ═══════════════════════════════════════════════════════════
function exportBranch() {
  const path = [];
  let cur = S.focusId || S.rootId;
  while (cur && S.nodes[cur]) { path.unshift(S.nodes[cur]); cur = S.nodes[cur].parentId; }

  let md = `# ${S.topicName}\n\n`;
  for (const node of path) {
    if (node.type === 'root') continue;
    md += node.type === 'user' ? `**You**\n\n` : `**AI**\n\n`;
    md += `${node.content}\n\n---\n\n`;
  }

  const slug = S.topicName.replace(/[^a-z0-9]+/gi, '_').toLowerCase() || 'export';
  const a = Object.assign(document.createElement('a'), {
    href: URL.createObjectURL(new Blob([md], { type: 'text/markdown' })),
    download: `${slug}.md`,
  });
  a.click();
  URL.revokeObjectURL(a.href);
}

// ═══════════════════════════════════════════════════════════
//  Rename topic (double-click label)
// ═══════════════════════════════════════════════════════════
document.getElementById('topic-label').addEventListener('dblclick', () => {
  const label = document.getElementById('topic-label');
  const prev  = S.topicName;
  label.contentEditable = 'true';
  label.focus();
  const sel = window.getSelection();
  const range = document.createRange();
  range.selectNodeContents(label);
  sel.removeAllRanges();
  sel.addRange(range);

  const finish = () => {
    label.contentEditable = 'false';
    label.removeEventListener('keydown', onKey);
    const newName = label.textContent.trim() || prev;
    label.textContent = newName;
    if (newName !== prev) {
      S.topicName = newName;
      if (S.rootId && S.nodes[S.rootId]) S.nodes[S.rootId].content = newName;
      layout(); render(); persist();
    }
  };
  const onKey = e => {
    if (e.key === 'Enter')  { e.preventDefault(); label.blur(); }
    if (e.key === 'Escape') { label.textContent = prev; label.blur(); }
  };
  label.addEventListener('keydown', onKey);
  label.addEventListener('blur', finish, { once: true });
});

// ═══════════════════════════════════════════════════════════
//  Boot
// ═══════════════════════════════════════════════════════════
function init() {
  const ok = hydrate();
  if (ok && S.nodes[S.rootId]) {
    document.getElementById('topic-label').textContent = S.topicName || 'untitled';
    layout();
    refreshFocusStrip();
    refreshSidebar();
    render();
  } else {
    setTimeout(openTopicModal, 80);
  }
}

init();
