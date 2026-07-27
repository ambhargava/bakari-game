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
 * • Reconnection after network interruption is not yet implemented; the
 *   disconnected player's turns are skipped automatically.
 * • WebRTC requires HTTPS (or localhost) in modern browsers; plain HTTP
 *   deployment will not work for multiplayer.
 */

// ─── Constants ────────────────────────────────────────────────────────────────

const MP_PEER_PREFIX = 'bakari-';
const MP_VERSION = 1;

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

// ─── State ────────────────────────────────────────────────────────────────────

/*
 * mpSession is null when not in multiplayer mode; otherwise:
 * {
 *   mode: 'host' | 'guest',
 *   myId: string,            — this client's player ID (= PeerJS peer ID)
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
  return { id, name, color, icon, score: 0, totalMoves: 0, isConnected: true, isHost };
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

  mpSession = {
    mode: 'host',
    myId: peerId,
    myProfile: mpMakePlayer(peerId, profile.name, profile.color, profile.icon, true),
    players: [mpMakePlayer(peerId, profile.name, profile.color, profile.icon, true)],
    status: 'lobby',
    currentTurnIdx: 0,
    revealedBy: {},
    winner: null,
    waitingForMoveConfirm: false,
  };

  mpPeer = new Peer(peerId);

  mpPeer.on('open', (id) => {
    mpSession.myId = id;
    mpSession.myProfile.id = id;
    mpSession.players[0].id = id;
    mpRenderLobbyHost();
  });

  mpPeer.on('connection', mpHostOnConnection);

  mpPeer.on('error', (err) => {
    console.error('[MP] peer error', err);
    if (err.type === 'unavailable-id') {
      // Retry with a new code
      mpPeer.destroy();
      mpHostCreate(profile);
      return;
    }
    mpShowError('Connection error: ' + (err.message || err.type));
  });

  // Show loading state
  mpRenderLobbyLoading();
  document.body.classList.add('mp-active');
}

function mpHostOnConnection(conn) {
  const peerId = conn.peer;
  mpConnections[peerId] = conn;

  conn.on('open', () => {
    // Send current lobby state to the new connection
    mpSend(conn, {
      type: 'welcome',
      myPlayerId: peerId,
      players: mpSession.players,
      status: mpSession.status,
    });
  });

  conn.on('data', (data) => mpHostOnData(peerId, data));

  conn.on('close', () => mpHostOnGuestDisconnected(peerId));
  conn.on('error', () => mpHostOnGuestDisconnected(peerId));
}

function mpHostOnGuestDisconnected(peerId) {
  delete mpConnections[peerId];
  const idx = mpSession.players.findIndex((p) => p.id === peerId);
  if (idx >= 0) {
    mpSession.players[idx].isConnected = false;
  }
  mpBroadcast({ type: 'player_left', playerId: peerId });

  if (mpSession.status === 'playing') {
    // If it was the disconnected player's turn, advance
    const current = mpSession.players[mpSession.currentTurnIdx];
    if (current && current.id === peerId) {
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
}

function mpHostOnData(peerId, data) {
  switch (data.type) {
    case 'join':
      mpHostHandleJoin(peerId, data);
      break;
    case 'move':
      mpHostHandleMove(peerId, data.row, data.col);
      break;
    case 'resync_request':
      mpHostSendResync(peerId);
      break;
    default:
      break;
  }
}

function mpHostHandleJoin(peerId, data) {
  // Reject if game already started
  if (mpSession.status !== 'lobby') {
    const conn = mpConnections[peerId];
    if (conn) {
      mpSend(conn, { type: 'join_rejected', reason: 'Game already in progress' });
    }
    return;
  }

  const player = mpMakePlayer(peerId, data.name, data.color, data.icon, false);

  // Remove placeholder (from welcome) and add proper player entry
  const existing = mpSession.players.findIndex((p) => p.id === peerId);
  if (existing >= 0) {
    mpSession.players[existing] = player;
  } else {
    mpSession.players.push(player);
  }

  // Inform the joining guest about their identity + full player list
  const conn = mpConnections[peerId];
  mpSend(conn, {
    type: 'welcome',
    myPlayerId: peerId,
    players: mpSession.players,
    status: mpSession.status,
  });

  // Inform all other guests that someone joined
  Object.entries(mpConnections).forEach(([pid, c]) => {
    if (pid !== peerId) mpSend(c, { type: 'player_joined', player });
  });

  mpRenderLobbyHost();
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
    seed,
    difficulty,
    turnOrder: mpSession.players.map((p) => p.id),
  });

  mpHideModal();
  mpShowInGameBar();
}

function mpHostHandleMove(playerId, row, col) {
  if (mpSession.status !== 'playing') return;

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

function mpHostSendResync(peerId) {
  const conn = mpConnections[peerId];
  if (!conn) return;

  // Reconstruct minimal state guests need to resync
  const state = {
    players: mpSession.players,
    status: mpSession.status,
    currentTurnIdx: mpSession.currentTurnIdx,
    revealedBy: mpSession.revealedBy,
    revealedFlat: [],
    winnerId: mpSession.winner ? mpSession.winner.id : null,
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
  mpPeer = new Peer();

  mpPeer.on('open', (myPeerId) => {
    mpSession = {
      mode: 'guest',
      myId: myPeerId,
      myProfile: mpMakePlayer(myPeerId, profile.name, profile.color, profile.icon, false),
      players: [],
      status: 'lobby',
      currentTurnIdx: 0,
      revealedBy: {},
      winner: null,
      waitingForMoveConfirm: false,
    };

    mpHostConn = mpPeer.connect(hostPeerId, { reliable: true });

    mpHostConn.on('open', () => {
      // Send join request
      mpSendToHost({
        type: 'join',
        name: profile.name,
        color: profile.color,
        icon: profile.icon,
      });
      mpRenderLobbyGuestWaiting();
    });

    mpHostConn.on('data', (data) => mpGuestOnData(data));
    mpHostConn.on('close', () => mpGuestOnHostDisconnected());
    mpHostConn.on('error', () => mpGuestOnHostDisconnected());
    document.body.classList.add('mp-active');
  });

  mpPeer.on('error', (err) => {
    console.error('[MP] peer error (guest)', err);
    mpShowError('Could not connect. Make sure the QR code is fresh and the host is online.');
  });

  mpRenderLobbyGuestConnecting();
}

function mpGuestOnHostDisconnected() {
  if (!mpSession || mpSession.status === 'finished') return;
  mpShowError('Host disconnected. The match has ended.');
  mpLeave();
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
      if (idx >= 0) mpSession.players[idx].isConnected = false;
      if (mpSession.status === 'playing') mpUpdateInGameUI();
      else mpRenderLobbyGuestWaiting();
      break;
    }
    case 'join_rejected':
      mpShowError(data.reason || 'Joining was rejected by the host.');
      mpLeave();
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
  mpSession.players = data.players;
  mpSession.status = data.status;
  // Find my profile in the player list
  const me = mpSession.players.find((p) => p.id === data.myPlayerId);
  if (me) mpSession.myProfile = me;
  mpRenderLobbyGuestWaiting();
}

function mpGuestApplyGameStart(data) {
  mpSession.status = 'playing';
  mpSession.currentTurnIdx = 0;

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

  foundGoats = state.revealedFlat.filter(({ row, col }) => { // game.js global
    return puzzle.goats[row] === col; // game.js global
  }).length;

  totalMoves = state.revealedFlat.length; // approximate
  if (state.winnerId) {
    mpSession.winner = mpSession.players.find((p) => p.id === state.winnerId) || null;
  }

  renderBoard(); // game.js global
  renderStats(); // game.js global
  mpUpdateInGameUI();
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
  // Close all connections
  if (mpPeer) {
    mpPeer.destroy();
    mpPeer = null;
  }
  Object.keys(mpConnections).forEach((k) => delete mpConnections[k]);
  mpHostConn = null;
  mpSession = null;

  document.body.classList.remove('mp-active');
  mpHideModal();
  mpHideInGameBar();

  // Remove join param from URL without page reload
  const url = new URL(window.location.href);
  url.searchParams.delete('join');
  window.history.replaceState({}, '', url.toString());
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
    const disc = p.isConnected ? '' : ' disconnected';
    return `<span class="mp-player-chip${active ? ' active-turn' : ''}${disc}">
      <span class="mp-player-dot" style="background:${mpEscape(p.color)}"></span>
      ${mpEscape(p.icon)} ${mpEscape(p.name)}
      <span style="margin-left:0.25rem;font-size:0.7rem;color:#888">${p.score} 🐐</span>
    </span>`;
  }).join('');

  mpBarEl.innerHTML = `
    <div class="mp-bar-turn" id="mp-turn-label">${turnLabel}</div>
    <div class="mp-bar-players">${playerChips}</div>
  `;
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
  container.innerHTML = '<p class="mp-qr-fallback">QR code unavailable.<br>Use the link below to join.</p>';
}

function mpRenderLobbyHost() {
  if (!mpSession) return;

  const joinUrl = mpBuildJoinUrl(mpSession.myId);
  const playersHtml = mpSession.players.map((p) => `
    <div class="mp-lobby-player-row">
      <span class="mp-lobby-dot" style="background:${mpEscape(p.color)}"></span>
      <span>${mpEscape(p.icon)}</span>
      <span class="mp-lobby-name">${mpEscape(p.name)}</span>
      ${p.isHost ? '<span class="mp-lobby-badge">Host (you)</span>' : '<span class="mp-lobby-badge">Guest</span>'}
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

  // Generate QR code as a data URL and render into an <img> — more reliable than
  // canvas on mobile Chrome (avoids 0×0 canvas / hidden-element sizing issues).
  const qrContainer = document.getElementById('mp-qr-container');
  if (qrContainer) {
    if (window.QRCode && typeof QRCode.toDataURL === 'function') {
      QRCode.toDataURL(joinUrl, { width: 200, margin: 2 }, (err, dataUrl) => {
        if (!err && dataUrl) {
          const img = document.createElement('img');
          img.src = dataUrl;
          img.alt = 'Scan to join';
          img.className = 'mp-qr-img';
          qrContainer.innerHTML = '';
          qrContainer.appendChild(img);
        } else {
          console.warn('[MP] QR toDataURL error', err);
          mpQrShowFallback(qrContainer);
        }
      });
    } else {
      mpQrShowFallback(qrContainer);
    }
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
    </div>
  `).join('');

  mpModalContentEl.innerHTML = `
    <h2 class="mp-section-title">Multiplayer Lobby</h2>
    <p class="mp-lobby-waiting">Waiting for host to start the game…</p>
    <div class="mp-lobby-players">${playersHtml || '<p class="mp-lobby-waiting">Connecting…</p>'}</div>
    <div class="mp-btn-row">
      <button id="mp-guest-leave-btn" class="mp-btn-secondary">Leave</button>
    </div>
  `;

  mpShowModal();

  document.getElementById('mp-guest-leave-btn').addEventListener('click', () => {
    mpLeave();
  });
}

// ─── UI: profile setup form ───────────────────────────────────────────────────

function mpRenderSetupForm(mode, hostPeerId) {
  // Pick defaults: first unused color/icon
  const defaultColor = MP_COLORS[0];
  const defaultIcon = MP_ICONS[0];

  const colorSwatches = MP_COLORS.map((c, i) => `
    <button type="button" class="mp-color-swatch${i === 0 ? ' selected' : ''}"
      data-color="${c}" style="background:${c}" aria-label="Color ${c}"></button>
  `).join('');

  const iconBtns = MP_ICONS.map((ic, i) => `
    <button type="button" class="mp-icon-btn${i === 0 ? ' selected' : ''}"
      data-icon="${ic}">${ic}</button>
  `).join('');

  const title = mode === 'host' ? 'Create Multiplayer Match' : 'Join Multiplayer Match';
  const actionLabel = mode === 'host' ? 'Create Match' : 'Join';

  mpModalContentEl.innerHTML = `
    <button id="mp-setup-close" class="modal-close" type="button" aria-label="Close">✕</button>
    <h2 class="mp-section-title">${title}</h2>

    <div class="mp-field">
      <label for="mp-name-input">Your name</label>
      <input type="text" id="mp-name-input" maxlength="20" placeholder="Enter your name" />
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
    if (!swatch) return;
    selectedColor = swatch.dataset.color;
    document.querySelectorAll('.mp-color-swatch').forEach((s) => s.classList.remove('selected'));
    swatch.classList.add('selected');
  });

  // Icon picker
  document.getElementById('mp-icon-picker').addEventListener('click', (e) => {
    const btn = e.target.closest('.mp-icon-btn');
    if (!btn) return;
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
    if (mode === 'host') {
      mpHostCreate(profile);
    } else {
      mpGuestConnect(hostPeerId, profile);
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
      <button id="mp-quit-btn" class="mp-btn-secondary">Quit to Single Player</button>
    </div>
  `;

  mpShowModal();

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

  // Check if URL has ?join= param (guest opening a join link)
  const joinPeerId = mpGetJoinParam();
  if (joinPeerId) {
    mpRenderSetupForm('guest', joinPeerId);
  }
}

// Run after DOM and game.js are ready
window.addEventListener('load', mpInit);
