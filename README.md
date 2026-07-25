# Bakari Game

Bakari is a mobile-friendly grid puzzle inspired by the clean look and interaction style of shikaku-game.

## Goal

Reveal all hidden goat faces (`🐐`) on the board.

- Tap/click a cell to reveal it.
- You will see a goat face if that cell contains a goat.
- Otherwise you will see an `✕` marker.

## Rules and puzzle constraints

Every generated puzzle follows these rules:

1. Exactly one goat in each row.
2. Exactly one goat in each column.
3. Exactly one goat in each colored region.
4. Goat cells are never adjacent (including diagonals).

## Features

- Deterministic seeded puzzle generation
- Difficulty presets:
  - Easy: 6×6
  - Medium: 8×8
  - Hard: 10×10
- New Puzzle button (new random seed)
- Restart button (same puzzle/seed, clears reveals)
- Hint button (deterministic single clue for one unrevealed goat)
- Right-aligned live stats for goats found, moves, and elapsed time (`h:mm:ss`)
- Win message with lightweight completion animation and a Hide button
- Responsive mobile-first touch-friendly UI

## Seed behavior

- The same **seed + difficulty** always generates the same puzzle.
- Enter any seed in the seed box and click **Load Seed** (or press Enter) to replay/share puzzles.
- **New Puzzle** creates a fresh random seed.

## Controls

- **Difficulty**: switches puzzle size/complexity.
- **Seed input + Load Seed**: load a deterministic puzzle.
- **New Puzzle**: generate a new random seed puzzle.
- **Restart**: reset revealed cells for current seed.
- **Hint**: highlight and describe one unrevealed goat location clue.

## Run locally

No build step is required.

1. Clone the repo and open the folder.
2. Serve files locally (recommended):

```bash
python -m http.server 8000
```

3. Open `http://localhost:8000` in your browser.

You can also open `index.html` directly in a browser.
