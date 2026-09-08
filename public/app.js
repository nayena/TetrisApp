// UI orchestration: lobby (create/join room), countdown, game loop wiring,
// opponent board mirroring, and game-over/rematch flow.

import { Game, Board, boardFromSnapshot, drawBoard, drawMiniPiece, COLS, ROWS } from "./game.js";
import { Net } from "./net.js";

const $ = (id) => document.getElementById(id);

const screens = {
  lobby: $("lobby"),
  waiting: $("waiting"),
  game: $("game"),
};
function showScreen(name) {
  for (const key of Object.keys(screens)) screens[key].classList.toggle("hidden", key !== name);
}

const myCanvas = $("my-canvas");
const oppCanvas = $("opp-canvas");
const holdCanvas = $("hold-canvas");
const nextCanvas = $("next-canvas");
const myCtx = myCanvas.getContext("2d");
const oppCtx = oppCanvas.getContext("2d");
const holdCtx = holdCanvas.getContext("2d");
const nextCtx = nextCanvas.getContext("2d");

const CELL = myCanvas.width / COLS; // 30px

let net = null;
let game = null;
let nickname = "Player";
let opponentNickname = "Opponent";
let rafId = null;
let lastTs = 0;
let stateInterval = null;
let opponentBoard = new Board();
let gameEnded = false;

// ---------------------------------------------------------------------------
// Lobby
// ---------------------------------------------------------------------------
const roomMatch = location.pathname.match(/^\/room\/([A-Za-z0-9]+)$/);
const invitedRoomId = roomMatch ? roomMatch[1].toUpperCase() : null;

if (invitedRoomId) {
  $("join-code-input").value = invitedRoomId;
  $("create-room-btn").classList.add("hidden");
  document.querySelector(".or").classList.add("hidden");
}

$("create-room-btn").addEventListener("click", async () => {
  setLobbyError("");
  nickname = $("nickname-input").value.trim() || "Player";
  try {
    const res = await fetch("/api/create-room", { method: "POST" });
    if (!res.ok) throw new Error("Failed to create room");
    const { roomId } = await res.json();
    history.pushState({}, "", `/room/${roomId}`);
    await connectToRoom(roomId);
  } catch (err) {
    setLobbyError("Could not create room. Try again.");
  }
});

$("join-room-btn").addEventListener("click", async () => {
  setLobbyError("");
  nickname = $("nickname-input").value.trim() || "Player";
  const code = $("join-code-input").value.trim().toUpperCase();
  if (!code) {
    setLobbyError("Enter a room code.");
    return;
  }
  history.pushState({}, "", `/room/${code}`);
  await connectToRoom(code);
});

function setLobbyError(msg) {
  const el = $("lobby-error");
  el.textContent = msg;
  el.classList.toggle("hidden", !msg);
}

async function connectToRoom(roomId) {
  net = new Net(roomId);
  wireNetHandlers();
  await net.connect();
  net.join(nickname);

  $("room-code-text").textContent = roomId;
  $("room-code-badge").classList.remove("hidden");

  const shareUrl = `${location.origin}/room/${roomId}`;
  $("share-link-input").value = shareUrl;

  showScreen("waiting");
}

$("copy-link-btn").addEventListener("click", copyShareLink);
$("share-copy-btn").addEventListener("click", copyShareLink);
function copyShareLink() {
  const url = $("share-link-input").value || location.href;
  navigator.clipboard?.writeText(url).catch(() => {});
}

// ---------------------------------------------------------------------------
// Networking events
// ---------------------------------------------------------------------------
function wireNetHandlers() {
  net.on("roster", ({ players }) => {
    const opp = players.find((p) => p.playerId !== net.playerId);
    const me = players.find((p) => p.playerId === net.playerId);
    if (me) $("my-name").textContent = me.nickname;
    if (opp) {
      opponentNickname = opp.nickname;
      $("opp-name").textContent = opp.nickname;
    }
  });

  net.on("start_game", ({ seed, countdown }) => {
    $("disconnect-banner").classList.add("hidden");
    startCountdown(seed, countdown);
  });

  net.on("state_update", (payload) => {
    if (payload.board) {
      opponentBoard.grid = boardFromSnapshot(payload.board);
      drawBoard(oppCtx, opponentBoard, CELL, null);
    }
    if (typeof payload.score === "number") $("opp-score").textContent = payload.score;
    if (typeof payload.linesCleared === "number") $("opp-lines").textContent = payload.linesCleared;
  });

  net.on("garbage", ({ lines }) => {
    if (game) game.receiveGarbage(lines);
  });

  net.on("game_over", ({ playerId, winnerId, finalScore }) => {
    endGame(winnerId);
  });

  net.on("rematch_pending", () => {
    $("rematch-status").textContent = "Waiting for opponent to accept rematch…";
  });

  net.on("opponent_left", () => {
    $("disconnect-banner").classList.remove("hidden");
    stopGameLoop();
  });

  net.on("disconnected", () => {
    $("disconnect-banner").textContent = "Connection lost.";
    $("disconnect-banner").classList.remove("hidden");
    stopGameLoop();
  });
}

// ---------------------------------------------------------------------------
// Countdown -> game start
// ---------------------------------------------------------------------------
function startCountdown(seed, seconds) {
  showScreen("game");
  gameEnded = false;
  $("gameover-overlay").classList.add("hidden");
  $("rematch-status").textContent = "";

  const overlay = $("countdown-overlay");
  const numberEl = $("countdown-number");
  overlay.classList.remove("hidden");

  let remaining = seconds;
  numberEl.textContent = String(remaining);
  const timer = setInterval(() => {
    remaining--;
    if (remaining > 0) {
      numberEl.textContent = String(remaining);
    } else {
      clearInterval(timer);
      overlay.classList.add("hidden");
      beginGame(seed);
    }
  }, 1000);
}

function beginGame(seed) {
  resetUiStats();
  opponentBoard = new Board();
  game = new Game(seed, {
    onLinesCleared: ({ garbage }) => {
      if (garbage > 0 && net) net.sendGarbage(garbage);
    },
    onChange: ({ score, linesCleared, level }) => {
      $("my-score").textContent = score;
      $("my-lines").textContent = linesCleared;
      $("my-level").textContent = level;
    },
    onGameOver: ({ finalScore }) => {
      if (net) net.sendGameOver(finalScore);
    },
  });

  attachInput();
  stateInterval = setInterval(() => {
    if (!game) return;
    net?.sendStateUpdate({
      board: game.board.snapshot(),
      score: game.score,
      linesCleared: game.linesCleared,
    });
  }, 150);

  lastTs = performance.now();
  rafId = requestAnimationFrame(loop);
}

function resetUiStats() {
  $("my-score").textContent = "0";
  $("my-lines").textContent = "0";
  $("my-level").textContent = "1";
  $("opp-score").textContent = "0";
  $("opp-lines").textContent = "0";
}

function loop(ts) {
  const dt = ts - lastTs;
  lastTs = ts;
  if (game) {
    game.tick(dt);
    drawBoard(myCtx, game.board, CELL, game.active);
    drawHoldAndNext();
  }
  rafId = requestAnimationFrame(loop);
}

function drawHoldAndNext() {
  holdCtx.clearRect(0, 0, holdCanvas.width, holdCanvas.height);
  drawMiniPiece(holdCtx, game.hold, 0, holdCanvas.height);

  nextCtx.clearRect(0, 0, nextCanvas.width, nextCanvas.height);
  const queue = game.nextQueue;
  const slotH = nextCanvas.height / queue.length;
  queue.forEach((type, i) => drawMiniPiece(nextCtx, type, i, slotH));
}

function stopGameLoop() {
  if (rafId) cancelAnimationFrame(rafId);
  rafId = null;
  if (stateInterval) clearInterval(stateInterval);
  stateInterval = null;
}

function endGame(winnerId) {
  if (gameEnded) return;
  gameEnded = true;
  stopGameLoop();

  const title = $("gameover-title");
  const detail = $("gameover-detail");
  if (winnerId && net && winnerId === net.playerId) {
    title.textContent = "You Win! 🏆";
    detail.textContent = `${opponentNickname} topped out.`;
  } else if (winnerId) {
    title.textContent = "You Lose";
    detail.textContent = `${opponentNickname} wins the match.`;
  } else {
    title.textContent = "Game Over";
    detail.textContent = "";
  }
  $("rematch-status").textContent = "";
  $("gameover-overlay").classList.remove("hidden");
}

$("rematch-btn").addEventListener("click", () => {
  net?.sendRematch();
  $("rematch-status").textContent = "Rematch requested — waiting for opponent…";
});

// ---------------------------------------------------------------------------
// Input
// ---------------------------------------------------------------------------
let inputAttached = false;
function attachInput() {
  if (inputAttached) return;
  inputAttached = true;
  document.addEventListener("keydown", onKeyDown);
  document.addEventListener("keyup", onKeyUp);
}

function onKeyDown(e) {
  if (!game || !game.alive) return;
  switch (e.code) {
    case "ArrowLeft":
      game.move(-1);
      e.preventDefault();
      break;
    case "ArrowRight":
      game.move(1);
      e.preventDefault();
      break;
    case "ArrowDown":
      if (!e.repeat) game.softDropping = true;
      e.preventDefault();
      break;
    case "ArrowUp":
    case "KeyX":
      if (!e.repeat) game.rotate(1);
      e.preventDefault();
      break;
    case "KeyZ":
    case "ControlLeft":
      if (!e.repeat) game.rotate(-1);
      e.preventDefault();
      break;
    case "Space":
      if (!e.repeat) game.hardDrop();
      e.preventDefault();
      break;
    case "KeyC":
    case "ShiftLeft":
      if (!e.repeat) game.holdPiece();
      e.preventDefault();
      break;
  }
}

function onKeyUp(e) {
  if (!game) return;
  if (e.code === "ArrowDown") game.softDropping = false;
}
