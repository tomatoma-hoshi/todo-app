const express = require('express');
const { WebSocketServer } = require('ws');
const http = require('http');
const fs = require('fs');
const path = require('path');
const { v4: uuidv4 } = require('uuid');

const app = express();
const server = http.createServer(app);
const wss = new WebSocketServer({ server });

const DATA_FILE = path.join(__dirname, 'data', 'todos.json');

app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));

function loadData() {
  if (!fs.existsSync(DATA_FILE)) {
    const initial = { tasks: [] };
    fs.writeFileSync(DATA_FILE, JSON.stringify(initial, null, 2));
    return initial;
  }
  try {
    return JSON.parse(fs.readFileSync(DATA_FILE, 'utf8'));
  } catch {
    return { tasks: [] };
  }
}

function saveData(data) {
  fs.writeFileSync(DATA_FILE, JSON.stringify(data, null, 2));
}

function broadcast(message, excludeWs = null) {
  const msg = JSON.stringify(message);
  wss.clients.forEach(client => {
    if (client !== excludeWs && client.readyState === 1) {
      client.send(msg);
    }
  });
}

// REST API
app.get('/api/tasks', (req, res) => {
  res.json(loadData());
});

app.post('/api/tasks', (req, res) => {
  const data = loadData();
  const task = {
    id: uuidv4(),
    title: req.body.title,
    description: req.body.description || '',
    completed: false,
    parentId: req.body.parentId || null,
    order: req.body.order ?? data.tasks.filter(t => t.parentId === (req.body.parentId || null)).length,
    linkedTaskIds: [],
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
  };
  data.tasks.push(task);
  saveData(data);
  broadcast({ type: 'task:created', task });
  res.json(task);
});

app.put('/api/tasks/:id', (req, res) => {
  const data = loadData();
  const idx = data.tasks.findIndex(t => t.id === req.params.id);
  if (idx === -1) return res.status(404).json({ error: 'Not found' });
  data.tasks[idx] = { ...data.tasks[idx], ...req.body, id: req.params.id, updatedAt: new Date().toISOString() };
  saveData(data);
  broadcast({ type: 'task:updated', task: data.tasks[idx] });
  res.json(data.tasks[idx]);
});

app.delete('/api/tasks/:id', (req, res) => {
  const data = loadData();
  const toDelete = new Set();
  function collectIds(id) {
    toDelete.add(id);
    data.tasks.filter(t => t.parentId === id).forEach(t => collectIds(t.id));
  }
  collectIds(req.params.id);
  data.tasks = data.tasks.filter(t => !toDelete.has(t.id));
  data.tasks = data.tasks.map(t => ({
    ...t,
    linkedTaskIds: t.linkedTaskIds.filter(lid => !toDelete.has(lid)),
  }));
  saveData(data);
  broadcast({ type: 'task:deleted', ids: [...toDelete] });
  res.json({ deleted: [...toDelete] });
});

app.post('/api/tasks/reorder', (req, res) => {
  // req.body: { parentId, orderedIds }
  const data = loadData();
  const { parentId, orderedIds } = req.body;
  orderedIds.forEach((id, index) => {
    const task = data.tasks.find(t => t.id === id);
    if (task) {
      task.order = index;
      task.parentId = parentId ?? null;
      task.updatedAt = new Date().toISOString();
    }
  });
  saveData(data);
  broadcast({ type: 'task:reordered', parentId, orderedIds });
  res.json({ ok: true });
});

app.post('/api/tasks/:id/link', (req, res) => {
  const data = loadData();
  const task = data.tasks.find(t => t.id === req.params.id);
  const target = data.tasks.find(t => t.id === req.body.targetId);
  if (!task || !target) return res.status(404).json({ error: 'Not found' });
  if (!task.linkedTaskIds.includes(req.body.targetId)) {
    task.linkedTaskIds.push(req.body.targetId);
    task.updatedAt = new Date().toISOString();
  }
  saveData(data);
  broadcast({ type: 'task:updated', task });
  res.json(task);
});

app.delete('/api/tasks/:id/link/:targetId', (req, res) => {
  const data = loadData();
  const task = data.tasks.find(t => t.id === req.params.id);
  if (!task) return res.status(404).json({ error: 'Not found' });
  task.linkedTaskIds = task.linkedTaskIds.filter(lid => lid !== req.params.targetId);
  task.updatedAt = new Date().toISOString();
  saveData(data);
  broadcast({ type: 'task:updated', task });
  res.json(task);
});

wss.on('connection', ws => {
  ws.send(JSON.stringify({ type: 'init', data: loadData() }));
});

const PORT = process.env.PORT || 3000;
server.listen(PORT, '0.0.0.0', () => {
  console.log(`Todo app running at http://localhost:${PORT}`);
  console.log('For LAN access: http://<your-ip>:' + PORT);
});
