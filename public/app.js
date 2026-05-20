let tasks = [];
let editingTaskId = null;
let expandedTasks = new Set();

const BASE = (window.BACKEND_URL || '').replace(/\/$/, '');

// ── Server-Sent Events ────────────────────────────────────
function connectSSE() {
  const es = new EventSource(`${BASE}/api/events`);

  es.onopen = () => setStatus(true);
  es.onerror = () => { setStatus(false); es.close(); setTimeout(connectSSE, 2000); };

  es.onmessage = e => {
    const msg = JSON.parse(e.data);
    if (msg.type === 'init') {
      tasks = msg.data.tasks;
      render();
    } else if (msg.type === 'task:created') {
      tasks.push(msg.task);
      render();
    } else if (msg.type === 'task:updated') {
      const idx = tasks.findIndex(t => t.id === msg.task.id);
      if (idx !== -1) tasks[idx] = msg.task; else tasks.push(msg.task);
      render();
    } else if (msg.type === 'task:deleted') {
      tasks = tasks.filter(t => !msg.ids.includes(t.id));
      render();
    } else if (msg.type === 'task:reordered') {
      msg.orderedIds.forEach((id, index) => {
        const t = tasks.find(t => t.id === id);
        if (t) { t.order = index; t.parentId = msg.parentId ?? null; }
      });
      render();
    }
  };
}

function setStatus(ok) {
  const el = document.getElementById('connection-status');
  el.textContent = ok ? '接続済み' : '切断';
  el.className = 'status ' + (ok ? 'connected' : 'disconnected');
}

// ── API ───────────────────────────────────────────────────
async function api(method, path, body) {
  const res = await fetch(`${BASE}${path}`, {
    method,
    headers: { 'Content-Type': 'application/json' },
    body: body ? JSON.stringify(body) : undefined,
  });
  return res.json();
}

// ── Render ────────────────────────────────────────────────
function sortedChildren(parentId) {
  return tasks
    .filter(t => t.parentId === (parentId ?? null))
    .sort((a, b) => a.order - b.order);
}

function render() {
  const list = document.getElementById('task-list');
  const roots = sortedChildren(null);
  if (roots.length === 0) {
    list.innerHTML = '<div class="empty-state">タスクがありません。上のフォームから追加してください。</div>';
    return;
  }
  list.innerHTML = '';
  roots.forEach((task, i) => {
    list.appendChild(makeDropZone(null, i));
    list.appendChild(makeTaskGroup(task));
  });
  list.appendChild(makeDropZone(null, roots.length));
}

function makeTaskGroup(task) {
  const group = document.createElement('div');
  group.className = 'task-group';
  group.appendChild(makeTaskItem(task, false));

  const children = sortedChildren(task.id);
  if (children.length > 0 || expandedTasks.has(task.id)) {
    if (expandedTasks.has(task.id)) {
      const sub = document.createElement('div');
      sub.className = 'subtask-container';

      children.forEach((child, i) => {
        sub.appendChild(makeDropZone(task.id, i));
        sub.appendChild(makeTaskItem(child, true));
      });
      sub.appendChild(makeDropZone(task.id, children.length));

      const addRow = document.createElement('div');
      addRow.className = 'subtask-add-row';
      addRow.innerHTML = `<input type="text" placeholder="サブタスクを追加..."><button>＋</button>`;
      addRow.querySelector('input').addEventListener('keydown', e => {
        if (e.key === 'Enter') addSubtask(task.id, e.target.value);
      });
      addRow.querySelector('button').addEventListener('click', e => {
        const inp = addRow.querySelector('input');
        addSubtask(task.id, inp.value);
      });
      sub.appendChild(addRow);
      group.appendChild(sub);
    }
  }

  const links = task.linkedTaskIds || [];
  if (links.length > 0) {
    const badges = document.createElement('div');
    badges.className = 'link-badges';
    links.forEach(lid => {
      const linked = tasks.find(t => t.id === lid);
      if (!linked) return;
      const badge = document.createElement('span');
      badge.className = 'link-badge';
      badge.textContent = '🔗 ' + linked.title;
      badge.addEventListener('click', () => scrollToTask(lid));
      badges.appendChild(badge);
    });
    group.appendChild(badges);
  }

  return group;
}

function makeTaskItem(task, isSubtask) {
  const item = document.createElement('div');
  item.className = 'task-item' + (isSubtask ? ' subtask' : '') + (task.completed ? ' completed' : '');
  item.dataset.id = task.id;
  item.draggable = true;

  const children = sortedChildren(task.id);
  const hasChildren = children.length > 0;
  const isExpanded = expandedTasks.has(task.id);

  item.innerHTML = `
    <div class="task-row">
      <span class="drag-handle">⠿</span>
      <span class="task-check ${task.completed ? 'checked' : ''}"></span>
      ${!isSubtask ? `<button class="expand-btn ${isExpanded ? 'open' : ''}">${hasChildren || isExpanded ? '▶' : '▶'}</button>` : ''}
      <span class="task-title">${escHtml(task.title)}</span>
      <div class="task-actions">
        <button class="edit-btn" title="編集">✏️</button>
        ${!isSubtask ? `<button class="subtask-toggle-btn" title="サブタスク">${isExpanded ? '▲' : '＋'}</button>` : ''}
      </div>
    </div>
  `;

  const check = item.querySelector('.task-check');
  check.addEventListener('click', e => {
    e.stopPropagation();
    api('PUT', `/api/tasks/${task.id}`, { completed: !task.completed });
  });

  const editBtn = item.querySelector('.edit-btn');
  editBtn.addEventListener('click', e => { e.stopPropagation(); openModal(task.id); });

  if (!isSubtask) {
    const expandBtn = item.querySelector('.expand-btn');
    if (expandBtn) {
      expandBtn.addEventListener('click', e => {
        e.stopPropagation();
        toggleExpand(task.id);
      });
    }
    const toggleBtn = item.querySelector('.subtask-toggle-btn');
    if (toggleBtn) {
      toggleBtn.addEventListener('click', e => { e.stopPropagation(); toggleExpand(task.id); });
    }
  }

  // Drag events
  item.addEventListener('dragstart', e => {
    e.dataTransfer.setData('taskId', task.id);
    e.dataTransfer.setData('parentId', task.parentId ?? '');
    item.classList.add('dragging');
  });
  item.addEventListener('dragend', () => item.classList.remove('dragging'));

  return item;
}

function makeDropZone(parentId, index) {
  const zone = document.createElement('div');
  zone.className = 'drop-zone';
  zone.dataset.parentId = parentId ?? '';
  zone.dataset.index = index;

  zone.addEventListener('dragover', e => { e.preventDefault(); zone.classList.add('active'); });
  zone.addEventListener('dragleave', () => zone.classList.remove('active'));
  zone.addEventListener('drop', e => {
    e.preventDefault();
    zone.classList.remove('active');
    const draggedId = e.dataTransfer.getData('taskId');
    const targetParent = zone.dataset.parentId || null;
    const targetIndex = parseInt(zone.dataset.index);
    reorderTask(draggedId, targetParent, targetIndex);
  });

  return zone;
}

function toggleExpand(taskId) {
  if (expandedTasks.has(taskId)) expandedTasks.delete(taskId);
  else expandedTasks.add(taskId);
  render();
}

function scrollToTask(taskId) {
  const el = document.querySelector(`[data-id="${taskId}"]`);
  if (!el) return;
  el.scrollIntoView({ behavior: 'smooth', block: 'center' });
  el.classList.add('highlight');
  setTimeout(() => el.classList.remove('highlight'), 1300);
}

function reorderTask(draggedId, targetParentId, targetIndex) {
  const siblings = sortedChildren(targetParentId).filter(t => t.id !== draggedId);
  siblings.splice(targetIndex, 0, { id: draggedId });
  api('POST', '/api/tasks/reorder', {
    parentId: targetParentId,
    orderedIds: siblings.map(t => t.id),
  });
}

async function addSubtask(parentId, title) {
  title = title.trim();
  if (!title) return;
  await api('POST', '/api/tasks', { title, parentId });
}

// ── Add Task ──────────────────────────────────────────────
document.getElementById('add-task-btn').addEventListener('click', addRootTask);
document.getElementById('new-task-input').addEventListener('keydown', e => {
  if (e.key === 'Enter') addRootTask();
});

async function addRootTask() {
  const input = document.getElementById('new-task-input');
  const title = input.value.trim();
  if (!title) return;
  input.value = '';
  await api('POST', '/api/tasks', { title });
}

// ── Modal ─────────────────────────────────────────────────
function openModal(taskId) {
  editingTaskId = taskId;
  const task = tasks.find(t => t.id === taskId);
  if (!task) return;

  document.getElementById('edit-title').value = task.title;
  document.getElementById('edit-description').value = task.description || '';

  renderLinkedTasks(task);
  populateLinkSelect(task);

  document.getElementById('modal-overlay').classList.remove('hidden');
  document.getElementById('edit-title').focus();
}

function renderLinkedTasks(task) {
  const list = document.getElementById('linked-tasks-list');
  list.innerHTML = '';
  (task.linkedTaskIds || []).forEach(lid => {
    const linked = tasks.find(t => t.id === lid);
    if (!linked) return;
    const chip = document.createElement('div');
    chip.className = 'linked-chip';
    chip.innerHTML = `<span>${escHtml(linked.title)}</span><button title="リンク削除">✕</button>`;
    chip.querySelector('button').addEventListener('click', () => {
      api('DELETE', `/api/tasks/${task.id}/link/${lid}`);
      closeModal();
    });
    list.appendChild(chip);
  });
}

function populateLinkSelect(task) {
  const sel = document.getElementById('link-task-select');
  sel.innerHTML = '<option value="">タスクを選択してリンク...</option>';
  tasks
    .filter(t => t.id !== task.id && !(task.linkedTaskIds || []).includes(t.id))
    .forEach(t => {
      const opt = document.createElement('option');
      opt.value = t.id;
      opt.textContent = (t.parentId ? '  └ ' : '') + t.title;
      sel.appendChild(opt);
    });
}

document.getElementById('modal-close').addEventListener('click', closeModal);
document.getElementById('modal-overlay').addEventListener('click', e => {
  if (e.target === document.getElementById('modal-overlay')) closeModal();
});

document.getElementById('save-task-btn').addEventListener('click', async () => {
  const title = document.getElementById('edit-title').value.trim();
  const description = document.getElementById('edit-description').value.trim();
  if (!title || !editingTaskId) return;
  await api('PUT', `/api/tasks/${editingTaskId}`, { title, description });
  closeModal();
});

document.getElementById('delete-task-btn').addEventListener('click', async () => {
  if (!editingTaskId) return;
  if (!confirm('このタスク（サブタスク含む）を削除しますか？')) return;
  await api('DELETE', `/api/tasks/${editingTaskId}`);
  closeModal();
});

document.getElementById('add-link-btn').addEventListener('click', async () => {
  const sel = document.getElementById('link-task-select');
  if (!sel.value || !editingTaskId) return;
  await api('POST', `/api/tasks/${editingTaskId}/link`, { targetId: sel.value });
  closeModal();
});

document.addEventListener('keydown', e => { if (e.key === 'Escape') closeModal(); });

function closeModal() {
  document.getElementById('modal-overlay').classList.add('hidden');
  editingTaskId = null;
}

// ── Utils ─────────────────────────────────────────────────
function escHtml(str) {
  return String(str)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

// ── Init ──────────────────────────────────────────────────
connectSSE();
