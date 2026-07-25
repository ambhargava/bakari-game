const DIFFICULTIES = {
  easy: { label: 'Easy', size: 6 },
  medium: { label: 'Medium', size: 8 },
  hard: { label: 'Hard', size: 10 }
};

const GOAT_FACE = '🐐';
const GOAT_FACE_OPTIONS = [
  'assets/goat-face-1.svg',
  'assets/goat-face-2.svg',
  'assets/goat-face-3.svg'
];
const HELP_MODAL_SEEN_KEY = 'bakari_help_modal_seen_v1';

const boardEl = document.getElementById('board');
const winBannerEl = document.getElementById('win-banner');
const seedInputEl = document.getElementById('seed-input');
const loadSeedBtnEl = document.getElementById('load-seed-btn');
const newPuzzleBtnEl = document.getElementById('new-puzzle-btn');
const restartBtnEl = document.getElementById('restart-btn');
const hintBtnEl = document.getElementById('hint-btn');
const difficultyEl = document.getElementById('difficulty');
const howToPlayBtnEl = document.getElementById('how-to-play-btn');
const statsGoatsEl = document.getElementById('stats-goats');
const statsMovesEl = document.getElementById('stats-moves');
const statsTimeEl = document.getElementById('stats-time');
const hideWinBannerBtnEl = document.getElementById('hide-win-banner-btn');
const helpModalEl = document.getElementById('help-modal');
const closeHelpBtnEl = document.getElementById('close-help-btn');

let puzzle = null;
let revealed = [];
let foundGoats = 0;
let totalMoves = 0;
let won = false;
let hintCellKey = null;
let currentGoatFaceAsset = GOAT_FACE_OPTIONS[0];
let elapsedSeconds = 0;
let timerIntervalId = null;

function xmur3(str) {
  let h = 1779033703 ^ str.length;
  for (let i = 0; i < str.length; i += 1) {
    h = Math.imul(h ^ str.charCodeAt(i), 3432918353);
    h = (h << 13) | (h >>> 19);
  }
  return function nextHash() {
    h = Math.imul(h ^ (h >>> 16), 2246822507);
    h = Math.imul(h ^ (h >>> 13), 3266489909);
    return (h ^= h >>> 16) >>> 0;
  };
}

function mulberry32(a) {
  return function rand() {
    let t = (a += 0x6d2b79f5);
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function seededRandom(seed) {
  return mulberry32(xmur3(seed)());
}

function randomSeed() {
  if (window.crypto && crypto.getRandomValues) {
    const arr = new Uint32Array(2);
    crypto.getRandomValues(arr);
    return `${arr[0].toString(16)}-${arr[1].toString(16)}`;
  }
  return `${Date.now().toString(36)}-${Math.floor(Math.random() * 1e8).toString(36)}`;
}

function shuffle(arr, rand) {
  for (let i = arr.length - 1; i > 0; i -= 1) {
    const j = Math.floor(rand() * (i + 1));
    [arr[i], arr[j]] = [arr[j], arr[i]];
  }
  return arr;
}

function buildGoatPermutation(size, rand) {
  const cols = Array.from({ length: size }, (_, index) => index);
  const used = new Set();
  const placement = new Array(size).fill(-1);

  function fillRow(row) {
    if (row === size) {
      return true;
    }

    const candidates = cols.filter((col) => {
      if (used.has(col)) {
        return false;
      }
      if (row === 0) {
        return true;
      }
      return Math.abs(col - placement[row - 1]) > 1;
    });

    shuffle(candidates, rand);

    for (const col of candidates) {
      placement[row] = col;
      used.add(col);
      if (fillRow(row + 1)) {
        return true;
      }
      used.delete(col);
      placement[row] = -1;
    }

    return false;
  }

  if (!fillRow(0)) {
    throw new Error('Failed to place goats');
  }

  return placement;
}

function generateRegions(size, goats, rand) {
  const regionMap = Array.from({ length: size }, () => Array(size).fill(-1));
  const regionCells = Array.from({ length: size }, () => []);

  goats.forEach((col, row) => {
    regionMap[row][col] = row;
    regionCells[row].push([row, col]);
  });

  let unassigned = size * size - size;
  const dirs = [
    [1, 0],
    [-1, 0],
    [0, 1],
    [0, -1]
  ];

  while (unassigned > 0) {
    let progress = false;
    const order = shuffle(Array.from({ length: size }, (_, index) => index), rand);

    for (const regionId of order) {
      const candidates = [];
      const seen = new Set();

      for (const [r, c] of regionCells[regionId]) {
        for (const [dr, dc] of dirs) {
          const nr = r + dr;
          const nc = c + dc;
          if (nr < 0 || nr >= size || nc < 0 || nc >= size) {
            continue;
          }
          if (regionMap[nr][nc] !== -1) {
            continue;
          }
          const key = `${nr}-${nc}`;
          if (seen.has(key)) {
            continue;
          }
          seen.add(key);
          candidates.push([nr, nc]);
        }
      }

      if (candidates.length === 0) {
        continue;
      }

      const [pickR, pickC] = candidates[Math.floor(rand() * candidates.length)];
      regionMap[pickR][pickC] = regionId;
      regionCells[regionId].push([pickR, pickC]);
      unassigned -= 1;
      progress = true;
    }

    if (!progress) {
      throw new Error('Failed to build connected regions');
    }
  }

  return regionMap;
}

function generatePuzzle(seed, difficulty) {
  const size = DIFFICULTIES[difficulty].size;
  const rand = seededRandom(`${difficulty}:${seed}`);

  const goats = buildGoatPermutation(size, rand);
  const regionMap = generateRegions(size, goats, rand);

  return {
    seed,
    difficulty,
    size,
    goats,
    regionMap
  };
}

function regionColor(regionId, total) {
  const hue = Math.round((regionId * 360) / total);
  return `hsl(${hue} 62% 72%)`;
}

function resetState() {
  stopTimer();
  revealed = Array.from({ length: puzzle.size }, () => Array(puzzle.size).fill(false));
  foundGoats = 0;
  totalMoves = 0;
  won = false;
  hintCellKey = null;
  elapsedSeconds = 0;
  boardEl.classList.remove('win');
  winBannerEl.classList.remove('show');
  renderStats();
}

function isGoat(row, col) {
  return puzzle.goats[row] === col;
}

function validateSolvedPuzzle() {
  const size = puzzle.size;
  const rowCounts = Array(size).fill(0);
  const colCounts = Array(size).fill(0);
  const regionCounts = Array(size).fill(0);

  for (let row = 0; row < size; row += 1) {
    const goatCol = puzzle.goats[row];
    rowCounts[row] += 1;
    colCounts[goatCol] += 1;
    regionCounts[puzzle.regionMap[row][goatCol]] += 1;
  }

  if (rowCounts.some((v) => v !== 1)) {
    return false;
  }
  if (colCounts.some((v) => v !== 1)) {
    return false;
  }
  if (regionCounts.some((v) => v !== 1)) {
    return false;
  }

  for (let row = 1; row < size; row += 1) {
    if (Math.abs(puzzle.goats[row] - puzzle.goats[row - 1]) <= 1) {
      return false;
    }
  }

  return true;
}


function formatElapsedTime(totalSeconds) {
  const hours = Math.floor(totalSeconds / 3600);
  const minutes = Math.floor((totalSeconds % 3600) / 60);
  const seconds = totalSeconds % 60;
  return `${hours}:${String(minutes).padStart(2, '0')}:${String(seconds).padStart(2, '0')}`;
}

function renderStats() {
  const goatCount = puzzle ? `${foundGoats}/${puzzle.size}` : '0/0';
  statsGoatsEl.textContent = `Goats: ${goatCount}`;
  statsMovesEl.textContent = `Moves: ${totalMoves}`;
  statsTimeEl.textContent = `Time: ${formatElapsedTime(elapsedSeconds)}`;
}

function stopTimer() {
  if (timerIntervalId !== null) {
    window.clearInterval(timerIntervalId);
    timerIntervalId = null;
  }
}

function startTimer() {
  stopTimer();
  timerIntervalId = window.setInterval(() => {
    if (won) {
      stopTimer();
      return;
    }
    elapsedSeconds += 1;
    renderStats();
  }, 1000);
}

function hintText() {
  for (let row = 0; row < puzzle.size; row += 1) {
    const col = puzzle.goats[row];
    if (!revealed[row][col]) {
      hintCellKey = `${row}-${col}`;
      return `Hint: Row ${row + 1}, Column ${col + 1} hides a goat.`;
    }
  }
  return 'All goats are already revealed.';
}

function onCellClick(row, col) {
  if (won || revealed[row][col]) {
    return;
  }

  revealed[row][col] = true;
  totalMoves += 1;
  hintCellKey = null;

  if (isGoat(row, col)) {
    foundGoats += 1;
  }

  renderStats();
  renderBoard();

  if (foundGoats === puzzle.size && validateSolvedPuzzle()) {
    won = true;
    stopTimer();
    boardEl.classList.add('win');
    winBannerEl.classList.add('show');
  }
}

function createGoatFaceNode() {
  if (!currentGoatFaceAsset) {
    return null;
  }

  const img = document.createElement('img');
  img.src = currentGoatFaceAsset;
  img.alt = 'Goat face';
  img.className = 'goat-face-img';
  img.loading = 'eager';
  img.decoding = 'sync';
  img.onerror = () => {
    img.remove();
  };
  return img;
}

function updateBoardTileSize() {
  const wrapEl = boardEl.parentElement;
  if (!wrapEl) {
    return;
  }

  const boardStyles = getComputedStyle(boardEl);
  const gap = parseFloat(boardStyles.columnGap) || 0;
  const paddingLeft = parseFloat(boardStyles.paddingLeft) || 0;
  const paddingRight = parseFloat(boardStyles.paddingRight) || 0;
  const availableWidth = wrapEl.clientWidth - paddingLeft - paddingRight - gap * (puzzle.size - 1);
  const tileSize = Math.max(1, Math.floor(availableWidth / puzzle.size));

  boardEl.style.setProperty('--cell-size', `${tileSize}px`);
}

function renderBoard() {
  if (!puzzle) {
    return;
  }

  updateBoardTileSize();
  boardEl.style.gridTemplateColumns = `repeat(${puzzle.size}, var(--cell-size))`;
  boardEl.innerHTML = '';

  for (let row = 0; row < puzzle.size; row += 1) {
    for (let col = 0; col < puzzle.size; col += 1) {
      const cell = document.createElement('button');
      const isRevealed = revealed[row][col];
      const goat = isGoat(row, col);
      const key = `${row}-${col}`;

      cell.type = 'button';
      cell.className = 'cell';
      cell.style.background = regionColor(puzzle.regionMap[row][col], puzzle.size);
      cell.setAttribute('role', 'gridcell');
      cell.setAttribute('aria-label', `Row ${row + 1} Column ${col + 1}`);

      if (isRevealed) {
        cell.classList.add('revealed');
        if (goat) {
          const goatFaceNode = createGoatFaceNode();
          if (goatFaceNode) {
            cell.appendChild(goatFaceNode);
          } else {
            cell.textContent = GOAT_FACE;
          }
          cell.classList.add('hit');
          cell.setAttribute('aria-label', `Row ${row + 1} Column ${col + 1}, goat`);
        } else {
          cell.textContent = '✕';
          cell.classList.add('miss');
          cell.setAttribute('aria-label', `Row ${row + 1} Column ${col + 1}, empty`);
        }
      }

      if (!isRevealed && hintCellKey === key) {
        cell.classList.add('hint');
      }

      cell.addEventListener('click', () => onCellClick(row, col));
      boardEl.appendChild(cell);
    }
  }
}

function startPuzzle(seed, difficulty) {
  puzzle = generatePuzzle(seed, difficulty);
  resetState();
  startTimer();
  seedInputEl.value = seed;
  difficultyEl.value = difficulty;
  renderBoard();
}

function restartPuzzle() {
  resetState();
  startTimer();
  renderBoard();
}

function hideWinBanner() {
  winBannerEl.classList.remove('show');
}

function loadSeedPuzzle() {
  const rawSeed = seedInputEl.value.trim();
  const seed = rawSeed || randomSeed();
  startPuzzle(seed, difficultyEl.value);
}

function newPuzzle() {
  startPuzzle(randomSeed(), difficultyEl.value);
}

function openHelpModal() {
  helpModalEl.hidden = false;
  document.body.style.overflow = 'hidden';
}

function closeHelpModal() {
  helpModalEl.hidden = true;
  document.body.style.overflow = '';
}

function maybeShowFirstTimeHelpModal() {
  try {
    if (!localStorage.getItem(HELP_MODAL_SEEN_KEY)) {
      openHelpModal();
      localStorage.setItem(HELP_MODAL_SEEN_KEY, '1');
    }
  } catch {
    openHelpModal();
  }
}

difficultyEl.addEventListener('change', () => {
  startPuzzle(randomSeed(), difficultyEl.value);
});
loadSeedBtnEl.addEventListener('click', loadSeedPuzzle);
newPuzzleBtnEl.addEventListener('click', newPuzzle);
restartBtnEl.addEventListener('click', restartPuzzle);
hintBtnEl.addEventListener('click', () => {
  if (won) {
    return;
  }
  hintText();
  renderBoard();
});
hideWinBannerBtnEl.addEventListener('click', hideWinBanner);
seedInputEl.addEventListener('keydown', (event) => {
  if (event.key === 'Enter') {
    loadSeedPuzzle();
  }
});

howToPlayBtnEl.addEventListener('click', openHelpModal);
closeHelpBtnEl.addEventListener('click', closeHelpModal);
helpModalEl.addEventListener('click', (event) => {
  if (event.target && event.target.hasAttribute('data-close-modal')) {
    closeHelpModal();
  }
});
document.addEventListener('keydown', (event) => {
  if (event.key === 'Escape' && !helpModalEl.hidden) {
    closeHelpModal();
  }
});
window.addEventListener('resize', renderBoard);

startPuzzle(randomSeed(), 'medium');
maybeShowFirstTimeHelpModal();
