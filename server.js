// ══════════════════════════════════════════════════════════
//   LUDO NEXUS — BACKEND SERVER
//   Node.js + Express + Socket.IO
// ══════════════════════════════════════════════════════════

const express = require('express');
const http    = require('http');
const { Server } = require('socket.io');
const path    = require('path');

const app    = express();
const server = http.createServer(app);
const io     = new Server(server, {
  cors: {
    origin: ['https://ludoxadi.vercel.app', 'http://localhost:3000'],
    methods: ['GET', 'POST'],
  },
  transports: ['websocket', 'polling']
});

const PORT = process.env.PORT || 3000;

// ── Serve frontend (optional — for local dev) ─────────────
app.use(express.static(__dirname));

app.get('/', (req, res) => {
  res.sendFile(path.join(__dirname, 'index.html'));
});

// ══════════════════════════════════════════════════════════
//   GAME CONSTANTS
// ══════════════════════════════════════════════════════════

const COLORS = ['red', 'blue', 'green', 'yellow'];

// 52-cell main path (col, row) — same as frontend
const MAIN_PATH = [
  [1,6],[2,6],[3,6],[4,6],[5,6],
  [6,5],[6,4],[6,3],[6,2],[6,1],[6,0],
  [7,0],
  [8,0],[8,1],[8,2],[8,3],[8,4],[8,5],
  [9,6],[10,6],[11,6],[12,6],[13,6],[14,6],
  [14,7],
  [14,8],[13,8],[12,8],[11,8],[10,8],[9,8],
  [8,9],[8,10],[8,11],[8,12],[8,13],[8,14],
  [7,14],
  [6,14],[6,13],[6,12],[6,11],[6,10],[6,9],
  [5,8],[4,8],[3,8],[2,8],[1,8],[0,8],
  [0,7],
  [0,6],
];

// Where each color enters the main path
const COLOR_START_INDEX = { red: 0, blue: 13, green: 26, yellow: 39 };

// Home stretch is 6 steps before reaching center (steps 46-51 relative to color start)
const HOME_ENTRY_OFFSET = 50; // Steps before reaching home entrance

// Safe cell indices on main path
const SAFE_INDICES = new Set([0, 8, 13, 21, 26, 34, 39, 47]);

// ══════════════════════════════════════════════════════════
//   ROOM MANAGEMENT
// ══════════════════════════════════════════════════════════

const rooms      = new Map(); // roomCode → gameState
const socketRoom = new Map(); // socketId → roomCode  (source of truth, never lost)

function generateRoomCode() {
  const chars = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
  let code = '';
  for (let i = 0; i < 6; i++) code += chars[Math.floor(Math.random() * chars.length)];
  return rooms.has(code) ? generateRoomCode() : code;
}

function createGameState(roomCode, maxPlayers) {
  return {
    roomCode,
    maxPlayers,
    players: [],
    currentPlayer: null,
    phase: 'waiting',   // 'waiting' | 'roll' | 'move' | 'animating' | 'ended'
    lastRoll: null,
    rollsThisTurn: 0,
    rolledSix: false,   // clean bonus-turn flag
    winner: null,
  };
}

function createPlayer(socketId, name, color, isHost) {
  return {
    id: socketId,
    name,
    color,
    isHost,
    tokens: [
      { state: 'yard', position: -1, steps: 0, homeStep: 0, canMove: false },
      { state: 'yard', position: -1, steps: 0, homeStep: 0, canMove: false },
      { state: 'yard', position: -1, steps: 0, homeStep: 0, canMove: false },
      { state: 'yard', position: -1, steps: 0, homeStep: 0, canMove: false },
    ],
    finished: false,
    finishOrder: -1,
  };
}

// ══════════════════════════════════════════════════════════
//   LUDO GAME LOGIC
// ══════════════════════════════════════════════════════════

/**
 * Get the absolute main-path index for a token given its steps from start.
 * steps = 0 means at start cell, steps = 51 means just before home entry.
 */
function absoluteIndex(color, steps) {
  return (COLOR_START_INDEX[color] + steps) % 52;
}

/**
 * Check if two tokens are on the same cell.
 */
function sameCell(color1, steps1, color2, steps2) {
  if (steps1 < 0 || steps2 < 0) return false;
  return absoluteIndex(color1, steps1) === absoluteIndex(color2, steps2);
}

/**
 * Determine which tokens can move given the dice roll.
 * Returns modified tokens array with canMove flags set.
 */
function computeMovableTokens(player, diceValue, allPlayers) {
  const tokens = player.tokens.map(t => ({ ...t, canMove: false }));
  let anyMovable = false;

  tokens.forEach((token, i) => {
    if (token.state === 'home') return; // Already finished

    if (token.state === 'yard') {
      // Can only move out on a 6
      if (diceValue === 6) { token.canMove = true; anyMovable = true; }
      return;
    }

    if (token.state === 'onBoard') {
      const newSteps = token.steps + diceValue;
      // Check if it would overshoot home (need exactly 50 or land ≤ 50 to enter home stretch)
      // Home stretch starts at step 51 (relative), home = step 56
      if (newSteps > 56) return; // Can't move, would overshoot
      token.canMove = true; anyMovable = true;
      return;
    }

    if (token.state === 'homeStretch') {
      const newStep = token.homeStep + diceValue;
      if (newStep <= 6) { token.canMove = true; anyMovable = true; }
    }
  });

  // If no tokens can move, mark all as unmovable (turn will be skipped)
  return { tokens, anyMovable };
}

/**
 * Move a token and handle: kills, home stretch entry, winning.
 * Returns { gameState (mutated), event }
 */
function moveToken(gs, playerIndex, tokenIndex) {
  const player = gs.players[playerIndex];
  const token  = player.tokens[tokenIndex];
  const dv     = gs.lastRoll;
  let event    = { type: 'tokenMoved', playerName: player.name, tokenIndex, color: player.color };
  let extraTurn = false;

  if (token.state === 'yard') {
    // Place on start cell
    token.state    = 'onBoard';
    token.steps    = 0;
    token.position = absoluteIndex(player.color, 0);
    extraTurn = dv === 6;
  }

  else if (token.state === 'onBoard') {
    const newSteps = token.steps + dv;

    if (newSteps > 51) {
      // Enter home stretch
      token.state    = 'homeStretch';
      token.homeStep = newSteps - 51; // 1-based in home stretch
      token.steps    = 51;
      token.position = -1;
    } else if (newSteps === 51) {
      // Reached home!
      token.state = 'home';
      token.steps = 51;
      token.position = -1;
      checkWin(gs, player);
      extraTurn = true; // bonus turn for reaching home
    } else {
      token.steps    = newSteps;
      token.position = absoluteIndex(player.color, newSteps);

      // Check kills
      const killed = tryKill(gs, player, token);
      if (killed) {
        event = { ...event, type: 'tokenKilled', killerName: player.name, victimName: killed.name };
        extraTurn = true;
      }
    }
  }

  else if (token.state === 'homeStretch') {
    const newStep = token.homeStep + dv;
    if (newStep === 6) {
      token.state    = 'home';
      token.homeStep = 6;
      checkWin(gs, player);
      extraTurn = true;
    } else {
      token.homeStep = newStep;
    }
  }

  // Clear canMove flags
  player.tokens.forEach(t => t.canMove = false);

  return { extraTurn, event };
}

/**
 * Kill opponent tokens on the same cell as the moved token.
 * Returns the killed player object or null.
 */
function tryKill(gs, mover, movedToken) {
  const moverAbsPos = movedToken.position;
  if (SAFE_INDICES.has(moverAbsPos)) return null; // Safe cell — no kills

  for (const opponent of gs.players) {
    if (opponent.id === mover.id) continue;
    for (const t of opponent.tokens) {
      if (t.state === 'onBoard' && t.position === moverAbsPos) {
        // Send back to yard
        t.state    = 'yard';
        t.steps    = 0;
        t.position = -1;
        return opponent;
      }
    }
  }
  return null;
}

/**
 * Check if a player has all 4 tokens home.
 */
function checkWin(gs, player) {
  const allHome = player.tokens.every(t => t.state === 'home');
  if (allHome && !player.finished) {
    player.finished    = true;
    player.finishOrder = gs.players.filter(p => p.finished).length;

    // Check if only one active player remains
    const active = gs.players.filter(p => !p.finished);
    if (active.length <= 1) {
      gs.phase  = 'ended';
      gs.winner = player;
    }
  }
}

/**
 * Advance to the next player's turn.
 */
function nextTurn(gs) {
  const active = gs.players.filter(p => !p.finished);
  if (active.length === 0) { gs.phase = 'ended'; return; }

  const idx  = active.findIndex(p => p.id === gs.currentPlayer);
  const next = active[(idx + 1) % active.length];
  gs.currentPlayer  = next.id;
  gs.phase          = 'roll';
  gs.lastRoll       = null;
  gs.rollsThisTurn  = 0;
  gs.rolledSix      = false;
}

// ══════════════════════════════════════════════════════════
//   SOCKET.IO EVENT HANDLERS
// ══════════════════════════════════════════════════════════

io.on('connection', (socket) => {
  console.log(`[+] Connected: ${socket.id}`);

  // ── Create Room ────────────────────────────────────────
  socket.on('createRoom', ({ playerName, maxPlayers }) => {
    const code = generateRoomCode();
    const gs   = createGameState(code, maxPlayers || 4);
    const player = createPlayer(socket.id, playerName || 'Player', COLORS[0], true);
    gs.players.push(player);
    rooms.set(code, gs);
    socket.join(code);
    socketRoom.set(socket.id, code);   // ← robust mapping

    console.log(`[ROOM] Created ${code} by ${playerName}`);

    socket.emit('roomCreated', {
      roomCode: code,
      playerId: socket.id,
      gameState: sanitizeState(gs),
    });
  });

  // ── Join Room ──────────────────────────────────────────
  socket.on('joinRoom', ({ playerName, roomCode }) => {
    const code = roomCode.toUpperCase().trim();
    const gs   = rooms.get(code);

    if (!gs)                            { socket.emit('joinError', { message: 'Room not found' }); return; }
    if (gs.phase !== 'waiting')         { socket.emit('joinError', { message: 'Game already started' }); return; }
    if (gs.players.length >= gs.maxPlayers) { socket.emit('joinError', { message: 'Room is full' }); return; }

    const color  = COLORS[gs.players.length];
    const player = createPlayer(socket.id, playerName || 'Player', color, false);
    gs.players.push(player);
    socket.join(code);
    socketRoom.set(socket.id, code);   // ← robust mapping

    console.log(`[ROOM] ${playerName} joined ${code}`);

    socket.emit('joinedRoom', {
      roomCode: code,
      playerId: socket.id,
      gameState: sanitizeState(gs),
    });

    socket.to(code).emit('playerJoined', {
      gameState: sanitizeState(gs),
    });
  });

  // ── Rejoin Room (after socket reconnect) ───────────────
  socket.on('rejoinRoom', ({ roomCode, oldPlayerId }) => {
    const gs = rooms.get(roomCode);
    if (!gs) return;

    const player = gs.players.find(p => p.id === oldPlayerId);
    if (!player) return;

    // Re-map the player's socket ID to the new socket
    socketRoom.delete(oldPlayerId);
    // Keep currentPlayer in sync if this player was the active one
    if (gs.currentPlayer === oldPlayerId) {
      gs.currentPlayer = socket.id;
    }
    player.id = socket.id;
    socketRoom.set(socket.id, roomCode);
    socket.join(roomCode);

    console.log(`[REJOIN] ${player.name} reconnected in room ${roomCode}`);

    // Send fresh state back
    socket.emit('rejoinedRoom', {
      roomCode,
      playerId: socket.id,
      gameState: sanitizeState(gs),
    });

    // Notify others
    socket.to(roomCode).emit('playerJoined', { gameState: sanitizeState(gs) });
  });

  // ── Start Game ─────────────────────────────────────────
  socket.on('startGame', () => {
    const code = socketRoom.get(socket.id);
    const gs   = code && rooms.get(code);
    if (!gs) { socket.emit('error', { message: 'Room not found' }); return; }

    const host = gs.players.find(p => p.id === socket.id);
    if (!host) { socket.emit('error', { message: 'You are not in this room' }); return; }
    if (!host.isHost) { socket.emit('error', { message: 'Only the host can start the game' }); return; }
    if (gs.phase !== 'waiting') { socket.emit('error', { message: 'Game already started' }); return; }
    if (gs.players.length < 2) { socket.emit('error', { message: 'Need at least 2 players to start' }); return; }

    gs.phase         = 'roll';
    gs.currentPlayer = gs.players[0].id;

    console.log(`[GAME] Started in room ${code} with ${gs.players.length} players`);
    io.to(code).emit('gameStarted', { gameState: sanitizeState(gs) });
  });

  // ── Roll Dice ──────────────────────────────────────────
  socket.on('rollDice', () => {
    const code = socketRoom.get(socket.id);
    const gs   = code && rooms.get(code);
    if (!gs) return;
    if (gs.phase !== 'roll') { socket.emit('error', { message: 'Not in roll phase' }); return; }
    if (gs.currentPlayer !== socket.id) { socket.emit('error', { message: 'Not your turn' }); return; }

    const roll = Math.floor(Math.random() * 6) + 1;
    gs.lastRoll      = roll;
    gs.rolledSix     = (roll === 6);   // track bonus turn cleanly
    gs.rollsThisTurn++;

    const playerIndex = gs.players.findIndex(p => p.id === socket.id);
    const player      = gs.players[playerIndex];

    const { tokens, anyMovable } = computeMovableTokens(player, roll, gs.players);
    player.tokens = tokens;

    const rollEvent = { type: 'diceRolled', value: roll, playerName: player.name, color: player.color };

    // ── Case 1: No moves possible ──────────────────────────
    if (!anyMovable) {
      if (roll === 6 && gs.rollsThisTurn < 3) {
        // Stuck but rolled 6 — allow re-roll (up to 3 times)
        gs.phase = 'roll';
        io.to(code).emit('gameUpdate', { gameState: sanitizeState(gs), event: rollEvent });
      } else {
        // Skip turn entirely
        nextTurn(gs);
        io.to(code).emit('gameUpdate', {
          gameState: sanitizeState(gs),
          event: { type: 'turnSkipped', playerName: player.name, color: player.color }
        });
      }
      return;
    }

    const movable = tokens.filter(t => t.canMove);

    // ── Case 2: Exactly one movable token — move immediately (NO setTimeout) ──
    if (movable.length === 1) {
      const autoIdx = tokens.findIndex(t => t.canMove);

      // First broadcast the dice roll so clients can animate the die
      gs.phase = 'animating'; // block further input while clients animate
      io.to(code).emit('gameUpdate', { gameState: sanitizeState(gs), event: rollEvent });

      // After a short delay matching the dice animation (~900ms), apply the move
      setTimeout(() => {
        // Safety check — game might have ended or player left
        const currentGs = rooms.get(code);
        if (!currentGs || currentGs.phase === 'ended') return;

        const { extraTurn, event: moveEvent } = moveToken(currentGs, playerIndex, autoIdx);

        // Decide next phase
        if (currentGs.phase !== 'ended') {
          if (extraTurn || currentGs.rolledSix) {
            // Rolled 6 or reached home → same player rolls again
            currentGs.phase      = 'roll';
            currentGs.lastRoll   = null;
            currentGs.rolledSix  = false;
          } else {
            nextTurn(currentGs);
          }
        }

        if (currentGs.phase === 'ended') {
          io.to(code).emit('gameOver', { winner: currentGs.winner, gameState: sanitizeState(currentGs) });
        } else {
          io.to(code).emit('gameUpdate', { gameState: sanitizeState(currentGs), event: moveEvent });
        }
      }, 950);

      return;
    }

    // ── Case 3: Multiple movable tokens — player must choose ──
    gs.phase = 'move';
    io.to(code).emit('gameUpdate', { gameState: sanitizeState(gs), event: rollEvent });
  });

  // ── Move Token ─────────────────────────────────────────
  socket.on('moveToken', ({ tokenIndex }) => {
    const code = socketRoom.get(socket.id);
    const gs   = code && rooms.get(code);
    if (!gs) return;
    if (gs.phase !== 'move')            { socket.emit('error', { message: 'Not in move phase' }); return; }
    if (gs.currentPlayer !== socket.id) { socket.emit('error', { message: 'Not your turn' }); return; }

    const playerIndex = gs.players.findIndex(p => p.id === socket.id);
    const player      = gs.players[playerIndex];

    if (tokenIndex < 0 || tokenIndex >= player.tokens.length) return;
    if (!player.tokens[tokenIndex].canMove) {
      socket.emit('error', { message: 'That token cannot move' }); return;
    }

    const { extraTurn, event } = moveToken(gs, playerIndex, tokenIndex);

    // Bonus turn if: rolled a 6 OR token reached home (extraTurn)
    const bonusTurn = gs.rolledSix || extraTurn;

    if (gs.phase !== 'ended') {
      if (bonusTurn) {
        // Same player rolls again
        gs.phase     = 'roll';
        gs.lastRoll  = null;
        gs.rolledSix = false;
      } else {
        nextTurn(gs);
      }
    }

    if (gs.phase === 'ended') {
      io.to(code).emit('gameOver', { winner: gs.winner, gameState: sanitizeState(gs) });
    } else {
      io.to(code).emit('gameUpdate', { gameState: sanitizeState(gs), event });
    }
  });

  // ── Leave Room ─────────────────────────────────────────
  socket.on('leaveRoom', () => handleDisconnect(socket));
  socket.on('disconnect', () => handleDisconnect(socket));
});

function handleDisconnect(socket) {
  const code = socketRoom.get(socket.id);
  const gs   = code && rooms.get(code);
  socketRoom.delete(socket.id);   // always clean up
  if (!gs) return;

  const playerIndex = gs.players.findIndex(p => p.id === socket.id);
  if (playerIndex === -1) return;

  const player = gs.players[playerIndex];
  gs.players.splice(playerIndex, 1);
  socket.leave(code);

  console.log(`[-] ${player.name} left room ${code}`);

  if (gs.players.length === 0) {
    rooms.delete(code);
    console.log(`[ROOM] Deleted empty room ${code}`);
    return;
  }

  // Assign new host if needed
  if (player.isHost && gs.players.length > 0) {
    gs.players[0].isHost = true;
  }

  // If game was running and this was current player, advance turn
  if (gs.phase === 'roll' || gs.phase === 'move') {
    if (gs.currentPlayer === socket.id) {
      nextTurn(gs);
    }
  }

  io.to(code).emit('playerLeft', {
    gameState: sanitizeState(gs),
    playerName: player.name,
  });

  // If only 1 player left during game, end it
  if (gs.phase !== 'waiting' && gs.players.length < 2) {
    const remaining = gs.players[0];
    gs.phase  = 'ended';
    gs.winner = remaining;
    io.to(code).emit('gameOver', {
      winner: remaining,
      gameState: sanitizeState(gs),
    });
  }
}

/**
 * Strip internal state not needed by client (prevents cheating).
 */
function sanitizeState(gs) {
  return {
    roomCode:      gs.roomCode,
    maxPlayers:    gs.maxPlayers,
    phase:         gs.phase,
    currentPlayer: gs.currentPlayer,
    lastRoll:      gs.lastRoll,
    winner:        gs.winner ? { id: gs.winner.id, name: gs.winner.name, color: gs.winner.color } : null,
    players: gs.players.map(p => ({
      id:          p.id,
      name:        p.name,
      color:       p.color,
      isHost:      p.isHost,
      finished:    p.finished,
      finishOrder: p.finishOrder,
      tokens:      p.tokens.map(t => ({
        state:    t.state,
        position: t.position,
        steps:    t.steps || 0,
        homeStep: t.homeStep || 0,
        canMove:  t.canMove || false,
      })),
    })),
  };
}

// ── Start Server ─────────────────────────────────────────
server.listen(PORT, () => {
  console.log(`\n🎲 LUDO NEXUS Server running on http://localhost:${PORT}\n`);
});
