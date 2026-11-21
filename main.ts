// A Sokoban solver that answers each level in as few pushes as it can.
//
// The idea: every generated level is a hallway with rooms off it, and a box
// pushed out of its room can never come back, so each room is solved on its
// own. A room holds at most four boxes on a 6 by 6 floor, and a breadth-first
// search over pushes -- a state is the boxes and the player's reachable
// region, a step is one push -- finds the room's push-optimal answer. The
// search prunes two deadlocks no solution can undo (a box on a square from
// which no push reaches a goal, and a frozen 2 by 2 block) and budgets by
// states counted, never by the clock, so two runs answer byte for byte alike.
// When a room's search gives up, a greedy best-first search takes its place;
// when the level is no set of rooms at all, the greedy search runs on the
// whole level. A level left unsolved still gets an (empty) answer file.
//
// Run it on the practice set with:
//   MAKEFUN_INPUT_DIR=practice/input MAKEFUN_OUTPUT_DIR=out node main.ts

import { mkdirSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

const IN_DIR = process.env.MAKEFUN_INPUT_DIR ?? '/input';
const OUT_DIR = process.env.MAKEFUN_OUTPUT_DIR ?? '/output';

/** States one room search may keep before it gives up (work, never time). */
const ROOM_STATES = 300_000;
/** States the whole run may spend on breadth-first search before falling back. */
const RUN_STATES = 4_000_000;
/** States a greedy search may keep. */
const GREEDY_STATES = 150_000;

type Dir = { dx: number; dy: number; step: string; push: string };
const DIRS: Dir[] = [
  { dx: 0, dy: -1, step: 'u', push: 'U' },
  { dx: 0, dy: 1, step: 'd', push: 'D' },
  { dx: -1, dy: 0, step: 'l', push: 'L' },
  { dx: 1, dy: 0, step: 'r', push: 'R' },
];

type Board = {
  w: number;
  h: number;
  size: number;
  wall: Uint8Array;
  goal: Uint8Array;
  goals: number[];
  boxes: number[];
  player: number;
};

/** Work spent so far, shared across the run: the only budget that spans levels. */
type Shared = { spent: number };

/** A level in XSB text: its width and height, walls, goals, boxes and player. */
function parseLevel(text: string): Board {
  const rows = text.split('\n').filter((r) => r.length > 0);
  const h = rows.length;
  const w = Math.max(...rows.map((r) => r.length));
  const size = w * h;
  const wall = new Uint8Array(size).fill(1);
  const goal = new Uint8Array(size);
  const goals: number[] = [];
  const boxes: number[] = [];
  let player = -1;
  rows.forEach((row, y) => {
    for (let x = 0; x < row.length; x++) {
      const ch = row[x];
      const i = y * w + x;
      if (ch === '#') continue;
      wall[i] = 0;
      if (ch === '.' || ch === '*' || ch === '+') {
        goal[i] = 1;
        goals.push(i);
      }
      if (ch === '$' || ch === '*') boxes.push(i);
      if (ch === '@' || ch === '+') player = i;
    }
  });
  // The outermost frame is a wall whatever it shows: nothing leaves the board.
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      if (x === 0 || y === 0 || x === w - 1 || y === h - 1) wall[y * w + x] = 1;
    }
  }
  boxes.sort((a, b) => a - b);
  return { w, h, size, wall, goal, goals, boxes, player };
}

/**
 * The squares from which a box can still be pushed onto some goal: pull back
 * from the goals, one push at a time. A box on any other square is dead.
 */
function liveSquares(b: Board): Uint8Array {
  const live = new Uint8Array(b.size);
  const queue: number[] = [];
  for (const g of b.goals) {
    live[g] = 1;
    queue.push(g);
  }
  for (let qi = 0; qi < queue.length; qi++) {
    const x = queue[qi];
    for (const d of DIRS) {
      const delta = d.dy * b.w + d.dx;
      const y = x - delta;
      if (b.wall[y] || b.wall[y - delta] || live[y]) continue;
      live[y] = 1;
      queue.push(y);
    }
  }
  return live;
}

type Room = { squares: number[]; boxes: number[]; goals: number[] };

/**
 * The level's rooms: cut the dead squares of the player's row (the hallway,
 * where a box reaches no goal) out of the floor, and each part left that holds
 * a box is a room. Null when the level is no set of rooms.
 */
function roomsOf(b: Board, live: Uint8Array): Room[] | null {
  const row = Math.floor(b.player / b.w);
  const cut = new Uint8Array(b.size);
  for (let i = row * b.w; i < (row + 1) * b.w; i++) {
    if (!b.wall[i] && !live[i]) cut[i] = 1;
  }
  if (b.boxes.some((x) => cut[x])) return null;
  const part = new Int32Array(b.size).fill(-1);
  const rooms: Room[] = [];
  for (let s = 0; s < b.size; s++) {
    if (b.wall[s] || cut[s] || part[s] >= 0) continue;
    const squares = [s];
    part[s] = rooms.length;
    for (let i = 0; i < squares.length; i++) {
      const p = squares[i];
      for (const d of DIRS) {
        const q = p + d.dy * b.w + d.dx;
        if (!b.wall[q] && !cut[q] && part[q] < 0) {
          part[q] = rooms.length;
          squares.push(q);
        }
      }
    }
    rooms.push({ squares, boxes: [], goals: [] });
  }
  for (const x of b.boxes) rooms[part[x]].boxes.push(x);
  for (const g of b.goals) {
    if (part[g] < 0) return null;
    rooms[part[g]].goals.push(g);
  }
  if (rooms.some((r) => r.boxes.length !== r.goals.length)) return null;
  return rooms.filter((r) => r.boxes.length > 0);
}

/**
 * The squares the player reaches from `from` with `occ` (a box mask) in the
 * way, marked in `seen` with `stamp`; the lowest square reached names the
 * region, so two states with the same boxes and the same region are one.
 */
function flood(
  b: Board,
  occ: Uint8Array,
  from: number,
  seen: Int32Array,
  stamp: number,
  stack: Int32Array,
): number {
  let low = from;
  let n = 0;
  stack[n++] = from;
  seen[from] = stamp;
  while (n > 0) {
    const p = stack[--n];
    if (p < low) low = p;
    for (const d of DIRS) {
      const q = p + d.dy * b.w + d.dx;
      if (b.wall[q] === 0 && occ[q] === 0 && seen[q] !== stamp) {
        seen[q] = stamp;
        stack[n++] = q;
      }
    }
  }
  return low;
}

/** Whether the box just pushed to `t` sits in a frozen 2 by 2 block. */
function frozenBlock(b: Board, occ: Uint8Array, t: number): boolean {
  const w = b.w;
  for (const a of [t, t - 1, t - w, t - w - 1]) {
    const c1 = a + 1;
    const c2 = a + w;
    const c3 = a + w + 1;
    if (!(b.wall[a] || occ[a]) || !(b.wall[c1] || occ[c1])) continue;
    if (!(b.wall[c2] || occ[c2]) || !(b.wall[c3] || occ[c3])) continue;
    if ((occ[a] && !b.goal[a]) || (occ[c1] && !b.goal[c1])) return true;
    if ((occ[c2] && !b.goal[c2]) || (occ[c3] && !b.goal[c3])) return true;
  }
  return false;
}

/** Whether the box on `t` sits in a corner (two walls at a right angle). */
function cornered(b: Board, t: number): boolean {
  if (b.goal[t]) return false;
  const w = b.w;
  return (
    (b.wall[t - w] === 1 && b.wall[t - 1] === 1) ||
    (b.wall[t - w] === 1 && b.wall[t + 1] === 1) ||
    (b.wall[t + w] === 1 && b.wall[t - 1] === 1) ||
    (b.wall[t + w] === 1 && b.wall[t + 1] === 1)
  );
}

/** A state's key: the region's lowest square and the boxes' squares. */
function stateKey(boxes: number[], low: number, size: number): number | string {
  if (size ** (boxes.length + 1) < Number.MAX_SAFE_INTEGER) {
    let k = low;
    for (const x of boxes) k = k * size + x;
    return k;
  }
  return low + ':' + boxes.join(',');
}

/** Each box's grid distance to its nearest goal, summed: a lower bound on pushes left. */
function manhattanSum(b: Board, boxes: number[]): number {
  let total = 0;
  for (const x of boxes) {
    if (b.goal[x]) continue;
    const bx = x % b.w;
    const by = Math.floor(x / b.w);
    let best = Infinity;
    for (const g of b.goals) {
      const d = Math.abs((g % b.w) - bx) + Math.abs(Math.floor(g / b.w) - by);
      if (d < best) best = d;
    }
    total += best;
  }
  return total;
}

/** A binary heap of [priority, state]: the smaller priority pops first. */
function heapPush(heap: [number, number][], e: [number, number]): void {
  let i = heap.length;
  heap.push(e);
  while (i > 0) {
    const p = (i - 1) >> 1;
    const a = heap[i];
    const c = heap[p];
    if (a[0] > c[0] || (a[0] === c[0] && a[1] >= c[1])) break;
    heap[i] = c;
    heap[p] = a;
    i = p;
  }
}

function heapPop(heap: [number, number][]): [number, number] {
  const top = heap[0];
  const last = heap.pop()!;
  if (heap.length > 0) {
    heap[0] = last;
    for (let i = 0; ; ) {
      let c = 2 * i + 1;
      if (c >= heap.length) break;
      if (c + 1 < heap.length) {
        const l = heap[c];
        const r = heap[c + 1];
        if (r[0] < l[0] || (r[0] === l[0] && r[1] < l[1])) c++;
      }
      const a = heap[c];
      const d = heap[i];
      if (a[0] > d[0] || (a[0] === d[0] && a[1] >= d[1])) break;
      heap[i] = a;
      heap[c] = d;
      i = c;
    }
  }
  return top;
}

type SearchResult = { pushes: number; moves: string } | null;

/**
 * A push search over `b`: breadth-first (push-optimal) or greedy best-first,
 * by `greedy`. A state is the boxes and the player's region; each expansion
 * tries every push the player can reach. Dead squares, corners and frozen
 * 2 by 2 blocks are pruned. At most `cap` states are kept, and the run's
 * shared budget caps breadth-first work across levels.
 */
function searchPush(
  b: Board,
  live: Uint8Array,
  cap: number,
  shared: Shared,
  greedy: boolean,
): SearchResult {
  const size = b.size;
  const occ = new Uint8Array(size);
  const seen = new Int32Array(size);
  const mark = new Int32Array(size);
  const stack = new Int32Array(size);
  let stamp = 0;
  const solved = (boxes: number[]): boolean => boxes.every((x) => b.goal[x]);
  if (b.boxes.some((x) => !live[x])) return null;

  const sBoxes: number[][] = [b.boxes.slice()];
  const sPlayer: number[] = [b.player];
  const sParent: number[] = [-1];
  const sFrom: number[] = [-1];
  const sDir: number[] = [-1];
  const sPushes: number[] = [0];

  const priority = (boxes: number[], pushes: number, seq: number): number => {
    if (!greedy) return pushes * 1_000_000 + seq;
    let off = 0;
    for (const x of boxes) if (!b.goal[x]) off++;
    return off * 10_000_000 + manhattanSum(b, boxes) * 10_000 + pushes;
  };

  const index = new Map<number | string, number>();
  for (const x of b.boxes) occ[x] = 1;
  const low0 = flood(b, occ, b.player, seen, ++stamp, stack);
  for (const x of b.boxes) occ[x] = 0;
  index.set(stateKey(b.boxes, low0, size), 0);
  const heap: [number, number][] = [[priority(b.boxes, 0, 0), 0]];
  if (solved(b.boxes)) return { pushes: 0, moves: '' };

  let found = -1;
  while (heap.length > 0 && found < 0) {
    const [, s] = heapPop(heap);
    const boxes = sBoxes[s];
    const pushes = sPushes[s];
    for (const x of boxes) occ[x] = 1;
    const here = ++stamp;
    flood(b, occ, sPlayer[s], seen, here, stack);
    for (let bi = 0; bi < boxes.length && found < 0; bi++) {
      const from = boxes[bi];
      for (let di = 0; di < 4; di++) {
        const d = DIRS[di];
        const delta = d.dy * b.w + d.dx;
        const to = from + delta;
        const behind = from - delta;
        if (seen[behind] !== here || b.wall[to] || occ[to] || !live[to]) continue;
        occ[from] = 0;
        occ[to] = 1;
        const frozen = frozenBlock(b, occ, to) || cornered(b, to);
        let key: number | string = '';
        let next: number[] | null = null;
        if (!frozen) {
          next = boxes.slice();
          next[bi] = to;
          next.sort((x, y) => x - y);
          key = stateKey(next, flood(b, occ, from, mark, ++stamp, stack), size);
        }
        occ[to] = 0;
        occ[from] = 1;
        if (frozen || index.has(key)) continue;
        if (sBoxes.length >= cap || shared.spent >= RUN_STATES) {
          for (const x of boxes) occ[x] = 0;
          return null;
        }
        shared.spent++;
        index.set(key, sBoxes.length);
        sBoxes.push(next!);
        sPlayer.push(from);
        sParent.push(s);
        sFrom.push(from);
        sDir.push(di);
        sPushes.push(pushes + 1);
        heapPush(heap, [priority(next!, pushes + 1, sBoxes.length - 1), sBoxes.length - 1]);
        if (solved(next!)) {
          found = sBoxes.length - 1;
          break;
        }
      }
    }
    for (const x of boxes) occ[x] = 0;
  }
  if (found < 0) return null;

  // The path of states, then the moves: walk to each push's square, then push.
  const path: number[] = [];
  for (let s = found; s > 0; s = sParent[s]) path.push(s);
  path.reverse();
  let moves = '';
  let player = b.player;
  let boxes = b.boxes;
  for (const s of path) {
    const nextBoxes = sBoxes[s];
    const from = sFrom[s];
    const d = DIRS[sDir[s]];
    const delta = d.dy * b.w + d.dx;
    for (const x of boxes) occ[x] = 1;
    moves += walkTo(b, occ, player, from - delta);
    for (const x of boxes) occ[x] = 0;
    moves += d.push;
    player = from;
    boxes = nextBoxes;
  }
  return { pushes: path.length, moves };
}

/** The shortest walk from `from` to `to` around walls and boxes, in lower LURD letters. */
function walkTo(b: Board, occ: Uint8Array, from: number, to: number): string {
  if (from === to) return '';
  const prev = new Int32Array(b.size).fill(-1);
  const how = new Int8Array(b.size);
  const queue = [from];
  prev[from] = from;
  for (let qi = 0; qi < queue.length; qi++) {
    const p = queue[qi];
    if (p === to) break;
    for (let di = 0; di < 4; di++) {
      const d = DIRS[di];
      const q = p + d.dy * b.w + d.dx;
      if (b.wall[q] || occ[q] || prev[q] !== -1) continue;
      prev[q] = p;
      how[q] = di;
      queue.push(q);
    }
  }
  if (prev[to] === -1) throw new Error('walkTo: the push square is out of reach');
  let out = '';
  for (let p = to; p !== from; p = prev[p]) out = DIRS[how[p]].step + out;
  return out;
}

/** The square the player stands on after `moves` from `from` on a board `w` wide. */
function endOf(w: number, from: number, moves: string): number {
  let p = from;
  for (const ch of moves) {
    const c = ch.toLowerCase();
    p += c === 'u' ? -w : c === 'd' ? w : c === 'l' ? -1 : 1;
  }
  return p;
}

/**
 * The level solved room by room, in the given room order: each room's
 * push-optimal solution in turn, the other rooms' boxes standing as walls (on
 * their goals once their room is done), the player walking on from where the
 * last room left it. Null when a room gives up under both searches.
 */
function solveRooms(
  board: Board,
  live: Uint8Array,
  rooms: Room[],
  order: number[],
  shared: Shared,
): string | null {
  let player = board.player;
  let moves = '';
  const done = new Set<number>();
  for (const ri of order) {
    const room = rooms[ri];
    const wall = board.wall.slice();
    for (let oj = 0; oj < rooms.length; oj++) {
      if (oj === ri) continue;
      const other = rooms[oj];
      for (const s of done.has(oj) ? other.goals : other.boxes) wall[s] = 1;
    }
    const goal = new Uint8Array(board.size);
    for (const g of room.goals) goal[g] = 1;
    const sub: Board = {
      w: board.w,
      h: board.h,
      size: board.size,
      wall,
      goal,
      goals: room.goals.slice().sort((a, b) => a - b),
      boxes: room.boxes.slice().sort((a, b) => a - b),
      player,
    };
    let solved = searchPush(sub, live, ROOM_STATES, shared, false);
    if (solved === null) solved = searchPush(sub, live, GREEDY_STATES, shared, true);
    if (solved === null) return null;
    moves += solved.moves;
    player = endOf(board.w, player, solved.moves);
    done.add(ri);
  }
  return moves;
}

/** One level's moves: room by room when it is a set of rooms, else greedy on the whole level. */
function solveLevel(text: string, shared: Shared): string {
  const board = parseLevel(text);
  const live = liveSquares(board);
  const rooms = roomsOf(board, live);
  if (rooms !== null) {
    const idx = rooms.map((_, i) => i);
    const orders = [idx, idx.slice().reverse()];
    for (const order of orders) {
      const got = solveRooms(board, live, rooms, order, shared);
      if (got !== null) return got;
    }
  }
  const whole = searchPush(board, live, GREEDY_STATES, shared, true);
  return whole === null ? '' : whole.moves;
}

const shared: Shared = { spent: 0 };
for (const id of readdirSync(IN_DIR).sort()) {
  const moves = solveLevel(readFileSync(join(IN_DIR, id, 'level.txt'), 'utf8'), shared);
  mkdirSync(join(OUT_DIR, id), { recursive: true });
  writeFileSync(join(OUT_DIR, id, 'solution.txt'), `${moves}\n`);
}
