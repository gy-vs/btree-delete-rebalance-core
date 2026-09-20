import { expect, it, describe } from 'vitest';
import { BTree } from '../src/index.js';

const T = 2; // default minimum degree: leaves t..2t entries, internals t+1..2t+1 children
const key = (n: number) => String(n).padStart(4, '0');
const N = 60; // enough keys for several leaves and (near/over) two levels

/** Insert 0..n-1, asserting validity after every insert. */
function build(n: number, t = T): BTree<number> {
  const tree = new BTree<number>(t);
  tree.assertValid();
  for (let i = 0; i < n; i++) {
    tree.insert(key(i), i);
    tree.assertValid();
  }
  expect(tree.size()).toBe(n);
  return tree;
}

function expectReference(tree: BTree<number>, present: Set<number>): void {
  tree.assertValid();
  // Point lookups.
  for (let i = 0; i < N; i++) {
    expect(tree.get(key(i))).toBe(present.has(i) ? i : undefined);
  }
  // Full range scan must equal the reference set, sorted.
  const scanned = tree.range(key(0), key(9999)).map((e) => e.value);
  const expected = [...present].sort((a, b) => a - b);
  expect(scanned).toEqual(expected);
  // Leaf-chain keys must be globally sorted.
  expect(tree.debug().leafChainKeys).toEqual(expected.map(key));
}

describe('ordered API basics', () => {
  it('stores ordered values (original scenario)', () => {
    const x = new BTree<number>();
    x.insert('b', 2);
    x.insert('a', 1);
    expect(x.range('a', 'z').map((v) => v.key)).toEqual(['a', 'b']);
    x.assertValid();
  });

  it('supports inclusive range windows across leaves', () => {
    const tree = build(N);
    const got = tree.range(key(10), key(14)).map((e) => e.value);
    expect(got).toEqual([10, 11, 12, 13, 14]);
  });
});

describe('leaf borrow: borrow from right', () => {
  it('updates separator, occupancy and leaf chain when borrowing right', () => {
    const tree = build(N);
    const before = tree.getStats();

    // Delete the first key of the leftmost leaf until it sits exactly at the
    // minimum occupancy; one more delete must be healed from its right sibling.
    const firstLeafKeys = tree.debug().pages.find((p) => p.leaf && p.prev === 0)!.keys;
    // Delete down to exactly T entries (never below T => no rebalance yet).
    for (const k of firstLeafKeys.slice(T)) {
      expect(tree.delete(k)).toBe(true);
      tree.assertValid();
    }
    // One more delete drops the leaf to t-1; right sibling must lend.
    expect(tree.delete(firstLeafKeys[T - 1])).toBe(true);
    tree.assertValid();

    const after = tree.getStats();
    expect(after.borrowRight).toBe(before.borrowRight + 1);
    expect(after.merges).toBe(before.merges);

    const removed = new Set(firstLeafKeys.slice(T - 1).map(Number));
    const present = new Set(Array.from({ length: N }, (_, i) => i));
    removed.forEach((i) => present.delete(i));
    expectReference(tree, present);
  });
});

describe('leaf borrow: borrow from left', () => {
  it('updates separator, occupancy and leaf chain when borrowing left', () => {
    const tree = build(N);
    const before = tree.getStats();

    // Pick a leaf whose LEFT sibling is over the minimum, then shrink it to
    // exactly t entries without ever rebalancing. The next delete drops it
    // to t-1 and must be healed by borrowing from the left.
    const pages = tree.debug().pages;
    const target = pages.find((p) => {
      if (!p.leaf || p.prev === 0) return false;
      const leftSibling = pages.find((q) => q.id === p.prev)!;
      return leftSibling.keys.length > T;
    })!;
    // Keep the first t entries, delete the rest (never below t => no rebalance).
    for (const k of target.keys.slice(T)) {
      expect(tree.delete(k)).toBe(true);
      tree.assertValid();
    }
    expect(tree.delete(target.keys[T - 1])).toBe(true); // t -> t-1 triggers borrow
    tree.assertValid();

    const after = tree.getStats();
    expect(after.borrowLeft).toBe(before.borrowLeft + 1);
    expect(after.merges).toBe(before.merges);

    // Everything still there except the entries we removed, in global order.
    const removed = new Set(target.keys.slice(T - 1).map(Number));
    const present = new Set(Array.from({ length: N }, (_, i) => i));
    removed.forEach((i) => present.delete(i));
    expectReference(tree, present);
  });
});

describe('merges and root folding', () => {
  it('drains a small tree: leaf merges fold the internal root', () => {
    // Two-level tree (3 leaves), then delete leaves away entirely.
    const tree = build(13);
    expect(tree.depth()).toBe(2);

    for (let i = 0; i < 13; i++) {
      expect(tree.delete(key(i))).toBe(true);
      tree.assertValid();
    }
    expect(tree.size()).toBe(0);
    expect(tree.depth()).toBe(0);
    expect(tree.debug().rootId).toBe(0);
    expect(tree.debug().allocatedPages).toEqual([]);
    expect(tree.debug().freePages.length).toBeGreaterThan(0);
    expect(tree.getStats().rootCollapses).toBeGreaterThan(0);
  });

  it('cascades merges through multiple internal levels and folds the root', () => {
    // 301 keys is well past the point where internals themselves split,
    // giving a three-level tree.
    const n = 301;
    const tree = build(n);
    expect(tree.depth()).toBeGreaterThanOrEqual(3);
    const peakPages = tree.debug().allocatedPages.length;
    expect(peakPages).toBeGreaterThan(0);

    for (let i = 0; i < n; i++) {
      expect(tree.delete(key(i))).toBe(true);
      tree.assertValid();
    }
    expect(tree.size()).toBe(0);
    expect(tree.depth()).toBe(0);
    expect(tree.debug().allocatedPages).toEqual([]);
    const stats = tree.getStats();
    expect(stats.merges).toBeGreaterThan(0);
    expect(stats.rootCollapses).toBeGreaterThan(0);
  });

  it('also cascades when keys are deleted in descending order', () => {
    const n = 301;
    const tree = build(n);
    for (let i = n - 1; i >= 0; i--) {
      expect(tree.delete(key(i))).toBe(true);
      tree.assertValid();
    }
    expect(tree.size()).toBe(0);
    expect(tree.depth()).toBe(0);
    expect(tree.debug().allocatedPages).toEqual([]);
  });
});

describe('missing and empty deletes', () => {
  it('delete on an empty tree is a no-op', () => {
    const tree = new BTree<number>();
    expect(tree.delete(key(1))).toBe(false);
    tree.assertValid();
    expect(tree.size()).toBe(0);
    expect(tree.depth()).toBe(0);
  });

  it('delete of missing keys never mutates the tree', () => {
    const tree = build(N);
    const snapshot = tree.debug();
    expect(tree.delete(key(9999))).toBe(false);
    expect(tree.delete(key(4242))).toBe(false); // genuinely absent, tree must stay identical
    tree.assertValid();
    expect(tree.debug().allocatedPages).toEqual(snapshot.allocatedPages);
    expect(tree.size()).toBe(N);

    // Remove some keys, then try keys between/around survivors.
    for (const i of [3, 4, 10, 11, 40]) {
      expect(tree.delete(key(i))).toBe(true);
      tree.assertValid();
      expect(tree.delete(key(i))).toBe(false);
      tree.assertValid();
    }
    expect(tree.delete(key(9998))).toBe(false);
    tree.assertValid();
    const present = new Set(Array.from({ length: N }, (_, i) => i));
    [3, 4, 10, 11, 40].forEach((i) => present.delete(i));
    expectReference(tree, present);
  });
});

describe('delete to empty tree', () => {
  it('releases every page and survives becoming empty again', () => {
    const tree = build(N);
    for (let i = 0; i < N; i++) {
      tree.delete(key(i));
      tree.assertValid();
    }
    expect(tree.debug().allocatedPages).toEqual([]);
    expect(tree.range('', 'zzz')).toEqual([]);
    expect(tree.get(key(0))).toBeUndefined();
  });
});

describe('duplicate keys', () => {
  it('upserts in a leaf without changing size', () => {
    const tree = new BTree<number>();
    tree.insert('a', 1);
    tree.insert('b', 2);
    tree.assertValid();
    tree.insert('a', 100);
    tree.assertValid();
    expect(tree.size()).toBe(2);
    expect(tree.get('a')).toBe(100);
  });

  it('upserts keep the tree reference-identical under a heavy interleaved run', () => {
    const tree = build(N);
    const before = tree.getStats();
    for (let round = 0; round < 3; round++) {
      for (let i = 0; i < N; i++) {
        tree.insert(key(i), i * 1000 + round);
        tree.assertValid();
      }
    }
    expect(tree.size()).toBe(N);
    expect(tree.getStats().splits).toBe(before.splits);
    const present = new Set(Array.from({ length: N }, (_, i) => i));
    for (let i = 0; i < N; i++) {
      expect(tree.get(key(i))).toBe((i * 1000) + 2);
    }
    tree.range(key(0), key(9999)).forEach((e) => {
      expect(present.has(e.value % 1000 === 2 ? Math.floor(e.value / 1000) : -1)).toBe(true);
    });
  });
});

describe('re-insert after merges and page recycling', () => {
  it('reinserts after shrinking reuse freed page ids', () => {
    const tree = build(N);
    const watermark = tree.getStats().watermark;

    for (let i = 0; i < N; i++) {
      tree.delete(key(i));
      tree.assertValid();
    }
    expect(tree.debug().freePages.length).toBe(watermark);

    // Rebuild from the empty state.
    for (let i = 0; i < N; i++) {
      tree.insert(key(i), i);
      tree.assertValid();
    }
    expect(tree.size()).toBe(N);
    const stats = tree.getStats();
    expect(stats.reusedPages).toBeGreaterThan(0);

    // A recycled id must point at a live, reachable page; the set of
    // allocated ids must be a subset of ids ever issued.
    const dbg = tree.debug();
    expect(dbg.allocatedPages.every((id) => id >= 1 && id <= stats.watermark)).toBe(true);
    expect(dbg.freePages.every((id) => !dbg.allocatedPages.includes(id))).toBe(true);
    expectReference(tree, new Set(Array.from({ length: N }, (_, i) => i)));
  });

  it('alternating delete/insert waves stay structurally valid', () => {
    const tree = build(N);
    for (let wave = 0; wave < 6; wave++) {
      const removeEven = wave % 2 === 0;
      for (let i = 0; i < N; i++) {
        if (i % 2 === (removeEven ? 0 : 1)) {
          tree.delete(key(i));
          tree.assertValid();
        }
      }
      for (let i = 0; i < N; i++) {
        if (i % 2 === (removeEven ? 0 : 1)) {
          tree.insert(key(i), i);
          tree.assertValid();
        }
      }
      expectReference(tree, new Set(Array.from({ length: N }, (_, i) => i)));
    }
  });
});

describe('randomized model: both borrow directions, both merge sides', () => {
  function model(seed: number, steps: number): void {
    const tree = new BTree<number>(2);
    const ref = new Map<number, number>();
    let s = seed;
    const rand = () => {
      // deterministic LCG
      s = (s * 1103515245 + 12345) & 0x7fffffff;
      return s / 0x7fffffff;
    };

    for (let step = 0; step < steps; step++) {
      const k = Math.floor(rand() * 220);
      const r = rand();
      if (r < 0.42) {
        tree.insert(key(k), k);
        ref.set(k, k);
      } else if (r < 0.8) {
        expect(tree.delete(key(k))).toBe(ref.delete(k));
      } else {
        expect(tree.get(key(k))).toBe(ref.has(k) ? k : undefined);
      }
      tree.assertValid();

      if (step % 25 === 0) {
        const keys = [...ref.keys()].sort((a, b) => a - b);
        expect(tree.size()).toBe(ref.size);
        expect(tree.range(key(0), key(9999)).map((e) => e.value)).toEqual(keys);
        expect(tree.debug().leafChainKeys).toEqual(keys.map(key));
      }
    }

    const keys = [...ref.keys()].sort((a, b) => a - b);
    expect(tree.range(key(0), key(9999)).map((e) => e.value)).toEqual(keys);
  }

  for (const seed of [1, 2, 7, 42, 99, 123456]) {
    it(`matches the reference model under random ops (seed ${seed})`, () => {
      model(seed, 1500);
    });
  }
});
