const express = require('express');
const http = require('http');
const WebSocket = require('ws');
const path = require('path');

const app = express();
const server = http.createServer(app);
const wss = new WebSocket.Server({ server });

app.use(express.static(path.join(__dirname, 'public')));

const state = {
  boardLetters: [],
  currentHighlight: -1,
  teacher: null,
  students: {},
  chatHistory: [],
  fontSizeMode: 'small'
};

const clients = new Map();

function generateId() {
  return Math.random().toString(36).substr(2, 9);
}

function assignSeat() {
  const used = new Set(Object.values(state.students).map(s => s.seat));
  for (let i = 0; i < 20; i++) {
    if (!used.has(i)) return i;
  }
  return Math.floor(Math.random() * 20);
}

function broadcastAll(data) {
  const msg = JSON.stringify(data);
  wss.clients.forEach(ws => {
    if (ws.readyState === WebSocket.OPEN) ws.send(msg);
  });
}

function buildStateMsg() {
  return {
    type: 'classroom_state',
    boardLetters: state.boardLetters,
    currentHighlight: state.currentHighlight,
    teacher: state.teacher,
    students: Object.values(state.students),
    chatHistory: state.chatHistory.slice(-50),
    fontSizeMode: state.fontSizeMode
  };
}

wss.on('connection', (ws) => {
  const id = generateId();
  clients.set(ws, { id });
  console.log(`Client connected: ${id}`);

  ws.on('message', (raw) => {
    try {
      const msg = JSON.parse(raw);
      const client = clients.get(ws);

      switch (msg.type) {
        case 'join': {
          client.name = msg.name;
          client.role = msg.role;
          if (msg.role === 'teacher') {
            state.teacher = { id, name: msg.name };
            ws.send(JSON.stringify({ type: 'joined', id, role: 'teacher', seat: -1 }));
          } else {
            const seat = assignSeat();
            client.seat = seat;
            state.students[id] = { id, name: msg.name, seat, handRaised: false };
            ws.send(JSON.stringify({ type: 'joined', id, role: 'student', seat }));
          }
          const sysMsg = { name: 'System', message: `${msg.name} joined as ${msg.role}`, time: now(), system: true };
          state.chatHistory.push(sysMsg);
          broadcastAll(buildStateMsg());
          break;
        }

        case 'board_add': {
          if (client.role !== 'teacher') break;
          state.boardLetters.push(msg.letter);          // duplicates allowed
          state.currentHighlight = state.boardLetters.length - 1;
          broadcastAll(buildStateMsg());
          break;
        }

        case 'board_backspace': {
          if (client.role !== 'teacher') break;
          if (state.boardLetters.length > 0) state.boardLetters.pop();
          state.currentHighlight = state.boardLetters.length - 1;
          broadcastAll(buildStateMsg());
          break;
        }

        case 'board_clear': {
          if (client.role !== 'teacher') break;
          state.boardLetters = [];
          state.currentHighlight = -1;
          broadcastAll(buildStateMsg());
          break;
        }

        case 'board_set': {
          if (client.role !== 'teacher') break;
          if (Array.isArray(msg.letters)) {
            state.boardLetters = msg.letters.slice(0, 3000);
            state.currentHighlight = (typeof msg.highlight === 'number') ? msg.highlight : -1;
            broadcastAll(buildStateMsg());
          }
          break;
        }

        case 'board_highlight': {
          if (client.role !== 'teacher') break;
          state.currentHighlight = msg.index;
          broadcastAll(buildStateMsg());
          break;
        }

        case 'raise_hand': {
          if (client.role !== 'student' || !state.students[id]) break;
          state.students[id].handRaised = msg.raised;
          broadcastAll(buildStateMsg());
          break;
        }

        case 'chat': {
          const chatMsg = {
            name: client.name,
            role: client.role,
            message: msg.message,
            time: now(),
            system: false
          };
          state.chatHistory.push(chatMsg);
          broadcastAll({ type: 'chat_message', ...chatMsg });
          break;
        }

        case 'board_fontsize': {
          if (client.role !== 'teacher') break;
          if (['small', 'medium', 'large'].includes(msg.mode)) {
            state.fontSizeMode = msg.mode;
            broadcastAll(buildStateMsg());
          }
          break;
        }

        case 'rtc_signal': {
          // Forward WebRTC signaling message to the target peer
          for (const [sock, c] of clients.entries()) {
            if (c.id === msg.to && sock.readyState === WebSocket.OPEN) {
              sock.send(JSON.stringify({ type: 'rtc_signal', from: id, signal: msg.signal }));
              break;
            }
          }
          break;
        }
      }
    } catch (e) {
      console.error('Parse error:', e.message);
    }
  });

  ws.on('close', () => {
    const client = clients.get(ws);
    if (!client) return;
    if (client.role === 'teacher') state.teacher = null;
    if (client.role === 'student') delete state.students[client.id];
    const sysMsg = { name: 'System', message: `${client.name || 'Someone'} left`, time: now(), system: true };
    state.chatHistory.push(sysMsg);
    clients.delete(ws);
    broadcastAll(buildStateMsg());
    console.log(`Client disconnected: ${client.id}`);
  });

  ws.send(JSON.stringify(buildStateMsg()));
});

function now() {
  return new Date().toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
}

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => {
  console.log(`\n🏫 VR Classroom running at http://localhost:${PORT}\n`);
});
