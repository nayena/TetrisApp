// Tetris engine: board, pieces, seeded 7-bag randomizer, SRS rotation +
// wall kicks, gravity/lock, scoring, and garbage. Runs entirely client-side;
// net.js sends compact snapshots of the results to the opponent.

export const COLS = 10;
export const ROWS = 20;

// ---------------------------------------------------------------------------
// Seeded RNG (mulberry32) + 7-bag piece randomizer.
// Both players derive their piece sequence from the same server-issued seed,
// so both boards see the identical stream of pieces.
// ---------------------------------------------------------------------------
function mulberry32(seed) {
  let a = seed >>> 0;
  return function () {
    a |= 0;
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const PIECE_TYPES = ["I", "O", "T", "S", "Z", "J", "L"];

export class SevenBag {
  constructor(seed) {
    this.rand = mulberry32(seed);
    this.queue = [];
  }
  _refill() {
    const bag = [...PIECE_TYPES];
    for (let i = bag.length - 1; i > 0; i--) {
      const j = Math.floor(this.rand() * (i + 1));
      [bag[i], bag[j]] = [bag[j], bag[i]];
    }
    this.queue.push(...bag);
  }
  next() {
    if (this.queue.length === 0) this._refill();
    return this.queue.shift();
  }
  peek(n) {
    while (this.queue.length < n) this._refill();
    return this.queue.slice(0, n);
  }
}

// ---------------------------------------------------------------------------
// Piece shapes (spawn orientation) and colors.
// ---------------------------------------------------------------------------
const BASE_SHAPES = {
  I: [
    [0, 0, 0, 0],
    [1, 1, 1, 1],
    [0, 0, 0, 0],
    [0, 0, 0, 0],
  ],
  O: [
    [1, 1],
    [1, 1],
  ],
  T: [
    [0, 1, 0],
    [1, 1, 1],
    [0, 0, 0],
  ],
  S: [
    [0, 1, 1],
    [1, 1, 0],
    [0, 0, 0],
  ],
  Z: [
    [1, 1, 0],
    [0, 1, 1],
    [0, 0, 0],
  ],
  J: [
    [1, 0, 0],
    [1, 1, 1],
    [0, 0, 0],
  ],
  L: [
    [0, 0, 1],
    [1, 1, 1],
    [0, 0, 0],
  ],
};

export const COLORS = {
  I: "#4dd8e6",
  O: "#e6d84d",
  T: "#b24de6",
  S: "#4de664",
  Z: "#e64d4d",
  J: "#4d6fe6",
  L: "#e6924d",
  G: "#5a5a5a", // garbage
};

function rotateCW(m) {
  const n = m.length;
  const out = Array.from({ length: n }, () => new Array(n).fill(0));
  for (let r = 0; r < n; r++) {
    for (let c = 0; c < n; c++) out[c][n - 1 - r] = m[r][c];
  }
  return out;
}

// Precompute the 4 rotation states (0, R, 2, L) for every piece.
const ROTATIONS = {};
for (const type of PIECE_TYPES) {
  const states = [BASE_SHAPES[type]];
  for (let i = 1; i < 4; i++) states.push(rotateCW(states[i - 1]));
  ROTATIONS[type] = states;
}

const JLSTZ_KICKS = {
  "0>1": [[0, 0], [-1, 0], [-1, 1], [0, -2], [-1, -2]],
  "1>0": [[0, 0], [1, 0], [1, -1], [0, 2], [1, 2]],
  "1>2": [[0, 0], [1, 0], [1, -1], [0, 2], [1, 2]],
  "2>1": [[0, 0], [-1, 0], [-1, 1], [0, -2], [-1, -2]],
  "2>3": [[0, 0], [1, 0], [1, 1], [0, -2], [1, -2]],
  "3>2": [[0, 0], [-1, 0], [-1, -1], [0, 2], [-1, 2]],
  "3>0": [[0, 0], [-1, 0], [-1, -1], [0, 2], [-1, 2]],
  "0>3": [[0, 0], [1, 0], [1, 1], [0, -2], [1, -2]],
};
const I_KICKS = {
  "0>1": [[0, 0], [-2, 0], [1, 0], [-2, -1], [1, 2]],
  "1>0": [[0, 0], [2, 0], [-1, 0], [2, 1], [-1, -2]],
  "1>2": [[0, 0], [-1, 0], [2, 0], [-1, 2], [2, -1]],
  "2>1": [[0, 0], [1, 0], [-2, 0], [1, -2], [-2, 1]],
  "2>3": [[0, 0], [2, 0], [-1, 0], [2, 1], [-1, -2]],
  "3>2": [[0, 0], [-2, 0], [1, 0], [-2, -1], [1, 2]],
  "3>0": [[0, 0], [1, 0], [-2, 0], [1, -2], [-2, 1]],
  "0>3": [[0, 0], [-1, 0], [2, 0], [-1, 2], [2, -1]],
};

function cellsOf(type, rotState) {
  const grid = ROTATIONS[type][rotState];
  const cells = [];
  for (let r = 0; r < grid.length; r++) {
    for (let c = 0; c < grid[r].length; c++) {
      if (grid[r][c]) cells.push([c, r]);
    }
  }
  return cells;
}

// ---------------------------------------------------------------------------
// Board
// ---------------------------------------------------------------------------
export class Board {
  constructor() {
    this.grid = Array.from({ length: ROWS }, () => new Array(COLS).fill(0));
  }

  collides(cells, offX, offY) {
    for (const [cx, cy] of cells) {
      const x = cx + offX;
      const y = cy + offY;
      if (x < 0 || x >= COLS || y >= ROWS) return true;
      if (y < 0) continue;
      if (this.grid[y][x]) return true;
    }
    return false;
  }

  lock(cells, offX, offY, type) {
    for (const [cx, cy] of cells) {
      const x = cx + offX;
      const y = cy + offY;
      if (y >= 0 && y < ROWS && x >= 0 && x < COLS) this.grid[y][x] = type;
    }
  }

  clearLines() {
    let cleared = 0;
    for (let r = ROWS - 1; r >= 0; r--) {
      if (this.grid[r].every((cell) => cell !== 0)) {
        this.grid.splice(r, 1);
        this.grid.unshift(new Array(COLS).fill(0));
        cleared++;
        r++; // recheck same index after shift
      }
    }
    return cleared;
  }

  addGarbage(numLines) {
    if (numLines <= 0) return;
    const gapCol = Math.floor(Math.random() * COLS);
    for (let i = 0; i < numLines; i++) {
      this.grid.shift();
      const row = new Array(COLS).fill("G");
      row[gapCol] = 0;
      this.grid.push(row);
    }
  }

  isToppedOut() {
    return this.grid[0].some((c) => c !== 0) || this.grid[1].some((c) => c !== 0);
  }

  snapshot() {
    // Compact numeric snapshot for the wire: 0 = empty, else piece-type index.
    const idx = { 0: 0, I: 1, O: 2, T: 3, S: 4, Z: 5, J: 6, L: 7, G: 8 };
    return this.grid.map((row) => row.map((c) => idx[c] ?? 0));
  }
}

const SNAPSHOT_TYPES = [0, "I", "O", "T", "S", "Z", "J", "L", "G"];
export function boardFromSnapshot(snapshot) {
  return snapshot.map((row) => row.map((v) => SNAPSHOT_TYPES[v] ?? 0));
}

// ---------------------------------------------------------------------------
// Game: one player's active simulation (piece falling, input, scoring).
// ---------------------------------------------------------------------------
const SPAWN_COL = { I: 3, O: 4, T: 3, S: 3, Z: 3, J: 3, L: 3 };

export class Game {
  constructor(seed, opts = {}) {
    this.board = new Board();
    this.bag = new SevenBag(seed);
    this.hold = null;
    this.canHold = true;
    this.score = 0;
    this.linesCleared = 0;
    this.level = 1;
    this.alive = true;
    this.softDropping = false;
    this.dropTimer = 0;
    this.lockTimer = 0;
    this.locking = false;

    this.onLinesCleared = opts.onLinesCleared || (() => {});
    this.onChange = opts.onChange || (() => {});
    this.onGameOver = opts.onGameOver || (() => {});
    this.onPieceLocked = opts.onPieceLocked || (() => {});

    this._spawnPiece();
  }

  _spawnPiece(type) {
    const pieceType = type || this.bag.next();
    this.active = { type: pieceType, rot: 0, x: SPAWN_COL[pieceType], y: -1 };
    this.canHold = true;
    this.locking = false;
    this.lockTimer = 0;
    this.dropTimer = 0;

    if (this.board.collides(this._cells(), this.active.x, this.active.y)) {
      this._gameOver();
    }
  }

  _gameOver() {
    if (!this.alive) return;
    this.alive = false;
    this.onGameOver({ finalScore: this.score });
  }

  get nextQueue() {
    return this.bag.peek(5);
  }

  _cells() {
    return cellsOf(this.active.type, this.active.rot);
  }

  move(dx) {
    if (!this.alive) return;
    const cells = this._cells();
    if (!this.board.collides(cells, this.active.x + dx, this.active.y)) {
      this.active.x += dx;
      this._refreshLockTimer();
    }
  }

  rotate(dir) {
    if (!this.alive) return;
    const type = this.active.type;
    if (type === "O") return;
    const from = this.active.rot;
    const to = (from + dir + 4) % 4;
    const cells = cellsOf(type, to);
    const table = type === "I" ? I_KICKS : JLSTZ_KICKS;
    const key = `${from}>${to}`;
    const kicks = table[key] || [[0, 0]];
    for (const [dx, dy] of kicks) {
      const nx = this.active.x + dx;
      const ny = this.active.y - dy; // SRS y-up -> board row-down
      if (!this.board.collides(cells, nx, ny)) {
        this.active.rot = to;
        this.active.x = nx;
        this.active.y = ny;
        this._refreshLockTimer();
        return;
      }
    }
  }

  softDrop() {
    if (!this.alive) return false;
    const cells = this._cells();
    if (!this.board.collides(cells, this.active.x, this.active.y + 1)) {
      this.active.y += 1;
      this.score += 1;
      this._refreshLockTimer();
      return true;
    }
    return false;
  }

  hardDrop() {
    if (!this.alive) return;
    // softDrop() already awards 1 point/cell; add 1 more per cell so a hard
    // drop is worth the conventional 2 points/cell.
    while (this.softDrop()) this.score += 1;
    this._lockPiece();
  }

  holdPiece() {
    if (!this.alive || !this.canHold) return;
    const current = this.active.type;
    if (this.hold) {
      const swap = this.hold;
      this.hold = current;
      this._spawnPiece(swap);
    } else {
      this.hold = current;
      this._spawnPiece();
    }
    this.canHold = false;
  }

  _refreshLockTimer() {
    const cells = this._cells();
    const onGround = this.board.collides(cells, this.active.x, this.active.y + 1);
    if (onGround) {
      this.locking = true;
      this.lockTimer = 0;
    } else {
      this.locking = false;
    }
  }

  _lockPiece() {
    const cells = this._cells();
    this.board.lock(cells, this.active.x, this.active.y, this.active.type);

    if (this.board.isToppedOut()) {
      this._gameOver();
      return;
    }

    const cleared = this.board.clearLines();
    if (cleared > 0) {
      this.linesCleared += cleared;
      const points = [0, 100, 300, 500, 800][cleared] || 800;
      this.score += points * this.level;
      this.level = 1 + Math.floor(this.linesCleared / 10);

      const garbageMap = { 2: 1, 3: 2, 4: 4 };
      const garbage = garbageMap[cleared] || 0;
      this.onLinesCleared({ cleared, garbage });
    }

    this.onPieceLocked();
    this.onChange({ score: this.score, linesCleared: this.linesCleared, level: this.level });
    this._spawnPiece();
  }

  receiveGarbage(numLines) {
    this.board.addGarbage(numLines);
  }

  gravityIntervalMs() {
    return Math.max(100, 1000 - (this.level - 1) * 75);
  }

  /** Advance simulation by dt milliseconds. Call every animation frame. */
  tick(dt) {
    if (!this.alive) return;
    const interval = this.softDropping ? Math.min(50, this.gravityIntervalMs()) : this.gravityIntervalMs();
    this.dropTimer += dt;

    const cells = this._cells();
    const onGround = this.board.collides(cells, this.active.x, this.active.y + 1);

    if (onGround) {
      this.locking = true;
      this.lockTimer += dt;
      if (this.lockTimer >= 500) {
        this._lockPiece();
        this.dropTimer = 0;
      }
    } else {
      this.locking = false;
      if (this.dropTimer >= interval) {
        this.dropTimer = 0;
        this.active.y += 1;
      }
    }
  }

  ghostY() {
    const cells = this._cells();
    let y = this.active.y;
    while (!this.board.collides(cells, this.active.x, y + 1)) y++;
    return y;
  }
}

// ---------------------------------------------------------------------------
// Rendering
// ---------------------------------------------------------------------------
export function drawBoard(ctx, board, cellSize, activePiece) {
  const { width, height } = ctx.canvas;
  ctx.fillStyle = "#111318";
  ctx.fillRect(0, 0, width, height);

  for (let r = 0; r < ROWS; r++) {
    for (let c = 0; c < COLS; c++) {
      const cell = board.grid[r][c];
      if (cell) drawCell(ctx, c, r, cellSize, COLORS[cell] || "#888");
      else drawGrid(ctx, c, r, cellSize);
    }
  }

  if (activePiece) {
    const { type, rot, x, y } = activePiece;
    const cells = cellsOf(type, rot);

    // ghost
    let gy = y;
    while (!board.collides(cells, x, gy + 1)) gy++;
    for (const [cx, cy] of cells) {
      drawCell(ctx, x + cx, gy + cy, cellSize, COLORS[type], true);
    }
    // active
    for (const [cx, cy] of cells) {
      drawCell(ctx, x + cx, y + cy, cellSize, COLORS[type]);
    }
  }
}

function drawGrid(ctx, c, r, size) {
  ctx.strokeStyle = "rgba(255,255,255,0.04)";
  ctx.strokeRect(c * size, r * size, size, size);
}

function drawCell(ctx, c, r, size, color, ghost = false) {
  if (r < 0) return;
  const x = c * size;
  const y = r * size;
  if (ghost) {
    ctx.strokeStyle = color;
    ctx.lineWidth = 2;
    ctx.strokeRect(x + 2, y + 2, size - 4, size - 4);
    return;
  }
  ctx.fillStyle = color;
  ctx.fillRect(x, y, size, size);
  ctx.strokeStyle = "rgba(0,0,0,0.35)";
  ctx.strokeRect(x + 0.5, y + 0.5, size - 1, size - 1);
}

/** Draw one small piece glyph inside ctx at vertical slot `slot` (0-based). */
export function drawMiniPiece(ctx, type, slot = 0, slotHeight = 56) {
  if (!type) return;
  const size = 16;
  const grid = ROTATIONS[type][0];
  const offX = type === "I" || type === "O" ? 0.5 : 1;
  const offY = slot * slotHeight + slotHeight / 2 - size * 1.2;
  for (let r = 0; r < grid.length; r++) {
    for (let c = 0; c < grid[r].length; c++) {
      if (grid[r][c]) {
        ctx.fillStyle = COLORS[type];
        ctx.fillRect((c + offX) * size, offY + r * size, size - 1, size - 1);
      }
    }
  }
}
