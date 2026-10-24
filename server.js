const express = require('express');
const http = require('http');
const WebSocket = require('ws');
const cors = require('cors');
const path = require('path');

const app = express();
app.use(cors());
app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));

const server = http.createServer(app);
const wss = new WebSocket.Server({ server });

// Хранилище сессий: roomId -> { players: { userId: { ws, peerId, volume, position, look } } }
const rooms = new Map();

// Коды быстрого входа: code -> { roomId, userId, username, expiresAt }
const quickCodes = new Map();

function getOrCreateRoom(roomId) {
    if (!rooms.has(roomId)) {
        rooms.set(roomId, {
            players: new Map() // userId -> data
        });
    }
    return rooms.get(roomId);
}

// Периодическая очистка просроченных кодов
setInterval(() => {
    const now = Date.now();
    for (const [code, entry] of quickCodes.entries()) {
        if (entry.expiresAt < now) {
            quickCodes.delete(code);
        }
    }
}, 15000);

// API для Roblox сервера: создание 4-значного кода для игрока
app.post('/api/create_code', (req, res) => {
    const { roomId, userId, username } = req.body;
    if (!roomId || !userId) {
        return res.status(400).json({ error: 'Missing roomId or userId' });
    }

    // Генерируем 4-значный цифровой код
    let code;
    do {
        code = Math.floor(1000 + Math.random() * 9000).toString();
    } while (quickCodes.has(code));

    quickCodes.set(code, {
        roomId: String(roomId),
        userId: Number(userId),
        username: String(username || 'Player'),
        expiresAt: Date.now() + 5 * 60 * 1000 // 5 минут жизни кода
    });

    res.json({ success: true, code });
});

// Проверка кода клиентом из браузера
app.get('/api/resolve_code/:code', (req, res) => {
    const entry = quickCodes.get(req.params.code);
    if (!entry || entry.expiresAt < Date.now()) {
        return res.status(404).json({ error: 'Код не найден или истёк' });
    }
    res.json(entry);
});

// API для Roblox сервера: отправка координат персонажей и получение статуса голоса
app.post('/api/sync', (req, res) => {
    const { roomId, players } = req.body;
    if (!roomId || !Array.isArray(players)) {
        return res.status(400).json({ error: 'Invalid payload' });
    }

    const room = getOrCreateRoom(String(roomId));
    const talkingStatuses = {};

    // Обновляем позиции игроков в комнате
    for (const p of players) {
        const uId = Number(p.userId);
        let playerEntry = room.players.get(uId);
        if (playerEntry) {
            playerEntry.position = { x: p.x, y: p.y, z: p.z };
            playerEntry.look = { x: p.lookX, y: p.lookY, z: p.lookZ };
            talkingStatuses[uId] = {
                connected: true,
                volume: playerEntry.volume || 0,
                isMuted: playerEntry.isMuted || false
            };
        }
    }

    // Оповещаем подключенные веб-клиенты о свежих координатах
    const posPayload = JSON.stringify({
        type: 'positions_update',
        positions: players
    });

    for (const [_, client] of room.players.entries()) {
        if (client.ws && client.ws.readyState === WebSocket.OPEN) {
            client.ws.send(posPayload);
        }
    }

    // Возвращаем Roblox серверу уровни громкости игроков для анимации баблов
    res.json({
        success: true,
        voices: talkingStatuses
    });
});

// WebSocket WebRTC signaling
wss.on('connection', (ws) => {
    let currentRoomId = null;
    let currentUserId = null;

    ws.on('message', (messageText) => {
        try {
            const data = JSON.parse(messageText);

            switch (data.type) {
                case 'join': {
                    currentRoomId = String(data.roomId);
                    currentUserId = Number(data.userId);

                    const room = getOrCreateRoom(currentRoomId);
                    
                    // Если уже был сокет для этого игрока, закрываем старый
                    const existing = room.players.get(currentUserId);
                    if (existing && existing.ws && existing.ws !== ws) {
                        existing.ws.close();
                    }

                    room.players.set(currentUserId, {
                        ws,
                        userId: currentUserId,
                        username: data.username || 'Player',
                        volume: 0,
                        isMuted: false,
                        position: { x: 0, y: 0, z: 0 },
                        look: { x: 0, y: 0, z: -1 }
                    });

                    // Отправляем новому игроку список участников для вызова WebRTC peer-to-peer
                    const existingPeers = [];
                    for (const [uId, p] of room.players.entries()) {
                        if (uId !== currentUserId) {
                            existingPeers.push({ userId: uId, username: p.username });
                        }
                    }

                    ws.send(JSON.stringify({
                        type: 'room_joined',
                        peers: existingPeers
                    }));

                    // Оповещаем остальных, что вошел новый пир
                    broadcastToRoom(currentRoomId, currentUserId, {
                        type: 'peer_joined',
                        userId: currentUserId,
                        username: data.username
                    });
                    break;
                }

                case 'volume_update': {
                    if (!currentRoomId || !currentUserId) return;
                    const room = rooms.get(currentRoomId);
                    if (!room) return;
                    const p = room.players.get(currentUserId);
                    if (p) {
                        p.volume = Math.max(0, Math.min(100, Math.round(data.volume || 0)));
                        p.isMuted = !!data.isMuted;
                    }
                    break;
                }

                // WebRTC Signaling: relay offer, answer, candidate
                case 'webrtc_offer':
                case 'webrtc_answer':
                case 'webrtc_ice_candidate': {
                    const targetId = Number(data.targetUserId);
                    if (!currentRoomId || !targetId) return;

                    const room = rooms.get(currentRoomId);
                    if (!room) return;

                    const targetPlayer = room.players.get(targetId);
                    if (targetPlayer && targetPlayer.ws && targetPlayer.ws.readyState === WebSocket.OPEN) {
                        targetPlayer.ws.send(JSON.stringify({
                            ...data,
                            fromUserId: currentUserId
                        }));
                    }
                    break;
                }
            }
        } catch (err) {
            console.error('WS Error:', err);
        }
    });

    ws.on('close', () => {
        if (currentRoomId && currentUserId) {
            const room = rooms.get(currentRoomId);
            if (room) {
                room.players.delete(currentUserId);
                broadcastToRoom(currentRoomId, currentUserId, {
                    type: 'peer_left',
                    userId: currentUserId
                });
                if (room.players.size === 0) {
                    rooms.delete(currentRoomId);
                }
            }
        }
    });
});

function broadcastToRoom(roomId, senderUserId, messageObj) {
    const room = rooms.get(roomId);
    if (!room) return;
    const msg = JSON.stringify(messageObj);
    for (const [uId, player] of room.players.entries()) {
        if (uId !== senderUserId && player.ws && player.ws.readyState === WebSocket.OPEN) {
            player.ws.send(msg);
        }
    }
}

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => {
    console.log(`[Octane 3D Voice Server] Running on http://localhost:${PORT}`);
});
