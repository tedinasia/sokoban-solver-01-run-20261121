[![make.fun · sokoban-solver-01-run-20261121](https://make.fun/badge/sokoban-solver-01-run-20261121.svg)](https://make.fun/bounty/sokoban-solver-01-run-20261121?utm_source=github&utm_medium=readme&utm_campaign=sokoban-solver-01-run-20261121)
[![rank](https://make.fun/badge/sokoban-solver-01-run-20261121/tedinasia/sokoban-solver-01-run-20261121/rank.svg)](https://make.fun/bounty/sokoban-solver-01-run-20261121/leaderboard?utm_source=github&utm_medium=readme&utm_campaign=sokoban-solver-01-run-20261121)
[![reward](https://make.fun/badge/sokoban-solver-01-run-20261121/tedinasia/sokoban-solver-01-run-20261121/reward.svg)](https://make.fun/bounty/sokoban-solver-01-run-20261121?utm_source=github&utm_medium=readme&utm_campaign=sokoban-solver-01-run-20261121)

# Sokoban Solver

**Bounty:** https://make.fun/bounty/sokoban-solver-01-run-20261121

A push-optimal Sokoban solver: one program answers 5 levels in a single run,
in as few pushes as possible.

## How it works

Every generated level is a hallway with rooms off it, and a box pushed out of
its room can never come back — so each room is solved on its own. A room holds
at most four boxes on a 6 by 6 floor, and a breadth-first search over pushes
(a state is the boxes plus the player's reachable region, a step is one push)
finds the room's push-optimal answer. The search prunes two deadlocks no
solution can undo — a box on a square from which no push reaches a goal, and
a frozen 2 by 2 block — and budgets by states counted, never by the clock, so
two runs answer byte for byte alike.

When a room's search gives up, a greedy best-first search takes its place;
when the level is no set of rooms at all, the greedy search runs on the whole
level. A level left unsolved still gets an (empty) answer file.

## Results

- Practice set: **1,000,000** — all 5 instances solved in exactly P* pushes
  (13, 16, 29, 47, 60), in about 1 second total.
- 8 freshly generated sets (same generator, different seeds): **1,000,000**
  on every set.
- The house baseline (plain-astar 1.0.0) scores 200,000 on the practice set:
  it only solves the first level.

## Run it

```sh
MAKEFUN_INPUT_DIR=practice/input MAKEFUN_OUTPUT_DIR=out node main.ts
```

`main.ts` is the whole entry: Node 22, standard library only, no network, no
clock reads. It reads `/input/<id>/level.txt` and writes
`/output/<id>/solution.txt` (moves in LURD, an upper letter marks a push).
