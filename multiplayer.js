/*
 * Bakari Multiplayer — browser-only, peer-to-peer via WebRTC (PeerJS)
 *
 * Architecture overview
 * ─────────────────────
 * • Star topology: every guest opens a direct WebRTC data channel to the host.
 * • Host-authoritative: the host validates every move and broadcasts committed
 *   state to all peers. Guests never mutate shared state directly.
 * • Signalling: PeerJS cloud server (peerjs.com) is used only for the initial
 *   WebRTC handshake (SDP offer/answer + ICE candidates). No game state ever
 *   touches the signalling server.
 * • QR join: the host's short peer ID is embedded in a join URL that is
 *   displayed as a QR code. Guests scan → open URL → enter profile → connect.
 *
 * Message protocol (JSON objects over PeerJS data channels)
 * ─────────────────────────────────────────────────────────
 *   guest → host
 *     join           { type, name, color, icon }
 *     move           { type, row, col }
 *     resync_request { type }
 *
 *   host → guest(s)
 *     welcome         { type, myPlayerId, players, status }
 *     player_joined   { type, player }
 *     player_left     { type, playerId }
 *     game_start      { type, seed, difficulty, turnOrder }
 *     move_committed  { type, playerId, row, col, isGoat,
 *                       nextTurnPlayerId, players }
 *     game_finished   { type, winnerId, players }
 *     resync_response { type, state }
 *
 * Limitations / known tradeoffs
 * ──────────────────────────────
 * • Requires the PeerJS cloud signalling server to be reachable. The game
 *   data itself is peer-to-peer and never hits a backend.
 * • If the host closes their browser the session ends for all guests.
 * • Session recovery is best-effort and keeps a temporary grace window for
 *   reconnecting guests.
 * • WebRTC requires HTTPS (or localhost) in modern browsers; plain HTTP
 *   deployment will not work for multiplayer.
 */

// ─── Constants ────────────────────────────────────────────────────────────────

const MP_PEER_PREFIX = 'bakari-';
const MP_VERSION = 3;
const MP_QR_SIZE = 200;
const MP_PEER_OPEN_TIMEOUT_MS = 12000;
const MP_CONN_OPEN_TIMEOUT_MS = 12000;
const MP_WELCOME_TIMEOUT_MS = 12000;
const MP_RECONNECT_GRACE_MS = 45000;
const MP_RECONNECT_MAX_ATTEMPTS = 6;
const MP_RECONNECT_BACKOFF_MS = [0, 1500, 3000, 6000, 10000, 15000];

const MP_PROFILE_STORAGE_KEY = 'bakari_mp_profile';
const MP_SESSION_STORAGE_KEY = 'bakari_mp_session_v1';

const MP_COLORS = [
  '#e74c3c', // red
  '#3498db', // blue
  '#2ecc71', // green
  '#f39c12', // orange
  '#9b59b6', // purple
  '#1abc9c', // teal
  '#e91e63', // pink
  '#607d8b', // slate
];

const MP_ICONS = ['🦁', '🐬', '🐘', '🦊', '🦋', '🐢', '🦅', '🐙'];

// ─── Profile persistence ──────────────────────────────────────────────────────

function mpSaveProfile(profile) {
  try {
    localStorage.setItem(
      MP_PROFILE_STORAGE_KEY,
      JSON.stringify({ name: profile.name, color: profile.color, icon: profile.icon }),
    );
  } catch (_) {}
}

function mpLoadProfile() {
  try {
    return JSON.parse(localStorage.getItem(MP_PROFILE_STORAGE_KEY) || 'null');
  } catch (_) {
    return null;
  }
}

function mpSaveSessionSnapshot() {
  if (!mpSession) return;
  try {
    const snapshot = {
      version: 1,
      role: mpSession.mode,
      hostPeerId: mpSession.hostPeerId || null,
      matchId: mpSession.matchId || null,
      playerId: mpSession.myId || null,
      resumeToken: mpSession.resumeToken || null,
      profile: mpSession.myProfile
        ? {
            name: mpSession.myProfile.name,
            color: mpSession.myProfile.color,
            icon: mpSession.myProfile.icon,
          }
        : null,
      updatedAt: Date.now(),
    };
    localStorage.setItem(MP_SESSION_STORAGE_KEY, JSON.stringify(snapshot));
  } catch (_) {}
}

function mpLoadSessionSnapshot() {
  try {
    return JSON.parse(localStorage.getItem(MP_SESSION_STORAGE_KEY) || 'null');
  } catch (_) {
    return null;
  }
}

function mpClearSessionSnapshot() {
  try {
    localStorage.removeItem(MP_SESSION_STORAGE_KEY);
  } catch (_) {}
}

// ─── State ────────────────────────────────────────────────────────────────────

/*
 * mpSession is null when not in multiplayer mode; otherwise:
 * {
 *   mode: 'host' | 'guest',
 *   myId: string,            — stable player identity for this client
 *   myPeerId: string | null, — current PeerJS transport identity
 *   hostPeerId: string | null,
 *   matchId: string | null,
 *   resumeToken: string | null,
 *   myProfile: Player,
 *   players: Player[],       — ordered: host first, then guests by join order
 *   status: 'lobby' | 'playing' | 'finished',
 *   currentTurnIdx: number,
 *   revealedBy: { [cellKey: string]: string },  — cellKey = "row-col"
 *   winner: Player | null,
 *   waitingForMoveConfirm: boolean,  — guest only
 * }
 *
 * Player: { id, name, color, icon, score, totalMoves, isConnected, isHost }
 */
let mpSession = null;

// PeerJS Peer instance for this client
let mpPeer = null;

// Host side: map of peerId → DataConnection for each connected guest
const mpConnections = {};

// Guest side: single DataConnection to host
let mpHostConn = null;
let mpHostCreateTimer = null;
let mpGuestPeerOpenTimer = null;
let mpGuestConnOpenTimer = null;
let mpGuestWelcomeTimer = null;
let mpGuestReconnectTimer = null;

const mpGraceTimers = {};

const mpGuestRecovery = {
  state: 'connected', // connected | reconnecting | disconnected
  attempt: 0,
  maxAttempts: MP_RECONNECT_MAX_ATTEMPTS,
  manualOnly: false,
  reason: '',
};

// ─── Utilities ────────────────────────────────────────────────────────────────

function mpRandomCode(len) {
  const chars = 'abcdefghijklmnopqrstuvwxyz0123456789';
  let s = '';
  for (let i = 0; i < len; i += 1) {
    s += chars[Math.floor(Math.random() * chars.length)];
  }
  return s;
}

function mpBuildJoinUrl(peerId) {
  const base = window.location.origin + window.location.pathname;
  return `${base}?join=${encodeURIComponent(peerId)}`;
}

function mpGetJoinParam() {
  return new URLSearchParams(window.location.search).get('join');
}

function mpMakePlayer(id, name, color, icon, isHost) {
  return {
    id,
    name,
    color,
    icon,
    score: 0,
    totalMoves: 0,
    isConnected: true,
    isHost,
    peerId: null,
    resumeToken: null,
    disconnectedAt: null,
    disconnectedUntil: null,
  };
}

function mpRandomId(prefix) {
  return `${prefix}-${mpRandomCode(6)}-${Date.now().toString(36)}`;
}

function mpIsWithinReconnectGrace(player) {
  return !!(player && player.disconnectedUntil && Date.now() <= player.disconnectedUntil);
}

function mpPlayerConnectionState(player) {
  if (!player || player.isConnected) return 'connected';
  return mpIsWithinReconnectGrace(player) ? 'reconnecting' : 'disconnected';
}

function mpPlayerConnectionLabel(player) {
  const state = mpPlayerConnectionState(player);
  if (state === 'connected') return '';
  if (state === 'reconnecting') return 'Reconnecting…';
  return 'Disconnected';
}

function mpGetPeerCtor() {
  if (typeof window.Peer === 'function') return window.Peer;
  if (window.peerjs && typeof window.peerjs.Peer === 'function') return window.peerjs.Peer;
  return null;
}

/**
 * Render a QR code for `text` into `container` using the locally-bundled
 * qrcode-svg library (assets/qrcode.min.js).  Generates an inline SVG with
 * no canvas and no external network request, so it works on all mobile
 * browsers regardless of network conditions.
 * Falls back to mpQrShowFallback if the library failed to load.
 */
function mpRenderQrCode(container, text) {
  try {
    const Ctor = window.QRCode;
    if (typeof Ctor !== 'function' || typeof Ctor.prototype.svg !== 'function') {
      throw new Error('QRCode library not available');
    }
    const svgStr = new Ctor({
      content: text,
      width: MP_QR_SIZE,
      height: MP_QR_SIZE,
      padding: 2,
      join: true,           // single <path> — cleaner SVG, reliable scan
      xmlDeclaration: false,
      container: 'svg',
    }).svg();
    if (!svgStr || !svgStr.includes('<svg')) throw new Error('empty SVG');
    const wrap = document.createElement('div');
    wrap.className = 'mp-qr-img mp-qr-svg';
    wrap.innerHTML = svgStr;
    container.innerHTML = '';
    container.appendChild(wrap);
  } catch (err) {
    console.warn('[MP] QR render error', err);
    mpQrShowFallback(container);
  }
}

function mpClearConnectionTimers() {
  clearTimeout(mpHostCreateTimer);
  clearTimeout(mpGuestPeerOpenTimer);
  clearTimeout(mpGuestConnOpenTimer);
  clearTimeout(mpGuestWelcomeTimer);
  clearTimeout(mpGuestReconnectTimer);
  mpHostCreateTimer = null;
  mpGuestPeerOpenTimer = null;
  mpGuestConnOpenTimer = null;
  mpGuestWelcomeTimer = null;
  mpGuestReconnectTimer = null;
}

function mpResetState(options = {}) {
  const { keepModal = false, keepSessionSnapshot = false } = options;
  mpClearConnectionTimers();

  if (mpPeer) {
    mpPeer.destroy();
    mpPeer = null;
  }
  Object.keys(mpConnections).forEach((k) => delete mpConnections[k]);
  Object.keys(mpGraceTimers).forEach((playerId) => {
    clearTimeout(mpGraceTimers[playerId]);
    delete mpGraceTimers[playerId];
  });
  mpHostConn = null;
  mpSession = null;
  mpGuestRecovery.state = 'connected';
  mpGuestRecovery.attempt = 0;
  mpGuestRecovery.manualOnly = false;
  mpGuestRecovery.reason = '';
  if (!keepSessionSnapshot) mpClearSessionSnapshot();

  document.body.classList.remove('mp-active');
  if (!keepModal) mpHideModal();
  mpHideInGameBar();

  const url = new URL(window.location.href);
  url.searchParams.delete('join');
  window.history.replaceState({}, '', url.toString());
}

function mpFailAndReset(msg) {
  mpShowError(msg);
  mpResetState({ keepModal: true });
}

// ─── Messaging helpers ────────────────────────────────────────────────────────

function mpSend(conn, msg) {
  try {
    if (conn && conn.open) {
      conn.send(msg);
    }
  } catch (err) {
    console.warn('[MP] send error', err);
  }
}

function mpBroadcast(msg) {
  Object.values(mpConnections).forEach((conn) => mpSend(conn, msg));
}

function mpSendToHost(msg) {
  mpSend(mpHostConn, msg);
}

// ─── Host: session creation ───────────────────────────────────────────────────

function mpHostCreate(profile) {
  const code = mpRandomCode(6);
  const peerId = MP_PEER_PREFIX + code;
  const matchId = mpRandomId('match');
  const hostPlayerId = `host-${code}`;
  const hostPlayer = mpMakePlayer(hostPlayerId, profile.name, profile.color, profile.icon, true);
  hostPlayer.peerId = peerId;
  hostPlayer.resumeToken = mpRandomId('resume');

  mpSession = {
    mode: 'host',
    matchId,
    hostPeerId: peerId,
    myId: hostPlayerId,
    myPeerId: peerId,
    resumeToken: hostPlayer.resumeToken,
    myProfile: hostPlayer,
    players: [hostPlayer],
    status: 'lobby',
    currentTurnIdx: 0,
    revealedBy: {},
    winner: null,
    waitingForMoveConfirm: false,
  };

  const PeerCtor = mpGetPeerCtor();
  if (!PeerCtor) {
    mpShowError('Multiplayer could not start because PeerJS failed to load. Refresh and try again.');
    return;
  }

  mpPeer = new PeerCtor(peerId);
  mpSaveSessionSnapshot();
  mpHostCreateTimer = setTimeout(() => {
    if (mpPeer && mpSession && mpSession.status === 'lobby' && mpSession.hostPeerId === peerId) {
      mpFailAndReset('Could not create the multiplayer match. Check your connection and try again.');
    }
  }, MP_PEER_OPEN_TIMEOUT_MS);

  mpPeer.on('open', (id) => {
    clearTimeout(mpHostCreateTimer);
    mpHostCreateTimer = null;
    mpSession.hostPeerId = id;
    mpSession.myPeerId = id;
    mpSession.myProfile.peerId = id;
    mpSession.players[0].peerId = id;
    mpSaveSessionSnapshot();
    mpRenderLobbyHost();
  });

  mpPeer.on('connection', mpHostOnConnection);

  mpPeer.on('disconnected', () => {
    try {
      if (mpPeer) mpPeer.reconnect();
    } catch (_) {}
  });

  mpPeer.on('error', (err) => {
    clearTimeout(mpHostCreateTimer);
    mpHostCreateTimer = null;
    console.error('[MP] peer error', err);
    if (err.type === 'unavailable-id') {
      // Retry with a new code
      mpPeer.destroy();
      mpHostCreate(profile);
      return;
    }
    mpFailAndReset('Connection error: ' + (err.message || err.type));
  });

  // Show loading state
  mpRenderLobbyLoading();
  document.body.classList.add('mp-active');
}

function mpHostOnConnection(conn) {
  const peerId = conn.peer;
  mpConnections[peerId] = conn;

  const sendLobbyState = () => {
    if (!mpSession) return;

    if (conn.metadata && conn.metadata.name) {
      mpHostHandleJoin(peerId, conn.metadata);
      return;
    }

    mpSend(conn, {
      type: 'welcome',
      version: MP_VERSION,
      matchId: mpSession.matchId,
      hostPeerId: mpSession.hostPeerId,
      myPlayerId: conn.__bakariPlayerId || null,
      players: mpSession.players,
      status: mpSession.status,
      reconnectGraceMs: MP_RECONNECT_GRACE_MS,
    });
  };

  conn.on('open', sendLobbyState);
  if (conn.open) sendLobbyState();

  conn.on('data', (data) => mpHostOnData(peerId, data));

  conn.on('close', () => mpHostOnGuestDisconnected(peerId));
  conn.on('error', () => mpHostOnGuestDisconnected(peerId));
}

function mpHostScheduleGraceTimeout(playerId, disconnectedUntil) {
  if (mpGraceTimers[playerId]) {
    clearTimeout(mpGraceTimers[playerId]);
  }
  const delay = Math.max(0, disconnectedUntil - Date.now());
  mpGraceTimers[playerId] = setTimeout(() => {
    delete mpGraceTimers[playerId];
    if (!mpSession || mpSession.mode !== 'host') return;
    const player = mpSession.players.find((p) => p.id === playerId);
    if (!player || player.isConnected || player.disconnectedUntil !== disconnectedUntil) return;
    player.disconnectedUntil = null;
    mpBroadcast({ type: 'player_connection_state', playerId, state: 'disconnected' });
    if (mpSession.status === 'lobby') mpRenderLobbyHost();
    else mpUpdateInGameUI();
  }, delay);
}

function mpHostOnGuestDisconnected(peerId) {
  delete mpConnections[peerId];
  if (!mpSession || mpSession.mode !== 'host') return;
  let disconnectedPlayerId = null;
  const idx = mpSession.players.findIndex((p) => p.peerId === peerId);
  if (idx >= 0) {
    const player = mpSession.players[idx];
    disconnectedPlayerId = player.id;
    player.isConnected = false;
    player.peerId = null;
    player.disconnectedAt = Date.now();
    player.disconnectedUntil = player.disconnectedAt + MP_RECONNECT_GRACE_MS;
    mpHostScheduleGraceTimeout(player.id, player.disconnectedUntil);
    mpBroadcast({
      type: 'player_connection_state',
      playerId: player.id,
      state: 'reconnecting',
      graceExpiresAt: player.disconnectedUntil,
    });
  }

  if (mpSession.status === 'playing') {
    // If it was the disconnected player's turn, advance
    const current = mpSession.players[mpSession.currentTurnIdx];
    if (current && disconnectedPlayerId && current.id === disconnectedPlayerId) {
      mpAdvanceTurn();
      mpBroadcast({
        type: 'move_committed',
        playerId: null,
        row: null,
        col: null,
        isGoat: false,
        nextTurnPlayerId: mpSession.players[mpSession.currentTurnIdx].id,
        players: mpSession.players,
      });
      mpUpdateInGameUI();
    } else {
      mpUpdateInGameUI();
    }
  } else {
    mpRenderLobbyHost();
  }
  mpSaveSessionSnapshot();
}

function mpHostOnData(peerId, data) {
  switch (data.type) {
    case 'join':
      mpHostHandleJoin(peerId, data);
      break;
    case 'move':
      mpHostHandleMove(
        (mpConnections[peerId] && mpConnections[peerId].__bakariPlayerId)
          || (mpSession.players.find((p) => p.peerId === peerId) || {}).id,
        data.row,
        data.col,
      );
      break;
    case 'resync_request':
      mpHostSendResync(peerId);
      break;
    default:
      break;
  }
}

function mpHostHandleJoin(peerId, data) {
  const conn = mpConnections[peerId];
  const guestVersion = Number(data && data.version);
  if (guestVersion !== MP_VERSION) {
    if (conn) {
      mpSend(conn, {
        type: 'join_rejected',
        reason: 'Host and guest are running different Bakari versions. Refresh both devices and try again.',
      });
      conn.close();
    }
    return;
  }

  const requestedPlayerId = String(data.playerId || '').trim();
  const requestedResumeToken = String(data.resumeToken || '').trim();
  const requestedMatchId = String(data.matchId || '').trim();
  const isResume = !!data.isResume;
  let player = requestedPlayerId ? mpSession.players.find((p) => p.id === requestedPlayerId) : null;
  const wasConnected = !!(player && player.isConnected);
  const isValidResume =
    !!(player && requestedResumeToken && player.resumeToken === requestedResumeToken);

  if (isResume || player) {
    if (!isValidResume) {
      if (conn) {
        mpSend(conn, {
          type: 'join_rejected',
          reason: 'Could not verify this player identity for resume. Rejoin from the host link.',
        });
      }
      return;
    }
    if (requestedMatchId && mpSession.matchId && requestedMatchId !== mpSession.matchId) {
      if (conn) {
        mpSend(conn, {
          type: 'join_rejected',
          reason: 'This reconnect request is for a different match.',
        });
      }
      return;
    }
    if (mpSession.status === 'playing' && player.disconnectedUntil && Date.now() > player.disconnectedUntil) {
      if (conn) {
        mpSend(conn, {
          type: 'join_rejected',
          reason: 'Reconnect grace period has expired for this player.',
        });
      }
      return;
    }
  } else if (mpSession.status !== 'lobby') {
    if (conn) {
      mpSend(conn, { type: 'join_rejected', reason: 'Game already in progress' });
    }
    return;
  }

  const takenColors = mpSession.players
    .filter((p) => !player || p.id !== player.id)
    .map((p) => p.color);
  const takenIcons = mpSession.players
    .filter((p) => !player || p.id !== player.id)
    .map((p) => p.icon);
  const colorConflict = takenColors.includes(data.color);
  const iconConflict = takenIcons.includes(data.icon);
  if (colorConflict || iconConflict) {
    if (conn) {
      const what = [colorConflict && 'color', iconConflict && 'icon'].filter(Boolean).join(' and ');
      mpSend(conn, {
        type: 'join_rejected',
        reason: `Your chosen ${what} is already taken by another player. Please pick a different one.`,
        takenColors,
        takenIcons,
      });
    }
    return;
  }

  if (!player) {
    const nextPlayerId = requestedPlayerId || mpRandomId('player');
    player = mpMakePlayer(nextPlayerId, data.name, data.color, data.icon, false);
    player.resumeToken = requestedResumeToken || mpRandomId('resume');
    mpSession.players.push(player);
  } else {
    player.name = data.name;
    player.color = data.color;
    player.icon = data.icon;
  }

  if (player.peerId && player.peerId !== peerId && mpConnections[player.peerId]) {
    try {
      mpConnections[player.peerId].close();
    } catch (_) {}
    delete mpConnections[player.peerId];
  }

  if (mpGraceTimers[player.id]) {
    clearTimeout(mpGraceTimers[player.id]);
    delete mpGraceTimers[player.id];
  }

  player.peerId = peerId;
  player.isConnected = true;
  player.disconnectedAt = null;
  player.disconnectedUntil = null;
  if (!player.resumeToken) {
    player.resumeToken = requestedResumeToken || mpRandomId('resume');
  }
  if (conn) {
    conn.__bakariJoined = true;
    conn.__bakariPlayerId = player.id;
  }

  mpSend(conn, {
    type: 'welcome',
    version: MP_VERSION,
    matchId: mpSession.matchId,
    hostPeerId: mpSession.hostPeerId,
    myPlayerId: player.id,
    resumeToken: player.resumeToken,
    players: mpSession.players,
    status: mpSession.status,
    reconnectGraceMs: MP_RECONNECT_GRACE_MS,
  });

  if (!wasConnected) {
    mpBroadcast({ type: 'player_connection_state', playerId: player.id, state: 'connected' });
  }

  if (mpSession.status === 'playing') {
    mpHostSendResync(peerId);
  }

  if (!isResume && !wasConnected) {
    Object.entries(mpConnections).forEach(([pid, c]) => {
      if (pid !== peerId) mpSend(c, { type: 'player_joined', player });
    });
  }

  mpSaveSessionSnapshot();
  if (mpSession.status === 'lobby') mpRenderLobbyHost();
  else mpUpdateInGameUI();
}

function mpHostStartGame() {
  if (mpSession.status !== 'lobby') return;

  // Use current difficulty selection + a fresh random seed
  const difficulty = document.getElementById('difficulty').value;
  const seed = randomSeed(); // game.js global

  mpSession.status = 'playing';
  mpSession.currentTurnIdx = 0;

  // Start the local game
  startPuzzle(seed, difficulty); // game.js global

  // Tell all guests to start
  mpBroadcast({
    type: 'game_start',
    matchId: mpSession.matchId,
    hostPeerId: mpSession.hostPeerId,
    seed,
    difficulty,
    turnOrder: mpSession.players.map((p) => p.id),
  });

  mpHideModal();
  mpShowInGameBar();
  mpSaveSessionSnapshot();
}

function mpHostHandleMove(playerId, row, col) {
  if (mpSession.status !== 'playing') return;
  if (!playerId) return;

  const currentPlayer = mpSession.players[mpSession.currentTurnIdx];
  if (!currentPlayer || currentPlayer.id !== playerId) return; // not your turn

  mpHostCommitMove(playerId, row, col);
}

function mpHostCommitMove(playerId, row, col) {
  // Validate cell not already revealed
  if (revealed[row][col]) return; // game.js global

  // Apply to local game state
  revealed[row][col] = true; // game.js global
  const isGoat = puzzle.goats[row] === col; // game.js global
  if (isGoat) foundGoats += 1; // game.js global
  totalMoves += 1; // game.js global

  // Track attribution
  mpSession.revealedBy[`${row}-${col}`] = playerId;

  // Update player stats
  const pIdx = mpSession.players.findIndex((p) => p.id === playerId);
  if (pIdx >= 0) {
    mpSession.players[pIdx].totalMoves += 1;
    if (isGoat) mpSession.players[pIdx].score += 1;
  }

  // Advance turn (skip disconnected players)
  mpAdvanceTurn();
  const nextPlayer = mpSession.players[mpSession.currentTurnIdx];

  // Broadcast committed move to all guests
  const moveMsg = {
    type: 'move_committed',
    playerId,
    row,
    col,
    isGoat,
    nextTurnPlayerId: nextPlayer.id,
    players: mpSession.players,
  };
  mpBroadcast(moveMsg);

  // Re-render
  renderBoard(); // game.js global
  renderStats(); // game.js global
  mpUpdateInGameUI();

  // Check win condition
  if (foundGoats === puzzle.size) { // game.js global
    mpHostFinishGame();
  }
}

function mpHostFinishGame() {
  won = true; // game.js global
  stopTimer(); // game.js global
  mpSession.status = 'finished';

  // Determine winner: most goats, tiebreak by fewest moves
  const sorted = [...mpSession.players].sort((a, b) => {
    if (b.score !== a.score) return b.score - a.score;
    return a.totalMoves - b.totalMoves;
  });
  mpSession.winner = sorted[0];

  const finishMsg = {
    type: 'game_finished',
    winnerId: mpSession.winner.id,
    players: mpSession.players,
  };
  mpBroadcast(finishMsg);

  boardEl.classList.add('win'); // game.js global
  mpShowWinScreen();
}

function mpHostRematch() {
  if (!mpSession || mpSession.mode !== 'host') return;

  // Reset game state but keep players and connections
  mpSession.status = 'playing';
  mpSession.currentTurnIdx = 0;
  mpSession.revealedBy = {};
  mpSession.winner = null;
  mpSession.waitingForMoveConfirm = false;
  mpSession.players.forEach((p) => { p.score = 0; p.totalMoves = 0; });

  const difficulty = document.getElementById('difficulty').value;
  const seed = randomSeed(); // game.js global

  startPuzzle(seed, difficulty); // game.js global

  mpBroadcast({
    type: 'game_start',
    matchId: mpSession.matchId,
    hostPeerId: mpSession.hostPeerId,
    seed,
    difficulty,
    turnOrder: mpSession.players.map((p) => p.id),
    rematch: true,
  });

  mpHideModal();
  mpShowInGameBar();
  mpSaveSessionSnapshot();
}

function mpHostSendResync(peerId) {
  const conn = mpConnections[peerId];
  if (!conn) return;

  // Reconstruct minimal state guests need to resync
  const state = {
    matchId: mpSession.matchId,
    hostPeerId: mpSession.hostPeerId,
    seed: puzzle ? puzzle.seed : null,
    difficulty: puzzle ? puzzle.difficulty : null,
    players: mpSession.players,
    status: mpSession.status,
    currentTurnIdx: mpSession.currentTurnIdx,
    revealedBy: mpSession.revealedBy,
    revealedFlat: [],
    winnerId: mpSession.winner ? mpSession.winner.id : null,
    foundGoats,
    totalMoves,
    elapsedSeconds,
    won,
  };

  // Include all revealed cells
  if (puzzle) {
    for (let r = 0; r < puzzle.size; r += 1) {
      for (let c = 0; c < puzzle.size; c += 1) {
        if (revealed[r][c]) {
          state.revealedFlat.push({ row: r, col: c });
        }
      }
    }
  }

  mpSend(conn, { type: 'resync_response', state });
}

// ─── Turn management ──────────────────────────────────────────────────────────

function mpAdvanceTurn() {
  const count = mpSession.players.length;
  let next = (mpSession.currentTurnIdx + 1) % count;
  // Skip disconnected players (up to count iterations to avoid infinite loop)
  for (let tries = 0; tries < count; tries += 1) {
    if (mpSession.players[next].isConnected) break;
    next = (next + 1) % count;
  }
  mpSession.currentTurnIdx = next;
}

// ─── Guest: join session ──────────────────────────────────────────────────────

function mpGuestConnect(hostPeerId, profile) {
  const PeerCtor = mpGetPeerCtor();
  if (!PeerCtor) {
    mpShowError('Multiplayer could not start because PeerJS failed to load. Refresh and try again.');
    return;
  }

  mpClearConnectionTimers();
  mpPeer = new PeerCtor();
  mpGuestPeerOpenTimer = setTimeout(() => {
    if (mpPeer && !mpSession) {
      mpFailAndReset('Could not reach the multiplayer network. Check your connection and try again.');
    }
  }, MP_PEER_OPEN_TIMEOUT_MS);

  mpPeer.on('open', (myPeerId) => {
    clearTimeout(mpGuestPeerOpenTimer);
    mpGuestPeerOpenTimer = null;
    const playerId = mpRandomId('player');
    const resumeToken = mpRandomId('resume');
    mpSession = {
      mode: 'guest',
      myId: playerId,
      myPeerId,
      hostPeerId,
      matchId: null,
      resumeToken,
      myProfile: mpMakePlayer(playerId, profile.name, profile.color, profile.icon, false),
      players: [],
      status: 'lobby',
      currentTurnIdx: 0,
      revealedBy: {},
      winner: null,
      waitingForMoveConfirm: false,
    };
    mpSession.myProfile.resumeToken = resumeToken;
    mpSaveSessionSnapshot();

    mpHostConn = mpPeer.connect(hostPeerId, {
      reliable: true,
      metadata: {
        version: MP_VERSION,
        name: profile.name,
        color: profile.color,
        icon: profile.icon,
      },
    });
    mpGuestConnOpenTimer = setTimeout(() => {
      if (mpHostConn && !mpHostConn.open) {
        mpFailAndReset('Could not open a connection to the host. Make sure the host lobby is still open and try again.');
      }
    }, MP_CONN_OPEN_TIMEOUT_MS);

    mpHostConn.on('open', () => {
      clearTimeout(mpGuestConnOpenTimer);
      mpGuestConnOpenTimer = null;
      // Send join request
      mpSendToHost({
        type: 'join',
        version: MP_VERSION,
        matchId: mpSession.matchId,
        playerId: mpSession.myId,
        resumeToken: mpSession.resumeToken,
        name: profile.name,
        color: profile.color,
        icon: profile.icon,
      });
      mpGuestWelcomeTimer = setTimeout(() => {
        if (mpSession && mpSession.status === 'lobby' && mpSession.players.length === 0) {
          mpFailAndReset('Connected to the host, but the lobby did not finish loading. Ask the host to reopen the match and try again.');
        }
      }, MP_WELCOME_TIMEOUT_MS);
      mpRenderLobbyGuestWaiting();
    });

    mpHostConn.on('data', (data) => mpGuestOnData(data));
    mpHostConn.on('close', () => mpGuestOnHostDisconnected());
    mpHostConn.on('error', (err) => {
      console.error('[MP] host connection error', err);
      mpGuestOnHostDisconnected();
    });
    document.body.classList.add('mp-active');
  });

  mpPeer.on('error', (err) => {
    mpClearConnectionTimers();
    console.error('[MP] peer error (guest)', err);
    if (err.type === 'peer-unavailable') {
      mpFailAndReset('Could not find the host. Make sure the QR code/link is fresh and the host lobby is still open.');
      return;
    }
    mpFailAndReset('Could not connect. Make sure the QR code/link is fresh and the host is online.');
  });

  mpRenderLobbyGuestConnecting();
}

function mpGuestScheduleReconnect(delayMs) {
  clearTimeout(mpGuestReconnectTimer);
  mpGuestReconnectTimer = setTimeout(() => {
    mpGuestReconnectTimer = null;
    mpGuestAttemptReconnect();
  }, Math.max(0, delayMs || 0));
}

function mpGuestAttemptReconnect() {
  if (!mpSession || mpSession.mode !== 'guest' || mpSession.status === 'finished') return;
  if (!mpSession.myProfile || !mpSession.myId || !mpSession.resumeToken) {
    mpGuestRecovery.state = 'disconnected';
    mpGuestRecovery.manualOnly = true;
    mpGuestRecovery.reason = 'Reconnect details are incomplete. Rejoin from the host link.';
    mpUpdateInGameUI();
    return;
  }
  if (!mpSession.hostPeerId) {
    mpGuestRecovery.state = 'disconnected';
    mpGuestRecovery.manualOnly = true;
    mpGuestRecovery.reason = 'Missing host information for reconnect.';
    mpUpdateInGameUI();
    return;
  }

  if (!navigator.onLine) {
    mpGuestRecovery.state = 'reconnecting';
    mpGuestRecovery.reason = 'You appear to be offline.';
    mpUpdateInGameUI();
    mpGuestScheduleReconnect(2000);
    return;
  }

  if (mpGuestRecovery.attempt >= mpGuestRecovery.maxAttempts && mpGuestRecovery.manualOnly) {
    mpGuestRecovery.state = 'disconnected';
    mpUpdateInGameUI();
    return;
  }

  mpGuestRecovery.state = 'reconnecting';
  mpGuestRecovery.reason = `Reconnecting… (attempt ${Math.min(mpGuestRecovery.attempt + 1, mpGuestRecovery.maxAttempts)}/${mpGuestRecovery.maxAttempts})`;
  mpUpdateInGameUI();

  mpClearConnectionTimers();
  if (mpHostConn) {
    try { mpHostConn.close(); } catch (_) {}
    mpHostConn = null;
  }
  if (mpPeer) {
    try { mpPeer.destroy(); } catch (_) {}
    mpPeer = null;
  }

  const PeerCtor = mpGetPeerCtor();
  if (!PeerCtor) {
    mpGuestRecovery.state = 'disconnected';
    mpGuestRecovery.manualOnly = true;
    mpGuestRecovery.reason = 'PeerJS is unavailable.';
    mpUpdateInGameUI();
    return;
  }

  const peer = new PeerCtor();
  mpPeer = peer;
  mpGuestPeerOpenTimer = setTimeout(() => {
    mpGuestPeerOpenTimer = null;
    mpGuestRecovery.attempt += 1;
    const backoff = MP_RECONNECT_BACKOFF_MS[Math.min(mpGuestRecovery.attempt, MP_RECONNECT_BACKOFF_MS.length - 1)];
    mpGuestRecovery.manualOnly = mpGuestRecovery.attempt >= mpGuestRecovery.maxAttempts;
    if (mpGuestRecovery.manualOnly) {
      mpGuestRecovery.state = 'disconnected';
      mpGuestRecovery.reason = 'Could not reconnect automatically.';
      mpUpdateInGameUI();
      return;
    }
    mpGuestScheduleReconnect(backoff);
  }, MP_PEER_OPEN_TIMEOUT_MS);

  peer.on('open', () => {
    clearTimeout(mpGuestPeerOpenTimer);
    mpGuestPeerOpenTimer = null;
    mpGuestConnOpenTimer = setTimeout(() => {
      mpGuestConnOpenTimer = null;
      mpGuestRecovery.attempt += 1;
      const backoff = MP_RECONNECT_BACKOFF_MS[Math.min(mpGuestRecovery.attempt, MP_RECONNECT_BACKOFF_MS.length - 1)];
      mpGuestRecovery.manualOnly = mpGuestRecovery.attempt >= mpGuestRecovery.maxAttempts;
      if (mpGuestRecovery.manualOnly) {
        mpGuestRecovery.state = 'disconnected';
        mpGuestRecovery.reason = 'Could not reconnect automatically.';
        mpUpdateInGameUI();
        return;
      }
      mpGuestScheduleReconnect(backoff);
    }, MP_CONN_OPEN_TIMEOUT_MS);

    const conn = peer.connect(mpSession.hostPeerId, { reliable: true });
    mpHostConn = conn;
    conn.on('open', () => {
      clearTimeout(mpGuestConnOpenTimer);
      mpGuestConnOpenTimer = null;
      mpSendToHost({
        type: 'join',
        version: MP_VERSION,
        isResume: true,
        matchId: mpSession.matchId,
        playerId: mpSession.myId,
        resumeToken: mpSession.resumeToken,
        name: mpSession.myProfile ? mpSession.myProfile.name : 'Guest',
        color: mpSession.myProfile ? mpSession.myProfile.color : MP_COLORS[0],
        icon: mpSession.myProfile ? mpSession.myProfile.icon : MP_ICONS[0],
      });
      mpGuestWelcomeTimer = setTimeout(() => {
        mpGuestWelcomeTimer = null;
        mpGuestRecovery.attempt += 1;
        const backoff = MP_RECONNECT_BACKOFF_MS[Math.min(mpGuestRecovery.attempt, MP_RECONNECT_BACKOFF_MS.length - 1)];
        mpGuestRecovery.manualOnly = mpGuestRecovery.attempt >= mpGuestRecovery.maxAttempts;
        if (mpGuestRecovery.manualOnly) {
          mpGuestRecovery.state = 'disconnected';
          mpGuestRecovery.reason = 'Reconnect timed out.';
          mpUpdateInGameUI();
          return;
        }
        mpGuestScheduleReconnect(backoff);
      }, MP_WELCOME_TIMEOUT_MS);
    });
    conn.on('data', (data) => mpGuestOnData(data));
    conn.on('close', () => mpGuestOnHostDisconnected('Connection closed.'));
    conn.on('error', () => mpGuestOnHostDisconnected('Connection error.'));
  });

  peer.on('disconnected', () => {
    try { peer.reconnect(); } catch (_) {}
  });

  peer.on('error', () => {
    clearTimeout(mpGuestPeerOpenTimer);
    mpGuestPeerOpenTimer = null;
    mpGuestRecovery.attempt += 1;
    const backoff = MP_RECONNECT_BACKOFF_MS[Math.min(mpGuestRecovery.attempt, MP_RECONNECT_BACKOFF_MS.length - 1)];
    mpGuestRecovery.manualOnly = mpGuestRecovery.attempt >= mpGuestRecovery.maxAttempts;
    if (mpGuestRecovery.manualOnly) {
      mpGuestRecovery.state = 'disconnected';
      mpGuestRecovery.reason = 'Could not reconnect automatically.';
      mpUpdateInGameUI();
      return;
    }
    mpGuestScheduleReconnect(backoff);
  });
}

function mpGuestBeginRecovery(reason) {
  if (!mpSession || mpSession.mode !== 'guest' || mpSession.status === 'finished') return;
  mpGuestRecovery.state = 'reconnecting';
  mpGuestRecovery.reason = reason || 'Connection interrupted.';
  if (!mpSession.hostPeerId && mpSession.players.length) {
    const hostPlayer = mpSession.players.find((p) => p.isHost);
    if (hostPlayer && hostPlayer.peerId) mpSession.hostPeerId = hostPlayer.peerId;
  }
  mpSaveSessionSnapshot();
  mpUpdateInGameUI();
  if (mpSession.status === 'lobby') mpRenderLobbyGuestWaiting();
  if (!mpGuestReconnectTimer) {
    mpGuestScheduleReconnect(MP_RECONNECT_BACKOFF_MS[Math.min(mpGuestRecovery.attempt, MP_RECONNECT_BACKOFF_MS.length - 1)]);
  }
}

function mpGuestOnHostDisconnected(reason = 'Host connection lost.') {
  if (!mpSession || mpSession.status === 'finished') return;
  mpGuestBeginRecovery(reason);
}

function mpGuestOnData(data) {
  switch (data.type) {
    case 'welcome':
      mpGuestApplyWelcome(data);
      break;
    case 'player_joined':
      mpSession.players.push(data.player);
      mpRenderLobbyGuestWaiting();
      break;
    case 'player_left': {
      const idx = mpSession.players.findIndex((p) => p.id === data.playerId);
      if (idx >= 0) {
        mpSession.players[idx].isConnected = false;
        mpSession.players[idx].disconnectedUntil = Date.now() + MP_RECONNECT_GRACE_MS;
      }
      if (mpSession.status === 'playing') mpUpdateInGameUI();
      else mpRenderLobbyGuestWaiting();
      break;
    }
    case 'player_connection_state': {
      const idx = mpSession.players.findIndex((p) => p.id === data.playerId);
      if (idx >= 0) {
        const player = mpSession.players[idx];
        player.isConnected = data.state === 'connected';
        player.disconnectedUntil = data.graceExpiresAt || null;
      }
      if (mpSession.status === 'playing') mpUpdateInGameUI();
      else mpRenderLobbyGuestWaiting();
      break;
    }
    case 'join_rejected':
      clearTimeout(mpGuestWelcomeTimer);
      mpGuestWelcomeTimer = null;
      if (mpGuestRecovery.state !== 'connected') {
        mpGuestRecovery.state = 'disconnected';
        mpGuestRecovery.manualOnly = true;
        mpGuestRecovery.reason = data.reason || 'Reconnect was rejected by the host.';
        mpUpdateInGameUI();
        if (mpSession.status === 'lobby') mpRenderLobbyGuestWaiting();
        break;
      }
      if (data.takenColors !== undefined || data.takenIcons !== undefined) {
        // Color/icon conflict — re-show the setup form without tearing down the connection
        mpShowError(data.reason || 'That color or icon is already taken. Please choose a different one.');
        mpRenderSetupForm(
          'guest',
          mpSession ? mpSession.hostPeerId : null,
          data.takenColors || [],
          data.takenIcons || [],
        );
      } else {
        mpFailAndReset(data.reason || 'Joining was rejected by the host.');
      }
      break;
    case 'game_start':
      mpGuestApplyGameStart(data);
      break;
    case 'move_committed':
      mpGuestApplyMoveCommitted(data);
      break;
    case 'game_finished':
      mpGuestApplyGameFinished(data);
      break;
    case 'resync_response':
      mpGuestApplyResync(data.state);
      break;
    default:
      break;
  }
}

function mpGuestApplyWelcome(data) {
  clearTimeout(mpGuestWelcomeTimer);
  mpGuestWelcomeTimer = null;
  if (Number(data.version) !== MP_VERSION) {
    mpFailAndReset('This join link opened a different Bakari version. Refresh both devices and try again.');
    return;
  }
  if (data.matchId) mpSession.matchId = data.matchId;
  if (data.hostPeerId) mpSession.hostPeerId = data.hostPeerId;
  if (data.myPlayerId) mpSession.myId = data.myPlayerId;
  if (data.resumeToken) mpSession.resumeToken = data.resumeToken;
  mpSession.players = data.players;
  mpSession.status = data.status;
  // Find my profile in the player list
  const me = mpSession.players.find((p) => p.id === data.myPlayerId);
  if (me) mpSession.myProfile = me;
  mpGuestRecovery.state = 'connected';
  mpGuestRecovery.attempt = 0;
  mpGuestRecovery.manualOnly = false;
  mpGuestRecovery.reason = '';
  mpSaveSessionSnapshot();
  if (mpSession.status === 'playing') {
    mpHideModal();
    mpShowInGameBar();
  } else {
    mpRenderLobbyGuestWaiting();
  }
  mpUpdateInGameUI();
  if (mpSession.status === 'playing') {
    mpSendToHost({ type: 'resync_request' });
  }
}

function mpGuestApplyGameStart(data) {
  if (data.matchId) mpSession.matchId = data.matchId;
  if (data.hostPeerId) mpSession.hostPeerId = data.hostPeerId;
  mpSession.status = 'playing';
  mpSession.currentTurnIdx = 0;
  mpSession.revealedBy = {};
  mpSession.winner = null;
  mpSession.waitingForMoveConfirm = false;

  // On rematch, reset per-player stats so scores start fresh
  if (data.rematch) {
    mpSession.players.forEach((p) => { p.score = 0; p.totalMoves = 0; });
  }

  // Guests start the puzzle with the same seed/difficulty as host
  startPuzzle(data.seed, data.difficulty); // game.js global

  if (data.turnOrder) {
    // Re-order players to match host's turn order
    const ordered = data.turnOrder
      .map((id) => mpSession.players.find((p) => p.id === id))
      .filter(Boolean);
    if (ordered.length) mpSession.players = ordered;
  }

  mpHideModal();
  mpShowInGameBar();
  mpSaveSessionSnapshot();
}

function mpGuestApplyMoveCommitted(data) {
  mpSession.waitingForMoveConfirm = false;

  if (data.row !== null && data.col !== null) {
    // Apply move to local state
    revealed[data.row][data.col] = true; // game.js global
    if (data.isGoat) foundGoats += 1; // game.js global
    totalMoves += 1; // game.js global

    mpSession.revealedBy[`${data.row}-${data.col}`] = data.playerId;
  }

  // Sync player stats
  if (data.players) {
    data.players.forEach((p) => {
      const local = mpSession.players.find((lp) => lp.id === p.id);
      if (local) {
        local.score = p.score;
        local.totalMoves = p.totalMoves;
        local.isConnected = p.isConnected;
        local.disconnectedUntil = p.disconnectedUntil || null;
      }
    });
  }

  // Update current turn
  if (data.nextTurnPlayerId) {
    const idx = mpSession.players.findIndex((p) => p.id === data.nextTurnPlayerId);
    if (idx >= 0) mpSession.currentTurnIdx = idx;
  }

  renderBoard(); // game.js global
  renderStats(); // game.js global
  mpUpdateInGameUI();
}

function mpGuestApplyGameFinished(data) {
  won = true; // game.js global
  stopTimer(); // game.js global
  mpSession.status = 'finished';

  if (data.players) mpSession.players = data.players;
  mpSession.winner = mpSession.players.find((p) => p.id === data.winnerId) || null;

  boardEl.classList.add('win'); // game.js global
  mpShowWinScreen();
}

function mpGuestApplyResync(state) {
  if (!mpSession) return;
  if (state.matchId) mpSession.matchId = state.matchId;
  if (state.hostPeerId) mpSession.hostPeerId = state.hostPeerId;
  if (state.seed && state.difficulty && (!puzzle || puzzle.seed !== state.seed || puzzle.difficulty !== state.difficulty)) {
    startPuzzle(state.seed, state.difficulty); // game.js global
  }
  mpSession.players = state.players;
  mpSession.status = state.status;
  mpSession.currentTurnIdx = state.currentTurnIdx;
  mpSession.revealedBy = state.revealedBy;

  // Reset and rebuild revealed array
  for (let r = 0; r < puzzle.size; r += 1) { // game.js global
    for (let c = 0; c < puzzle.size; c += 1) {
      revealed[r][c] = false; // game.js global
    }
  }
  state.revealedFlat.forEach(({ row, col }) => {
    revealed[row][col] = true; // game.js global
  });

  foundGoats = Number.isFinite(state.foundGoats)
    ? state.foundGoats
    : state.revealedFlat.filter(({ row, col }) => puzzle.goats[row] === col).length; // game.js global
  totalMoves = Number.isFinite(state.totalMoves) ? state.totalMoves : state.revealedFlat.length;
  if (Number.isFinite(state.elapsedSeconds)) elapsedSeconds = state.elapsedSeconds;
  if (state.winnerId) {
    mpSession.winner = mpSession.players.find((p) => p.id === state.winnerId) || null;
  }
  won = !!state.won;
  if (mpSession.status === 'playing' && !won) startTimer(); // game.js global
  else stopTimer(); // game.js global

  renderBoard(); // game.js global
  renderStats(); // game.js global
  mpUpdateInGameUI();
  mpSaveSessionSnapshot();
}

// ─── Game.js integration hooks ────────────────────────────────────────────────

/**
 * Called from game.js onCellClick before any single-player logic.
 * Returns true if the click was consumed by multiplayer (game.js should skip).
 */
window.mpHandleCellClick = function mpHandleCellClick(row, col) {
  if (!mpSession || mpSession.status !== 'playing') return false;

  // Already revealed
  if (revealed[row][col]) return true; // game.js global

  // Check if it's this player's turn
  const currentPlayer = mpSession.players[mpSession.currentTurnIdx];
  if (!currentPlayer || currentPlayer.id !== mpSession.myId) {
    mpFlashNotYourTurn();
    return true; // consumed but no action
  }

  // Don't allow a second click while waiting for host confirmation
  if (mpSession.waitingForMoveConfirm) return true;

  if (mpSession.mode === 'host') {
    mpHostCommitMove(mpSession.myId, row, col);
  } else {
    // Guest: propose move to host, wait for commit
    mpSession.waitingForMoveConfirm = true;
    mpSendToHost({ type: 'move', row, col });
  }

  return true; // consumed
};

/**
 * Called from game.js renderBoard for each revealed cell.
 * Returns the player who revealed this cell, or null if unknown.
 */
window.mpGetCellAttribution = function mpGetCellAttribution(row, col) {
  if (!mpSession) return null;
  const playerId = mpSession.revealedBy[`${row}-${col}`];
  if (!playerId) return null;
  return mpSession.players.find((p) => p.id === playerId) || null;
};

// ─── Leave / cleanup ──────────────────────────────────────────────────────────

function mpLeave() {
  mpResetState();
}

// ─── UI: shared helpers ───────────────────────────────────────────────────────

const mpModalEl = document.getElementById('mp-modal');
const mpModalContentEl = document.getElementById('mp-modal-content');
const mpBarEl = document.getElementById('mp-bar');

function mpShowModal() {
  mpModalEl.hidden = false;
  document.body.style.overflow = 'hidden';
}

function mpHideModal() {
  mpModalEl.hidden = true;
  document.body.style.overflow = '';
}

function mpShowError(msg) {
  mpModalContentEl.innerHTML = `
    <h2 class="mp-section-title">Multiplayer</h2>
    <p style="color:#c13d4a;">${mpEscape(msg)}</p>
    <div class="mp-btn-row">
      <button id="mp-close-err-btn" class="mp-btn-secondary">Close</button>
    </div>
  `;
  mpShowModal();
  document.getElementById('mp-close-err-btn').addEventListener('click', () => {
    mpLeave();
    mpHideModal();
  });
}

function mpShowInGameBar() {
  mpBarEl.hidden = false;
  mpUpdateInGameUI();
}

function mpHideInGameBar() {
  mpBarEl.hidden = true;
}

function mpEscape(str) {
  return String(str)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

function mpFlashNotYourTurn() {
  const bar = document.getElementById('mp-turn-label');
  if (!bar) return;
  bar.style.color = '#c13d4a';
  setTimeout(() => { bar.style.color = ''; }, 600);
}

// ─── UI: in-game bar ──────────────────────────────────────────────────────────

function mpUpdateInGameUI() {
  if (!mpSession || !mpBarEl) return;

  const currentPlayer = mpSession.players[mpSession.currentTurnIdx];
  const isMyTurn = currentPlayer && currentPlayer.id === mpSession.myId;

  let turnLabel;
  if (mpSession.status === 'finished') {
    turnLabel = '🏁 Game over!';
  } else if (!currentPlayer) {
    turnLabel = '';
  } else if (isMyTurn) {
    turnLabel = '<strong>Your turn!</strong>';
  } else {
    turnLabel = `${mpEscape(currentPlayer.icon)} ${mpEscape(currentPlayer.name)}'s turn`;
  }

  const playerChips = mpSession.players.map((p) => {
    const active = currentPlayer && p.id === currentPlayer.id && mpSession.status === 'playing';
    const connState = mpPlayerConnectionState(p);
    const disc = connState === 'connected' ? '' : ` ${connState}`;
    const statusLabel = mpPlayerConnectionLabel(p);
    return `<span class="mp-player-chip${active ? ' active-turn' : ''}${disc}">
      <span class="mp-player-dot" style="background:${mpEscape(p.color)}"></span>
      ${mpEscape(p.icon)} ${mpEscape(p.name)}
      ${statusLabel ? `<span class="mp-conn-pill">${mpEscape(statusLabel)}</span>` : ''}
      <span style="margin-left:0.25rem;font-size:0.7rem;color:#888">${p.score} 🐐</span>
    </span>`;
  }).join('');

  const me = mpSession.myProfile || mpSession.players.find((p) => p.id === mpSession.myId);
  const identityHtml = me
    ? `<div class="mp-bar-identity">You are <span style="background:${mpEscape(me.color)};border:2px solid #000;display:inline-block;width:12px;height:12px;border-radius:50%;vertical-align:middle;margin:0 3px"></span>${mpEscape(me.icon)} ${mpEscape(me.name)}</div>`
    : '';

  let reconnectHtml = '';
  if (mpSession.mode === 'guest' && mpSession.status !== 'finished' && mpGuestRecovery.state !== 'connected') {
    const label = mpGuestRecovery.state === 'reconnecting'
      ? (mpGuestRecovery.reason || 'Reconnecting to host…')
      : (mpGuestRecovery.reason || 'Disconnected from host.');
    reconnectHtml = `
      <div class="mp-reconnect-panel">
        <div class="mp-reconnect-text">${mpEscape(label)}</div>
        <div class="mp-reconnect-actions">
          <button id="mp-retry-now-btn" class="mp-btn-secondary">Retry now</button>
          <button id="mp-leave-match-btn" class="mp-btn-secondary">Leave match</button>
        </div>
      </div>
    `;
  }

  mpBarEl.innerHTML = `
    <div class="mp-bar-turn" id="mp-turn-label">${turnLabel}</div>
    <div class="mp-bar-players">${playerChips}</div>
    ${identityHtml}
    ${reconnectHtml}
  `;

  const retryBtn = document.getElementById('mp-retry-now-btn');
  if (retryBtn) {
    retryBtn.addEventListener('click', () => {
      mpGuestRecovery.manualOnly = false;
      mpGuestRecovery.attempt = 0;
      mpGuestBeginRecovery('Manual reconnect requested…');
    });
  }
  const leaveBtn = document.getElementById('mp-leave-match-btn');
  if (leaveBtn) {
    leaveBtn.addEventListener('click', () => {
      mpLeave();
    });
  }
}

// ─── UI: lobby (host) ─────────────────────────────────────────────────────────

function mpRenderLobbyLoading() {
  mpModalContentEl.innerHTML = `
    <h2 class="mp-section-title">Multiplayer — Creating match…</h2>
    <p class="mp-lobby-waiting">Connecting to PeerJS network…</p>
  `;
  mpShowModal();
}

function mpQrShowFallback(container) {
  container.innerHTML = '<p class="mp-qr-fallback">Could not render the QR code.<br>Refresh the page and reopen multiplayer.</p>';
}

function mpRenderLobbyHost() {
  if (!mpSession) return;

  const joinUrl = mpBuildJoinUrl(mpSession.hostPeerId);
  const playersHtml = mpSession.players.map((p) => `
    <div class="mp-lobby-player-row">
      <span class="mp-lobby-dot" style="background:${mpEscape(p.color)}"></span>
      <span>${mpEscape(p.icon)}</span>
      <span class="mp-lobby-name">${mpEscape(p.name)}</span>
      ${p.isHost ? '<span class="mp-lobby-badge">Host (you)</span>' : '<span class="mp-lobby-badge">Guest</span>'}
      ${mpPlayerConnectionLabel(p) ? `<span class="mp-lobby-badge">${mpEscape(mpPlayerConnectionLabel(p))}</span>` : ''}
    </div>
  `).join('');

  const canStart = mpSession.players.filter((p) => p.isConnected).length >= 2;

  mpModalContentEl.innerHTML = `
    <button id="mp-leave-btn" class="modal-close" type="button" aria-label="Leave multiplayer">✕</button>
    <h2 class="mp-section-title">Multiplayer Lobby</h2>

    <p style="font-size:0.82rem;color:var(--muted);margin:0 0 0.5rem">
      Ask other players to scan this QR code:
    </p>

    <div class="mp-qr-wrap">
      <div id="mp-qr-container" class="mp-qr-container"></div>
      <div class="mp-join-url">
        <input id="mp-url-input" type="text" readonly value="${mpEscape(joinUrl)}" />
        <button id="mp-copy-btn" class="mp-copy-btn">Copy link</button>
      </div>
    </div>

    <div class="mp-lobby-players">${playersHtml}</div>

    ${mpSession.players.length < 2
      ? '<p class="mp-lobby-waiting">Waiting for at least one more player…</p>'
      : ''}

    <div class="mp-btn-row">
      <button id="mp-start-btn" class="mp-btn-primary" ${canStart ? '' : 'disabled'}>
        Start Game (${mpSession.players.filter((p) => p.isConnected).length} players)
      </button>
    </div>
  `;

  mpShowModal();

  // Render QR code using locally-bundled qrcode-svg (no CDN, no canvas needed).
  const qrContainer = document.getElementById('mp-qr-container');
  if (qrContainer) {
    mpRenderQrCode(qrContainer, joinUrl);
  }

  document.getElementById('mp-copy-btn').addEventListener('click', async () => {
    try {
      await navigator.clipboard.writeText(joinUrl);
      document.getElementById('mp-copy-btn').textContent = 'Copied!';
      setTimeout(() => {
        const btn = document.getElementById('mp-copy-btn');
        if (btn) btn.textContent = 'Copy link';
      }, 2000);
    } catch {
      const input = document.getElementById('mp-url-input');
      if (input) { input.select(); document.execCommand('copy'); }
    }
  });

  document.getElementById('mp-start-btn').addEventListener('click', () => {
    if (!canStart) return;
    mpHostStartGame();
  });

  document.getElementById('mp-leave-btn').addEventListener('click', () => {
    mpLeave();
  });
}

// ─── UI: lobby (guest) ────────────────────────────────────────────────────────

function mpRenderLobbyGuestConnecting() {
  mpModalContentEl.innerHTML = `
    <h2 class="mp-section-title">Joining match…</h2>
    <p class="mp-lobby-waiting">Connecting to host…</p>
  `;
  mpShowModal();
}

function mpRenderLobbyGuestWaiting() {
  if (!mpSession) return;

  const playersHtml = mpSession.players.map((p) => `
    <div class="mp-lobby-player-row">
      <span class="mp-lobby-dot" style="background:${mpEscape(p.color)}"></span>
      <span>${mpEscape(p.icon)}</span>
      <span class="mp-lobby-name">${mpEscape(p.name)}</span>
      ${p.isHost ? '<span class="mp-lobby-badge">Host</span>' : ''}
      ${p.id === mpSession.myId ? '<span class="mp-lobby-badge">You</span>' : ''}
      ${mpPlayerConnectionLabel(p) ? `<span class="mp-lobby-badge">${mpEscape(mpPlayerConnectionLabel(p))}</span>` : ''}
    </div>
  `).join('');

  const isRecovering = mpGuestRecovery.state !== 'connected';
  const waitingText = isRecovering
    ? (mpGuestRecovery.reason || 'Reconnecting to host…')
    : 'Waiting for host to start the game…';
  const primaryBtn = isRecovering
    ? '<button id="mp-retry-now-btn" class="mp-btn-secondary">Retry now</button>'
    : '';

  mpModalContentEl.innerHTML = `
    <h2 class="mp-section-title">Multiplayer Lobby</h2>
    <p class="mp-lobby-waiting">${mpEscape(waitingText)}</p>
    <div class="mp-lobby-players">${playersHtml || '<p class="mp-lobby-waiting">Connecting…</p>'}</div>
    <div class="mp-btn-row">
      ${primaryBtn}
      <button id="mp-guest-leave-btn" class="mp-btn-secondary">Leave</button>
    </div>
  `;

  mpShowModal();

  const retryBtn = document.getElementById('mp-retry-now-btn');
  if (retryBtn) {
    retryBtn.addEventListener('click', () => {
      mpGuestRecovery.manualOnly = false;
      mpGuestRecovery.attempt = 0;
      mpGuestBeginRecovery('Manual reconnect requested…');
    });
  }
  document.getElementById('mp-guest-leave-btn').addEventListener('click', () => {
    mpLeave();
  });
}

// ─── UI: profile setup form ───────────────────────────────────────────────────

function mpRenderSetupForm(mode, hostPeerId, takenColors = [], takenIcons = []) {
  // Load last-used profile from localStorage
  const saved = mpLoadProfile();

  // Pick default color: saved preference if available and not taken, else first free
  const savedColor = saved && MP_COLORS.includes(saved.color) ? saved.color : null;
  const defaultColor =
    (savedColor && !takenColors.includes(savedColor) ? savedColor : null) ||
    MP_COLORS.find((c) => !takenColors.includes(c)) ||
    MP_COLORS[0];

  // Pick default icon: saved preference if available and not taken, else first free
  const savedIcon = saved && MP_ICONS.includes(saved.icon) ? saved.icon : null;
  const defaultIcon =
    (savedIcon && !takenIcons.includes(savedIcon) ? savedIcon : null) ||
    MP_ICONS.find((ic) => !takenIcons.includes(ic)) ||
    MP_ICONS[0];

  const colorSwatches = MP_COLORS.map((c) => {
    const taken = takenColors.includes(c);
    const selected = c === defaultColor;
    return `<button type="button" class="mp-color-swatch${selected ? ' selected' : ''}${taken ? ' used' : ''}"
      data-color="${c}" style="background:${c}" aria-label="Color ${c}"${taken ? ' disabled' : ''}></button>`;
  }).join('');

  const iconBtns = MP_ICONS.map((ic) => {
    const taken = takenIcons.includes(ic);
    const selected = ic === defaultIcon;
    return `<button type="button" class="mp-icon-btn${selected ? ' selected' : ''}${taken ? ' used' : ''}"
      data-icon="${ic}"${taken ? ' disabled' : ''}>${ic}</button>`;
  }).join('');

  const title = mode === 'host' ? 'Create Multiplayer Match' : 'Join Multiplayer Match';
  const actionLabel = mode === 'host' ? 'Create Match' : 'Join';

  mpModalContentEl.innerHTML = `
    <button id="mp-setup-close" class="modal-close" type="button" aria-label="Close">✕</button>
    <h2 class="mp-section-title">${title}</h2>

    <div class="mp-field">
      <label for="mp-name-input">Your name</label>
      <input type="text" id="mp-name-input" maxlength="20" placeholder="Enter your name"
        value="${mpEscape(saved && saved.name ? saved.name : '')}" />
    </div>

    <div class="mp-field">
      <label>Color</label>
      <div class="mp-color-picker" id="mp-color-picker">${colorSwatches}</div>
    </div>

    <div class="mp-field">
      <label>Icon</label>
      <div class="mp-icon-picker" id="mp-icon-picker">${iconBtns}</div>
    </div>

    <div class="mp-btn-row">
      <button id="mp-action-btn" class="mp-btn-primary">${actionLabel}</button>
    </div>
  `;

  mpShowModal();

  let selectedColor = defaultColor;
  let selectedIcon = defaultIcon;

  // Color swatch picker
  document.getElementById('mp-color-picker').addEventListener('click', (e) => {
    const swatch = e.target.closest('.mp-color-swatch');
    if (!swatch || swatch.disabled) return;
    selectedColor = swatch.dataset.color;
    document.querySelectorAll('.mp-color-swatch').forEach((s) => s.classList.remove('selected'));
    swatch.classList.add('selected');
  });

  // Icon picker
  document.getElementById('mp-icon-picker').addEventListener('click', (e) => {
    const btn = e.target.closest('.mp-icon-btn');
    if (!btn || btn.disabled) return;
    selectedIcon = btn.dataset.icon;
    document.querySelectorAll('.mp-icon-btn').forEach((b) => b.classList.remove('selected'));
    btn.classList.add('selected');
  });

  // Action button
  document.getElementById('mp-action-btn').addEventListener('click', () => {
    const name = document.getElementById('mp-name-input').value.trim();
    if (!name) {
      document.getElementById('mp-name-input').focus();
      return;
    }
    const profile = { name, color: selectedColor, icon: selectedIcon };
    mpSaveProfile(profile);
    if (mode === 'host') {
      mpHostCreate(profile);
    } else {
      // Peer and connection already established by mpGuestSetup; just send the join message
      mpSession.myProfile = mpMakePlayer(mpSession.myId, profile.name, profile.color, profile.icon, false);
      mpSession.myProfile.resumeToken = mpSession.resumeToken;
      mpSaveSessionSnapshot();
      mpSendToHost({
        type: 'join',
        version: MP_VERSION,
        matchId: mpSession.matchId,
        playerId: mpSession.myId,
        resumeToken: mpSession.resumeToken,
        name: profile.name,
        color: profile.color,
        icon: profile.icon,
      });
      mpGuestWelcomeTimer = setTimeout(() => {
        if (mpSession && mpSession.status === 'lobby') {
          mpFailAndReset(
            'Connected to the host, but the lobby did not finish loading. Ask the host to reopen the match and try again.',
          );
        }
      }, MP_WELCOME_TIMEOUT_MS);
      mpRenderLobbyGuestWaiting();
    }
  });

  // Close button
  document.getElementById('mp-setup-close').addEventListener('click', () => {
    mpHideModal();
    if (mpSession) mpLeave();
  });

  // Focus name input
  setTimeout(() => {
    const input = document.getElementById('mp-name-input');
    if (input) input.focus();
  }, 50);
}

// ─── Guest: peek lobby and present setup form ─────────────────────────────────

function mpGuestSetup(hostPeerId) {
  const PeerCtor = mpGetPeerCtor();
  if (!PeerCtor) {
    mpModalContentEl.innerHTML = '';
    mpShowModal();
    mpShowError('Multiplayer could not start because PeerJS failed to load. Refresh and try again.');
    return;
  }

  // Show a brief loading state while we peek the host's player list
  mpModalContentEl.innerHTML = `
    <button id="mp-guest-setup-close" class="modal-close" type="button" aria-label="Close">✕</button>
    <p style="text-align:center;color:var(--muted);font-size:0.9rem;margin:1.75rem 0">Connecting to host\u2026</p>
  `;
  mpShowModal();
  document.getElementById('mp-guest-setup-close').addEventListener('click', () => {
    mpHideModal();
    if (mpSession) mpLeave();
  });

  mpGuestPeerOpenTimer = setTimeout(() => {
    mpGuestPeerOpenTimer = null;
    if (!mpSession) {
      mpFailAndReset('Could not reach the multiplayer network. Check your connection and try again.');
    }
  }, MP_PEER_OPEN_TIMEOUT_MS);

  const savedSession = mpLoadSessionSnapshot();
  const canResumeSavedSession =
    savedSession
    && savedSession.role === 'guest'
    && savedSession.hostPeerId === hostPeerId
    && savedSession.playerId
    && savedSession.resumeToken;
  const restoredPlayerId = canResumeSavedSession ? savedSession.playerId : mpRandomId('player');
  const restoredResumeToken = canResumeSavedSession ? savedSession.resumeToken : mpRandomId('resume');

  const peer = new PeerCtor();

  peer.on('open', (myPeerId) => {
    clearTimeout(mpGuestPeerOpenTimer);
    mpGuestPeerOpenTimer = null;

    mpPeer = peer;
    mpSession = {
      mode: 'guest',
      myId: restoredPlayerId,
      myPeerId,
      hostPeerId,
      matchId: canResumeSavedSession ? savedSession.matchId : null,
      resumeToken: restoredResumeToken,
      myProfile: canResumeSavedSession && savedSession.profile
        ? mpMakePlayer(
            restoredPlayerId,
            savedSession.profile.name || 'Guest',
            savedSession.profile.color || MP_COLORS[0],
            savedSession.profile.icon || MP_ICONS[0],
            false,
          )
        : null,
      players: [],
      status: 'lobby',
      currentTurnIdx: 0,
      revealedBy: {},
      winner: null,
      waitingForMoveConfirm: false,
    };
    document.body.classList.add('mp-active');
    mpSaveSessionSnapshot();

    mpGuestConnOpenTimer = setTimeout(() => {
      mpGuestConnOpenTimer = null;
      if (mpHostConn && !mpHostConn.open) {
        mpFailAndReset(
          'Could not open a connection to the host. Make sure the host lobby is still open and try again.',
        );
      }
    }, MP_CONN_OPEN_TIMEOUT_MS);

    // Connect without a name in metadata so the host sends the current player list (welcome)
    const conn = peer.connect(hostPeerId, { reliable: true });
    mpHostConn = conn;

    conn.on('open', () => {
      clearTimeout(mpGuestConnOpenTimer);
      mpGuestConnOpenTimer = null;
      // Host will respond with a welcome message because no metadata.name is set
    });

    let peeked = false;
    conn.on('data', (data) => {
      if (!peeked && data.type === 'welcome') {
        peeked = true;
        if (Number(data.version) !== MP_VERSION) {
          mpFailAndReset(
            'This join link opened a different Bakari version. Refresh both devices and try again.',
          );
          return;
        }
        if (data.status !== 'lobby') {
          mpFailAndReset('This match has already started and is not accepting new players.');
          return;
        }
        const takenColors = (data.players || []).map((p) => p.color);
        const takenIcons = (data.players || []).map((p) => p.icon);
        mpRenderSetupForm('guest', hostPeerId, takenColors, takenIcons);
        return;
      }
      mpGuestOnData(data);
    });

    conn.on('close', () => mpGuestOnHostDisconnected());
    conn.on('error', (err) => {
      console.error('[MP] host connection error (guest setup)', err);
      mpGuestOnHostDisconnected();
    });
  });

  peer.on('error', (err) => {
    clearTimeout(mpGuestPeerOpenTimer);
    mpGuestPeerOpenTimer = null;
    console.error('[MP] peer error (guest setup)', err);
    if (err.type === 'peer-unavailable') {
      mpFailAndReset(
        'Could not find the host. Make sure the QR code/link is fresh and the host lobby is still open.',
      );
    } else {
      mpFailAndReset('Could not connect. Make sure the QR code/link is fresh and the host is online.');
    }
  });

  peer.on('disconnected', () => {
    try { peer.reconnect(); } catch (_) {}
    mpGuestBeginRecovery('Reconnecting to multiplayer network…');
  });
}

// ─── UI: win screen ───────────────────────────────────────────────────────────

function mpShowWinScreen() {
  if (!mpSession) return;

  const winner = mpSession.winner;
  const winnerName = winner ? `${winner.icon} ${winner.name}` : 'Nobody';

  // Sort standings: most goats first, tiebreak by fewest moves
  const standings = [...mpSession.players].sort((a, b) => {
    if (b.score !== a.score) return b.score - a.score;
    return a.totalMoves - b.totalMoves;
  });

  const rows = standings.map((p, i) => {
    const isWinner = winner && p.id === winner.id;
    return `<tr class="${isWinner ? 'winner-row' : ''}">
      <td>${i + 1}</td>
      <td>
        <div class="mp-standing-player">
          <span class="mp-lobby-dot" style="background:${mpEscape(p.color)}"></span>
          ${mpEscape(p.icon)} ${mpEscape(p.name)}
          ${isWinner ? ' 🏆' : ''}
        </div>
      </td>
      <td>${p.score}</td>
      <td>${p.totalMoves}</td>
    </tr>`;
  }).join('');

  const isHost = mpSession.mode === 'host';
  const rematchBtn = isHost
    ? '<button id="mp-rematch-btn" class="mp-btn-primary">Rematch</button>'
    : '<p class="mp-lobby-waiting">Waiting for host to start a rematch…</p>';

  mpModalContentEl.innerHTML = `
    <div class="mp-win-header">
      <span class="mp-win-emoji">🎉</span>
      <h3>${mpEscape(winnerName)} wins!</h3>
    </div>

    <table class="mp-final-standings">
      <thead>
        <tr>
          <th>#</th><th>Player</th><th>Goats 🐐</th><th>Moves</th>
        </tr>
      </thead>
      <tbody>${rows}</tbody>
    </table>

    <div class="mp-btn-row">
      ${rematchBtn}
      <button id="mp-quit-btn" class="mp-btn-secondary">Quit to Single Player</button>
    </div>
  `;

  mpShowModal();

  if (isHost) {
    document.getElementById('mp-rematch-btn').addEventListener('click', () => {
      mpHostRematch();
    });
  }

  document.getElementById('mp-quit-btn').addEventListener('click', () => {
    mpLeave();
    // Start a fresh single-player puzzle
    newPuzzle(); // game.js global
  });
}

// ─── Initialisation ───────────────────────────────────────────────────────────

function mpInit() {
  // Wire up the Multiplayer button
  const mpBtn = document.getElementById('mp-btn');
  if (mpBtn) {
    mpBtn.addEventListener('click', () => {
      if (mpSession) {
        // Already in a session: show current state
        if (mpSession.status === 'lobby' && mpSession.mode === 'host') {
          mpRenderLobbyHost();
        } else if (mpSession.status === 'lobby' && mpSession.mode === 'guest') {
          mpRenderLobbyGuestWaiting();
        } else if (mpSession.status === 'finished') {
          mpShowWinScreen();
        }
        return;
      }
      // Start host setup flow
      mpRenderSetupForm('host', null);
    });
  }

  // Close modal backdrop click
  const backdrop = document.getElementById('mp-modal-backdrop');
  if (backdrop) {
    backdrop.addEventListener('click', () => {
      // Only dismiss if in setup form (not if joining or in lobby)
      if (!mpSession) mpHideModal();
    });
  }

  window.addEventListener('online', () => {
    if (mpSession && mpSession.mode === 'guest' && mpGuestRecovery.state !== 'connected') {
      mpGuestRecovery.manualOnly = false;
      mpGuestScheduleReconnect(0);
    }
  });
  window.addEventListener('offline', () => {
    if (mpSession && mpSession.mode === 'guest') {
      mpGuestRecovery.state = 'reconnecting';
      mpGuestRecovery.reason = 'You are offline. Waiting for network…';
      mpUpdateInGameUI();
      if (mpSession.status === 'lobby') mpRenderLobbyGuestWaiting();
    }
  });
  document.addEventListener('visibilitychange', () => {
    if (!document.hidden && mpSession && mpSession.mode === 'guest' && mpGuestRecovery.state !== 'connected') {
      mpGuestRecovery.manualOnly = false;
      mpGuestScheduleReconnect(0);
    }
  });

  // Check if URL has ?join= param (guest opening a join link)
  const joinPeerId = mpGetJoinParam();
  if (joinPeerId) {
    mpGuestSetup(joinPeerId);
  }
}

// Run after DOM and game.js are ready
window.addEventListener('load', mpInit);
