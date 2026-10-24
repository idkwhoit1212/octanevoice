// Octane 3D Positional Voice Web Client
(function () {
    let ws = null;
    let localStream = null;
    let audioCtx = null;
    let localAnalyser = null;
    let myUserId = null;
    let myRoomId = null;
    let isMuted = false;

    // Хранилище пиров: userId -> { peerConnection, panner, gainNode, stream }
    const peers = new Map();

    // DOM элементы
    const joinSection = document.getElementById('joinSection');
    const voiceSection = document.getElementById('voiceSection');
    const codeInput = document.getElementById('codeInput');
    const connectBtn = document.getElementById('connectBtn');
    const muteBtn = document.getElementById('muteBtn');
    const micMeter = document.getElementById('micMeter');
    const playerLabel = document.getElementById('playerLabel');
    const peerCountLabel = document.getElementById('peerCountLabel');
    const peersList = document.getElementById('peersList');
    const statusLabel = document.getElementById('statusLabel');

    // Проверяем параметры в строке запроса ?code=1234
    const urlParams = new URLSearchParams(window.location.search);
    const queryCode = urlParams.get('code');
    if (queryCode) {
        codeInput.value = queryCode;
        setTimeout(() => connectWithCode(queryCode), 300);
    }

    connectBtn.addEventListener('click', () => {
        const code = codeInput.value.trim();
        if (code.length === 4) {
            connectWithCode(code);
        } else {
            alert('Введите 4-значный код из Roblox');
        }
    });

    muteBtn.addEventListener('click', toggleMute);

    async function connectWithCode(code) {
        try {
            connectBtn.disabled = true;
            connectBtn.innerText = 'Проверка кода...';

            const resp = await fetch(`/api/resolve_code/${code}`);
            if (!resp.ok) {
                throw new Error('Неверный или просроченный код!');
            }
            const data = await resp.json();
            myRoomId = data.roomId;
            myUserId = data.userId;
            playerLabel.innerText = data.username;

            await startVoiceSession();
        } catch (err) {
            alert(err.message || 'Ошибка подключения');
            connectBtn.disabled = false;
            connectBtn.innerText = 'Подключиться';
        }
    }

    async function startVoiceSession() {
        // Запрос микрофона
        try {
            localStream = await navigator.mediaDevices.getUserMedia({
                audio: {
                    echoCancellation: true,
                    noiseSuppression: true,
                    autoGainControl: true
                },
                video: false
            });
        } catch (e) {
            alert('Пожалуйста, разрешите доступ к микрофону!');
            connectBtn.disabled = false;
            connectBtn.innerText = 'Подключиться';
            return;
        }

        // Web Audio контекст для 3D звука и замера громкости
        const AudioContextClass = window.AudioContext || window.webkitAudioContext;
        audioCtx = new AudioContextClass();
        if (audioCtx.state === 'suspended') {
            await audioCtx.resume();
        }

        // Замер громкости своего микрофона
        const micSource = audioCtx.createMediaStreamSource(localStream);
        localAnalyser = audioCtx.createAnalyser();
        localAnalyser.fftSize = 256;
        micSource.connect(localAnalyser);

        startVolumeMeter();

        // Подключаем WebSocket сигналинг
        const wsProtocol = window.location.protocol === 'https:' ? 'wss:' : 'ws:';
        ws = new WebSocket(`${wsProtocol}//${window.location.host}`);

        ws.onopen = () => {
            ws.send(JSON.stringify({
                type: 'join',
                roomId: myRoomId,
                userId: myUserId,
                username: playerLabel.innerText
            }));

            joinSection.style.display = 'none';
            voiceSection.style.display = 'block';
        };

        ws.onmessage = async (evt) => {
            const data = JSON.parse(evt.data);

            switch (data.type) {
                case 'room_joined':
                    // Соединяемся со всеми участниками, которые уже есть в комнате
                    for (const peer of data.peers) {
                        await createPeerConnection(peer.userId, peer.username, true);
                    }
                    updatePeerListUI();
                    break;

                case 'peer_joined':
                    // Новый участник вошел, он создаст оффер или мы ждем
                    break;

                case 'peer_left':
                    removePeer(data.userId);
                    break;

                case 'positions_update':
                    update3DAudioPositions(data.positions);
                    break;

                case 'webrtc_offer':
                    await handleOffer(data);
                    break;

                case 'webrtc_answer':
                    await handleAnswer(data);
                    break;

                case 'webrtc_ice_candidate':
                    await handleCandidate(data);
                    break;
            }
        };

        ws.onclose = () => {
            statusLabel.innerText = 'Отключено';
            document.getElementById('netIndicator').classList.remove('active');
        };
    }

    const rtcConfig = {
        iceServers: [
            { urls: 'stun:stun.l.google.com:19302' },
            { urls: 'stun:stun1.l.google.com:19302' }
        ]
    };

    async function createPeerConnection(remoteUserId, username, isInitiator) {
        if (peers.has(remoteUserId)) return peers.get(remoteUserId).pc;

        const pc = new RTCPeerConnection(rtcConfig);

        // Добавляем наш локальный аудио-трек
        localStream.getAudioTracks().forEach(track => pc.addTrack(track, localStream));

        // Настройка 3D PannerNode для удаленного звука этого игрока
        const panner = audioCtx.createPanner();
        panner.panningModel = 'HRTF';
        panner.distanceModel = 'inverse';
        panner.refDistance = 12; // Радиус максимальной громкости (в стадах Roblox)
        panner.maxDistance = 160; // Предел слышимости
        panner.rolloffFactor = 1.3;
        panner.coneInnerAngle = 360;

        const gainNode = audioCtx.createGain();
        panner.connect(gainNode);
        gainNode.connect(audioCtx.destination);

        peers.set(remoteUserId, {
            pc,
            panner,
            gainNode,
            username: username || `Игрок ${remoteUserId}`
        });

        pc.ontrack = (event) => {
            const remoteAudioStream = event.streams[0];
            const source = audioCtx.createMediaStreamSource(remoteAudioStream);
            source.connect(panner);
        };

        pc.onicecandidate = (event) => {
            if (event.candidate && ws && ws.readyState === WebSocket.OPEN) {
                ws.send(JSON.stringify({
                    type: 'webrtc_ice_candidate',
                    targetUserId: remoteUserId,
                    candidate: event.candidate
                }));
            }
        };

        if (isInitiator) {
            const offer = await pc.createOffer();
            await pc.setLocalDescription(offer);
            ws.send(JSON.stringify({
                type: 'webrtc_offer',
                targetUserId: remoteUserId,
                offer
            }));
        }

        updatePeerListUI();
        return pc;
    }

    async function handleOffer(data) {
        const pc = await createPeerConnection(data.fromUserId, null, false);
        await pc.setRemoteDescription(new RTCSessionDescription(data.offer));
        const answer = await pc.createAnswer();
        await pc.setLocalDescription(answer);

        ws.send(JSON.stringify({
            type: 'webrtc_answer',
            targetUserId: data.fromUserId,
            answer
        }));
    }

    async function handleAnswer(data) {
        const peer = peers.get(data.fromUserId);
        if (peer && peer.pc) {
            await peer.pc.setRemoteDescription(new RTCSessionDescription(data.answer));
        }
    }

    async function handleCandidate(data) {
        const peer = peers.get(data.fromUserId);
        if (peer && peer.pc) {
            await peer.pc.addIceCandidate(new RTCIceCandidate(data.candidate));
        }
    }

    function removePeer(userId) {
        const peer = peers.get(userId);
        if (peer) {
            if (peer.pc) peer.pc.close();
            peers.delete(userId);
            updatePeerListUI();
        }
    }

    function updatePeerListUI() {
        peerCountLabel.innerText = peers.size;
        peersList.innerHTML = '';
        peers.forEach((p, uId) => {
            const div = document.createElement('div');
            div.className = 'peer-item';
            div.innerHTML = `<span>${p.username}</span><span style="color:#48bb78">● 3D</span>`;
            peersList.appendChild(div);
        });
    }

    // Обновление позиций в пространстве звука Web Audio
    function update3DAudioPositions(playerPositions) {
        if (!audioCtx) return;

        // Ищем себя для настройки AudioListener
        const me = playerPositions.find(p => Number(p.userId) === myUserId);
        if (me) {
            const listener = audioCtx.listener;
            const now = audioCtx.currentTime;

            if (listener.positionX) {
                // Современный Web Audio API
                listener.positionX.setValueAtTime(me.x, now);
                listener.positionY.setValueAtTime(me.y, now);
                listener.positionZ.setValueAtTime(me.z, now);
                listener.forwardX.setValueAtTime(me.lookX, now);
                listener.forwardY.setValueAtTime(me.lookY, now);
                listener.forwardZ.setValueAtTime(me.lookZ, now);
                listener.upX.setValueAtTime(0, now);
                listener.upY.setValueAtTime(1, now);
                listener.upZ.setValueAtTime(0, now);
            } else {
                // Старый API
                listener.setPosition(me.x, me.y, me.z);
                listener.setOrientation(me.lookX, me.lookY, me.lookZ, 0, 1, 0);
            }
        }

        // Обновляем PannerNode для каждого собеседника
        for (const p of playerPositions) {
            const uId = Number(p.userId);
            if (uId === myUserId) continue;

            const peer = peers.get(uId);
            if (peer && peer.panner) {
                const now = audioCtx.currentTime;
                if (peer.panner.positionX) {
                    peer.panner.positionX.setValueAtTime(p.x, now);
                    peer.panner.positionY.setValueAtTime(p.y, now);
                    peer.panner.positionZ.setValueAtTime(p.z, now);
                } else {
                    peer.panner.setPosition(p.x, p.y, p.z);
                }
            }
        }
    }

    function toggleMute() {
        if (!localStream) return;
        isMuted = !isMuted;
        localStream.getAudioTracks().forEach(track => {
            track.enabled = !isMuted;
        });

        if (isMuted) {
            muteBtn.classList.add('muted');
            muteBtn.innerText = 'Микрофон: ВЫКЛ (Muted)';
        } else {
            muteBtn.classList.remove('muted');
            muteBtn.innerText = 'Микрофон: ВКЛ';
        }
    }

    // Замер громкости своего микрофона для передачи уровня в игру
    function startVolumeMeter() {
        const buffer = new Uint8Array(localAnalyser.frequencyBinCount);
        let lastReportTime = 0;

        function checkVolume() {
            localAnalyser.getByteFrequencyData(buffer);
            let sum = 0;
            for (let i = 0; i < buffer.length; i++) {
                sum += buffer[i];
            }
            const average = sum / buffer.length;
            // Нормализация в проценты 0..100
            const volumePercent = isMuted ? 0 : Math.min(100, Math.round((average / 128) * 100));

            micMeter.style.width = volumePercent + '%';

            // Отправляем на сервер каждые 80 мс
            const now = Date.now();
            if (now - lastReportTime > 80 && ws && ws.readyState === WebSocket.OPEN) {
                lastReportTime = now;
                ws.send(JSON.stringify({
                    type: 'volume_update',
                    volume: volumePercent,
                    isMuted: isMuted
                }));
            }

            requestAnimationFrame(checkVolume);
        }

        requestAnimationFrame(checkVolume);
    }
})();
