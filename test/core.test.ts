import { expect, it, describe } from 'vitest';
import { BTree, type RebalanceEvent } from '../src/index.js';

/** reference-model assertion: full structural validation + Map equivalence */
function check<V>(tree: BTree<V, number>, ref: Map<number, V>): void {
  // 1. internal invariants: sort order, occupancy, parent/child refs,
  //    tight separators, leaf chain both ways, reachable page == live set
  tree.validate();

  // 2. size and point lookups
  expect(tree.size).toBe(ref.size);
  for (const [k, v] of ref) expect(tree.get(k)).toBe(v);

  // 3. global key sequence comes back sorted along the leaf chain
  const keys = tree.keys();
  const sorted = [...ref.keys()].sort((a, b) => a - b);
  expect(keys).toEqual(sorted);
  expect(tree.values().length).toBe(sorted.length);

  // 4. allocator bookkeeping: live pages + free list == ids ever minted
  const s = tree.stats();
  expect(s.livePages + s.freePages).toBe(s.allocated);
}

const numCompare = (a: number, b: number) => a - b;

function seed(order: number, keys: number[]): BTree<number, number> {
  const t = new BTree<number, number>({ order, compare: numCompare });
  for (const k of keys) t.insert(k, k);
  t.validate();
  return t;
}

/** every structural event seen since `from` */
function types(events: RebalanceEvent[], from = 0): string[] {
  return events.slice(from).map((e) => e.type);
}

describe('basic ordered storage', () => {
  it('keeps the original ordered behaviour', () => {
    const x = new BTree<number>();
    x.insert('b', 2);
    x.insert('a', 1);
    expect(x.range('a', 'z').map((v) => v.key)).toEqual(['a', 'b']);
    x.validate();
  });

  it('splits leaves and internals and routes lookups correctly', () => {
    const t = seed(4, [1, 2, 3, 4, 5, 6, 7, 8, 9, 10]);
    for (let k = 1; k <= 10; k++) expect(t.get(k)).toBe(k);
    expect(t.get(11)).toBeUndefined();
    expect(t.range(3, 7).map((p) => p.key)).toEqual([3, 4, 5, 6, 7]);
  });
});

describe('duplicate keys', () => {
  it('replace values without growing the tree', () => {
    const t = seed(3, [1, 2, 3, 4, 5, 6]);
    const pagesBefore = t.stats().livePages;
    const sizeBefore = t.size;
    t.insert(1, 100);
    t.insert(4, 400);
    t.insert(6, 600);
    expect(t.size).toBe(sizeBefore);
    expect(t.stats().livePages).toBe(pagesBefore);
    expect(t.get(1)).toBe(100);
    expect(t.get(4)).toBe(400);
    expect(t.get(6)).toBe(600);
    check(t, new Map([1, 2, 3, 4, 5, 6].map((k) => [k, k === 1 ? 100 : k === 4 ? 400 : k === 6 ? 600 : k])));
  });
});

describe('deleting missing keys', () => {
  it('is a no-op that returns false and touches no page', () => {
    const t = seed(4, [1, 2, 3, 4, 5, 6, 7, 8]);
    const eventsBefore = t.events.length;
    const statsBefore = t.stats();
    expect(t.delete(999)).toBe(false);
    expect(t.delete(0)).toBe(false);
    expect(t.events.length).toBe(eventsBefore);
    expect(t.stats()).toEqual(statsBefore);
    check(t, new Map([1, 2, 3, 4, 5, 6, 7, 8].map((k) => [k, k])));
  });

  it('on an empty tree does nothing', () => {
    const t = new BTree<number, number>({ compare: numCompare });
    expect(t.delete(1)).toBe(false);
    expect(t.size).toBe(0);
    t.validate();
    expect(t.stats().livePages).toBe(1);
  });
});

describe('borrowing from siblings (order 4, leaves [1,2,3][4,5,6][7,8,9,10])', () => {
  const KEYS = [1, 2, 3, 4, 5, 6, 7, 8, 9, 10];

  it('borrows from the RIGHT sibling and updates the parent separator', () => {
    const t = seed(4, KEYS);
    const from = t.events.length;
    t.delete(1); // 3 -> 2 entries: still at minimum, nothing happens yet
    t.validate();
    expect(t.events.length).toBe(from);
    t.delete(2); // 2 -> 1 entry: underflow, right sibling is rich
    t.validate();
    expect(types(t.events, from)).toContain('borrow-right');
    // separator was rewritten: 4 moved left, 5 now routes to the next leaf
    expect(t.get(3)).toBe(3);
    expect(t.get(4)).toBe(4);
    expect(t.get(5)).toBe(5);
    check(t, new Map([3, 4, 5, 6, 7, 8, 9, 10].map((k) => [k, k])));
  });

  it('borrows from the LEFT sibling and updates the parent separator', () => {
    const t = seed(4, KEYS);
    const from = t.events.length;
    t.delete(10); // 4 -> 3 entries: still at/above minimum
    t.delete(9); // 3 -> 2 entries: at minimum
    t.validate();
    expect(t.events.length).toBe(from);
    t.delete(8); // 2 -> 1 entry: underflow, left sibling is rich
    t.validate();
    expect(types(t.events, from)).toContain('borrow-left');
    // separator was rewritten: 6 moved right, routes must still land correctly
    expect(t.get(6)).toBe(6);
    expect(t.get(7)).toBe(7);
    check(t, new Map([1, 2, 3, 4, 5, 6, 7].map((k) => [k, k])));
  });

  it('does not borrow when a sibling is already at minimum (merges instead)', () => {
    const t = seed(3, [1, 2, 3, 4]); // exactly two minimum leaves
    const from = t.events.length;
    t.delete(1);
    t.delete(2);
    const seen = types(t.events, from);
    expect(seen.some((x) => x.startsWith('borrow'))).toBe(false);
    expect(seen).toContain('merge-right'); // first leaf absorbs the right one
    expect(t.depth()).toBe(1); // internal root collapsed back to a leaf
    check(t, new Map([[3, 3], [4, 4]]));
  });
});

describe('leaf merges in both directions', () => {
  it('merges LEFT (underflow node absorbs left sibling) and frees the page', () => {
    const t = seed(3, [1, 2, 3, 4, 5, 6]);
    const from = t.events.length;
    t.delete(5);
    t.delete(6); // last leaf empties out, left sibling sits at minimum
    const ev = t.events.slice(from);
    expect(ev.some((e) => e.type === 'merge-left')).toBe(true);
    check(t, new Map([1, 2, 3, 4].map((k) => [k, k])));
  });

  it('merges RIGHT (first leaf absorbs its right sibling) and rewrites the chain', () => {
    const t = seed(3, [1, 2, 3, 4, 5, 6]);
    const from = t.events.length;
    t.delete(1);
    t.delete(2);
    const ev = t.events.slice(from);
    expect(ev.some((e) => e.type === 'merge-right')).toBe(true);
    check(t, new Map([3, 4, 5, 6].map((k) => [k, k])));
    // range scan walks the repaired leaf chain end to end
    expect(t.range(-100, 100).map((p) => p.key)).toEqual([3, 4, 5, 6]);
  });
});

describe('continuous multi-level merges and root collapse', () => {
  const drainOrders: ((n: number) => number[])[] = [
    (n) => Array.from({ length: n }, (_, i) => i), // ascending
    (n) => Array.from({ length: n }, (_, i) => n - 1 - i), // descending
    (n) => {
      // outside-in: remove smallest remaining, then largest remaining
      const a = Array.from({ length: n }, (_, i) => i);
      const out: number[] = [];
      while (a.length) {
        out.push(a.shift()!);
        if (a.length) out.push(a.pop()!);
      }
      return out;
    },
    (n) => {
      // pseudo-random deterministic shuffle
      const a = Array.from({ length: n }, (_, i) => i);
      let s = 1234;
      const rnd = () => {
        s = (s * 1103515245 + 12345) & 0x7fffffff;
        return s / 0x7fffffff;
      };
      for (let i = a.length - 1; i > 0; i--) {
        const j = Math.floor(rnd() * (i + 1));
        [a[i], a[j]] = [a[j], a[i]];
      }
      return a;
    },
  ];

  for (const order of [3, 4, 5, 6]) {
    for (let d = 0; d < drainOrders.length; d++) {
      it(`drains a deep tree to empty (order ${order}, pattern ${d})`, () => {
        const n = 80;
        const t = seed(order, Array.from({ length: n }, (_, i) => i));
        expect(t.depth()).toBeGreaterThanOrEqual(order === 3 ? 4 : 3);
        const ref = new Map(Array.from({ length: n }, (_, i) => [i, i] as const));

        let merges = 0;
        let collapses = 0;
        const startEvents = t.events.length;
        for (const k of drainOrders[d](n)) {
          expect(t.delete(k)).toBe(true);
          ref.delete(k);
          check(t, ref); // validate after EVERY single deletion
          const e = t.events[t.events.length - 1];
          if (e && (e.type === 'merge-left' || e.type === 'merge-right')) merges++;
        }
        for (const e of t.events.slice(startEvents)) if (e.type === 'root-collapse') collapses++;

        expect(merges).toBeGreaterThan(0);
        expect(collapses).toBeGreaterThan(0); // internal roots repeatedly folded
        expect(t.size).toBe(0);
        expect(t.depth()).toBe(1);
        expect(t.keys()).toEqual([]);
        t.validate();

        // exactly one leaf root remains; every other page was recycled
        const s = t.stats();
        expect(s.livePages).toBe(1);
        expect(s.freePages).toBe(s.allocated - 1);
      });
    }
  }
});

describe('root minimum-occupancy exemption', () => {
  it('allows a root leaf below the minimum and a shallow internal root', () => {
    const t = seed(4, [1, 2, 3, 4, 5]); // splits into two leaves + internal root
    t.delete(4);
    t.delete(5); // one leaf merges away and the root collapses
    expect(t.depth()).toBe(1);
    t.validate(); // root leaf with a handful of entries is legal

    const u = seed(4, [1, 2, 3, 4, 5, 6, 7, 8]);
    u.delete(7);
    u.delete(8);
    u.validate(); // internal root may keep just two minimum children
  });

  it('never leaves a non-leaf root with a single child', () => {
    const t = seed(3, Array.from({ length: 40 }, (_, i) => i));
    for (let k = 39; k >= 0; k--) {
      t.delete(k);
      t.validate();
    }
    expect(t.depth()).toBe(1);
  });
});

describe('reinsertion after merge and page recycling', () => {
  it('reuses freed page ids and resets stale links', () => {
    const n = 60;
    const t = seed(3, Array.from({ length: n }, (_, i) => i));
    const highWater = t.stats().allocated;

    // drain completely
    for (let k = 0; k < n; k++) {
      t.delete(k);
      t.validate();
    }
    expect(t.stats().livePages).toBe(1);
    const freedIds = new Set(
      t.events.filter((e) => e.type === 'merge-left' || e.type === 'merge-right').map((e) => e.removed),
    );
    expect(freedIds.size).toBeGreaterThan(0);

    // grow again: the allocator must hand freed ids back before minting new
    for (let k = 0; k < n; k++) {
      t.insert(k, k * 10);
      t.validate();
    }
    const s = t.stats();
    expect(s.reused).toBeGreaterThan(0);
    expect(s.allocated).toBe(highWater); // no fresh ids were needed
    const newIds = new Set(
      t.events.filter((e) => e.type === 'split').flatMap((e) => [e.left, e.right]),
    );
    let recycled = 0;
    for (const id of newIds) if (freedIds.has(id)) recycled++;
    expect(recycled).toBeGreaterThan(0);

    const ref = new Map(Array.from({ length: n }, (_, i) => [i, i * 10] as const));
    check(t, ref);
  });

  it('keeps working through repeated grow/shrink cycles', () => {
    const t = new BTree<number, number>({ order: 4, compare: numCompare });
    const ref = new Map<number, number>();
    for (let cycle = 0; cycle < 5; cycle++) {
      for (let k = 0; k < 50; k++) {
        t.insert(k, cycle * 1000 + k);
        ref.set(k, cycle * 1000 + k);
        if (k % 3 === 0) check(t, ref);
      }
      for (let k = 0; k < 50; k++) {
        if (k % 2 === 0) {
          t.delete(k);
          ref.delete(k);
        }
        check(t, ref);
      }
      for (let k = 0; k < 50; k++) {
        if (k % 2 === 0) {
          t.insert(k, -(cycle * 1000 + k));
          ref.set(k, -(cycle * 1000 + k));
        }
        check(t, ref);
      }
    }
  });
});

describe('rebalancing at internal levels', () => {
  it('borrows and merges internal pages, not only leaves', () => {
    const n = 150;
    const t = seed(4, Array.from({ length: n }, (_, i) => i));
    expect(t.depth()).toBeGreaterThanOrEqual(4);

    const start = t.events.length;
    // drain from BOTH ends: left-spine underflows can only borrow/merge
    // right, right-spine underflows only left, so every direction is
    // exercised at the internal levels too
    const order: number[] = [];
    let lo = 0;
    let hi = n - 1;
    while (lo <= hi) {
      order.push(lo++);
      if (lo <= hi) order.push(hi--);
    }
    for (const k of order) {
      t.delete(k);
      t.validate();
    }
    const ev = t.events.slice(start);
    const levels = (type: string) => new Set(ev.filter((e) => e.type === type).map((e) => e.level));
    // level 1 events involve the top internal pages; both directions appear
    expect(Math.max(...levels('borrow-left'), 0)).toBeGreaterThanOrEqual(1);
    expect(Math.max(...levels('borrow-right'), 0)).toBeGreaterThanOrEqual(1);
    expect(Math.max(...levels('merge-left'), 0)).toBeGreaterThanOrEqual(1);
    expect(ev.some((e) => e.type === 'root-collapse')).toBe(true);
    expect(t.size).toBe(0);
  });
});

describe('randomized stress against a reference Map', () => {
  for (const order of [3, 4, 5]) {
    it(`survives thousands of random ops at order ${order}`, () => {
      const t = new BTree<number, number>({ order, compare: numCompare });
      const ref = new Map<number, number>();
      let seed = 987654321 + order;
      const rnd = () => {
        // xorshift32
        seed ^= seed << 13;
        seed ^= seed >>> 17;
        seed ^= seed << 5;
        seed >>>= 0;
        return seed / 0x100000000;
      };
      const KEY_SPACE = 60;
      const OPS = 4000;

      for (let op = 0; op < OPS; op++) {
        const k = Math.floor(rnd() * KEY_SPACE);
        const roll = rnd();
        if (roll < 0.55) {
          const v = Math.floor(rnd() * 1e6);
          t.insert(k, v);
          ref.set(k, v);
          expect(t.size).toBe(ref.size);
        } else if (roll < 0.9) {
          expect(t.delete(k)).toBe(ref.delete(k));
        } else {
          expect(t.has(k)).toBe(ref.has(k));
          expect(t.get(k)).toBe(ref.get(k));
        }
        check(t, ref);
      }

      // range scans must agree with the sorted reference everywhere
      for (let lo = 0; lo < KEY_SPACE; lo += 7) {
        const hi = lo + 13;
        const want = [...ref.entries()]
          .filter(([k]) => k >= lo && k <= hi)
          .sort((a, b) => a[0] - b[0])
          .map(([k, v]) => ({ key: k, value: v }));
        expect(t.range(lo, hi)).toEqual(want);
      }
    });
  }
});
