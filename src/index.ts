/**
 * Paged B+-tree with complete delete-time rebalancing.
 *
 * Every structural operation keeps four things in sync:
 *   1. separator keys in the parent page
 *   2. parent back-references of child pages
 *   3. the doubly-linked leaf chain
 *   4. the page allocator (freed pages go to a free list and are reused)
 *
 * Delete rebalancing starts at the affected leaf and walks the saved path
 * upwards: borrow from a sibling when possible, otherwise merge; an internal
 * root with a single child is folded, and an empty leaf root is released so
 * the tree is represented by rootId === 0 (zero reachable pages).
 *
 * Keys are unique: inserting an existing key replaces its value.
 */

const NO_PAGE = 0;

interface LeafPage<V> {
  readonly id: number;
  readonly leaf: true;
  keys: string[];
  values: V[];
  parent: number;
  prev: number;
  next: number;
}

interface InternalPage {
  readonly id: number;
  readonly leaf: false;
  /** keys[i] is a copy of the smallest key in the subtree children[i+1] */
  keys: string[];
  children: number[];
  parent: number;
}

type Page<V> = LeafPage<V> | InternalPage;

interface PathEntry {
  node: InternalPage;
  index: number;
}

/** Page allocator: hands out fresh ids, or reuses ids from the free list. */
class Pager<V> {
  readonly pages = new Map<number, Page<V>>();
  readonly freeList: number[] = [];
  reused = 0;
  private nextId = 1;

  allocLeaf(parent: number): LeafPage<V> {
    const id = this.take();
    const page: LeafPage<V> = {
      id,
      leaf: true,
      keys: [],
      values: [],
      parent,
      prev: NO_PAGE,
      next: NO_PAGE,
    };
    this.pages.set(id, page);
    return page;
  }

  allocInternal(parent: number): InternalPage {
    const id = this.take();
    const page: InternalPage = { id, leaf: false, keys: [], children: [], parent };
    this.pages.set(id, page);
    return page;
  }

  get(id: number): Page<V> {
    const page = this.pages.get(id);
    if (!page) throw new Error(`btree: referenced page ${id} is not allocated`);
    return page;
  }

  release(id: number): void {
    if (!this.pages.delete(id)) {
      throw new Error(`btree: attempted to free unallocated page ${id}`);
    }
    this.freeList.push(id);
  }

  private take(): number {
    const recycled = this.freeList.pop();
    if (recycled !== undefined) {
      this.reused++;
      return recycled;
    }
    return this.nextId++;
  }

  /** Highest id ever handed out (ids are dense starting at 1). */
  get watermark(): number {
    return this.nextId - 1;
  }
}

export interface BTreeStats {
  splits: number;
  borrowLeft: number;
  borrowRight: number;
  merges: number;
  rootCollapses: number;
  reusedPages: number;
  watermark: number;
}

export interface PageSnapshot {
  id: number;
  leaf: boolean;
  keys: string[];
  children: number[];
  parent: number;
  prev: number;
  next: number;
}

export interface BTreeDebug {
  degree: number;
  rootId: number;
  size: number;
  depth: number;
  allocatedPages: number[];
  freePages: number[];
  pages: PageSnapshot[];
  leafChainKeys: string[];
  stats: BTreeStats;
}

export class BTree<V> {
  private readonly pager = new Pager<V>();
  private rootId: number = NO_PAGE;
  private count = 0;
  /** Minimum degree t: leaves hold t..2t entries, internals t+1..2t+1 children. */
  private readonly t: number;
  private readonly stats = {
    splits: 0,
    borrowLeft: 0,
    borrowRight: 0,
    merges: 0,
    rootCollapses: 0,
  };

  constructor(degree = 2) {
    if (!Number.isInteger(degree) || degree < 2) {
      throw new Error('btree: degree must be an integer >= 2');
    }
    this.t = degree;
  }

  size(): number {
    return this.count;
  }

  get(key: string): V | undefined {
    if (this.rootId === NO_PAGE) return undefined;
    const { leaf } = this.locate(key);
    const i = this.lowerBound(leaf.keys, key);
    return leaf.keys[i] === key ? leaf.values[i] : undefined;
  }

  /** Inclusive range scan, driven by the leaf chain. */
  range(start: string, end: string): { key: string; value: V }[] {
    if (this.rootId === NO_PAGE || start > end) return [];
    let cur = this.locate(start).leaf;
    let i = this.lowerBound(cur.keys, start);
    const out: { key: string; value: V }[] = [];
    for (;;) {
      for (; i < cur.keys.length; i++) {
        if (cur.keys[i] > end) return out;
        out.push({ key: cur.keys[i], value: cur.values[i] });
      }
      if (cur.next === NO_PAGE) return out;
      cur = this.pager.get(cur.next) as LeafPage<V>;
      i = 0;
    }
  }

  insert(key: string, value: V): void {
    if (this.rootId === NO_PAGE) {
      this.rootId = this.pager.allocLeaf(NO_PAGE).id;
    }
    const { leaf, path } = this.locate(key);
    const pos = this.lowerBound(leaf.keys, key);
    if (leaf.keys[pos] === key) {
      leaf.values[pos] = value; // duplicate key: upsert, no structural change
      return;
    }
    leaf.keys.splice(pos, 0, key);
    leaf.values.splice(pos, 0, value);
    this.count++;

    if (leaf.keys.length > 2 * this.t) {
      // Splits restructure siblings at possibly multiple levels; recompute all
      // separators from live leaves so no stale copy can survive.
      this.splitLeaf(leaf, path);
      this.rebuildAllSeparators();
    } else if (pos === 0) {
      // New minimum inside the existing leaf: only ancestors on the descent
      // can hold a mirror of that minimum; refresh just those separators.
      this.syncDescentSeparators(leaf);
    }
  }

  /** @returns true when the key existed and was removed */
  delete(key: string): boolean {
    if (this.rootId === NO_PAGE) return false;
    const { leaf, path } = this.locate(key);
    const pos = this.lowerBound(leaf.keys, key);
    if (leaf.keys[pos] !== key) return false; // missing key: no mutation at all

    leaf.keys.splice(pos, 1);
    leaf.values.splice(pos, 1);
    this.count--;

    // Rebalance upwards from the affected leaf.
    let cur: Page<V> = leaf;
    while (path.length > 0) {
      if (!this.underflow(cur)) break; // a borrow fixed it; ancestors are untouched
      const top = path.pop()!;
      this.rebalance(cur, top.node, top.index);
      cur = top.node; // with a merge, cur was released and we continue at parent
    }

    // Fold any internal root (possibly repeatedly) that collapsed to one child.
    while (this.rootId !== NO_PAGE) {
      const root = this.pager.get(this.rootId);
      if (root.leaf) {
        if (root.keys.length === 0) {
          this.pager.release(root.id);
          this.rootId = NO_PAGE;
        }
        break;
      }
      if (root.children.length !== 1) break;
      // Non-leaf root with a single child must collapse (root may be sparse).
      const only = this.pager.get(root.children[0]);
      this.pager.release(root.id);
      only.parent = NO_PAGE;
      this.rootId = only.id;
      this.stats.rootCollapses++;
    }

    // Recompute every separator from live leaves in one post-order pass.
    // Borrowing can touch an off-path sibling internal page, and a moved/
    // removed subtree minimum is mirrored in arbitrary ancestors; rebuilding
    // all still-reachable internals removes that whole class of stale-key bug.
    this.rebuildAllSeparators();
    return true;
  }

  // ---- insertion / splits -------------------------------------------------

  private splitLeaf(leaf: LeafPage<V>, path: PathEntry[]): void {
    // Overflow holds 2t+1 entries: keep t+1 left, move t to the new right leaf.
    const cut = this.t + 1;
    const right = this.pager.allocLeaf(leaf.parent);
    right.keys = leaf.keys.splice(cut);
    right.values = leaf.values.splice(cut);

    // Splice `right` into the leaf chain directly after `leaf`.
    right.prev = leaf.id;
    right.next = leaf.next;
    if (leaf.next !== NO_PAGE) {
      (this.pager.get(leaf.next) as LeafPage<V>).prev = right.id;
    }
    leaf.next = right.id;

    this.attachChild(leaf.id, right.keys[0], right.id, path);
    this.stats.splits++;
  }

  private splitInternal(node: InternalPage, path: PathEntry[]): void {
    // Overflow: 2t+1 keys / 2t+2 children. Left keeps t keys / t+1 children,
    // keys[t] is promoted, the rest goes to the new right page.
    const middle = node.keys[this.t];
    const right = this.pager.allocInternal(node.parent);
    right.children = node.children.splice(this.t + 1);
    right.keys = node.keys.splice(this.t + 1);
    node.keys.pop(); // remove the promoted middle key from the left side
    for (const childId of right.children) {
      this.pager.get(childId).parent = right.id;
    }
    this.attachChild(node.id, middle, right.id, path);
    this.stats.splits++;
  }

  /** Insert separator `key` + child `rightId` immediately after child `leftId`. */
  private attachChild(
    leftId: number,
    key: string,
    rightId: number,
    path: PathEntry[],
  ): void {
    const top = path[path.length - 1];
    if (!top) {
      const root = this.pager.allocInternal(NO_PAGE);
      root.keys = [key];
      root.children = [leftId, rightId];
      this.pager.get(leftId).parent = root.id;
      this.pager.get(rightId).parent = root.id;
      this.rootId = root.id;
      return;
    }
    const parent = top.node;
    parent.keys.splice(top.index, 0, key);
    parent.children.splice(top.index + 1, 0, rightId);
    this.pager.get(rightId).parent = parent.id;
    if (parent.children.length > 2 * this.t + 1) {
      this.splitInternal(parent, path.slice(0, -1));
    }
  }

  // ---- deletion / rebalancing --------------------------------------------

  private underflow(page: Page<V>): boolean {
    return page.leaf ? page.keys.length < this.t : page.children.length < this.t + 1;
  }

  /**
   * Recompute every separator in the tree with one post-order traversal:
   * for each internal page, keys[i] becomes the leftmost live key of
   * children[i+1]'s subtree. Rebuilding children first means each leftmostKey
   * lookup reads already-correct separators all the way down. This is the
   * single source of truth for the separator invariant.
   */
  private rebuildAllSeparators(): void {
    if (this.rootId === NO_PAGE) return;
    const visit = (id: number): void => {
      const page = this.pager.get(id);
      if (page.leaf) return;
      for (const childId of page.children) visit(childId);
      const next: string[] = [];
      for (let i = 1; i < page.children.length; i++) {
        next.push(this.leftmostKey(page.children[i]));
      }
      page.keys = next;
    };
    visit(this.rootId);
  }

  /**
   * Refresh only separators along the root-to-leaf descent after a non-split
   * insertion moved a leaf's minimum. Used when no siblings changed shape.
   */
  private syncDescentSeparators(leaf: LeafPage<V>): void {
    let childId = leaf.id;
    let parentId = leaf.parent;
    while (parentId !== NO_PAGE) {
      const parent = this.pager.get(parentId) as InternalPage;
      const slot = parent.children.indexOf(childId);
      if (slot > 0) parent.keys[slot - 1] = this.leftmostKey(childId);
      childId = parentId;
      parentId = parent.parent;
    }
  }

  private rebalance(
    child: Page<V>,
    parent: InternalPage,
    index: number,
  ): void {
    if (child.leaf) {
      const left = index > 0 ? (this.pager.get(parent.children[index - 1]) as LeafPage<V>) : undefined;
      const right =
        index < parent.children.length - 1
          ? (this.pager.get(parent.children[index + 1]) as LeafPage<V>)
          : undefined;

      if (left && left.keys.length > this.t) {
        this.borrowLeafLeft(left, child, parent, index);
        return;
      }
      if (right && right.keys.length > this.t) {
        this.borrowLeafRight(child, right, parent, index);
        return;
      }
      if (left) {
        // `left` absorbs `child`; separator/child at index-1 are removed.
        this.mergeLeaves(left, child, parent, index - 1);
        return;
      }
      this.mergeLeaves(child, right!, parent, index);
      return;
    }

    const node = child as InternalPage;
    const left = index > 0 ? (this.pager.get(parent.children[index - 1]) as InternalPage) : undefined;
    const right =
      index < parent.children.length - 1
        ? (this.pager.get(parent.children[index + 1]) as InternalPage)
        : undefined;

    if (left && left.children.length > this.t + 1) {
      this.borrowInternalLeft(left, node, parent, index);
    } else if (right && right.children.length > this.t + 1) {
      this.borrowInternalRight(node, right, parent, index);
    } else if (left) {
      this.mergeInternal(left, node, parent, index - 1);
    } else {
      this.mergeInternal(node, right!, parent, index);
    }
  }

  private borrowLeafLeft(
    from: LeafPage<V>,
    to: LeafPage<V>,
    parent: InternalPage,
    index: number,
  ): void {
    const key = from.keys.pop()!;
    const value = from.values.pop()!;
    to.keys.unshift(key);
    to.values.unshift(value);
    parent.keys[index - 1] = key; // separator == new first key of `to`
    // Leaf chain and parent references are unchanged (no page moved).
    this.stats.borrowLeft++;
  }

  private borrowLeafRight(
    to: LeafPage<V>,
    from: LeafPage<V>,
    parent: InternalPage,
    index: number,
  ): void {
    const key = from.keys.shift()!;
    const value = from.values.shift()!;
    to.keys.push(key);
    to.values.push(value);
    parent.keys[index] = from.keys[0]; // separator == new first key of `from`
    this.stats.borrowRight++;
  }

  /** Leaf `left` absorbs leaf `right`; their separator sits at parent.keys[sepIndex]. */
  private mergeLeaves(
    left: LeafPage<V>,
    right: LeafPage<V>,
    parent: InternalPage,
    sepIndex: number,
  ): void {
    left.keys.push(...right.keys);
    left.values.push(...right.values);

    // Unlink `right` from the leaf chain.
    left.next = right.next;
    if (right.next !== NO_PAGE) {
      (this.pager.get(right.next) as LeafPage<V>).prev = left.id;
    }

    parent.keys.splice(sepIndex, 1);
    parent.children.splice(sepIndex + 1, 1);
    right.parent = NO_PAGE;
    this.pager.release(right.id);
    this.stats.merges++;
  }

  private borrowInternalLeft(
    from: InternalPage,
    to: InternalPage,
    parent: InternalPage,
    index: number,
  ): void {
    const newSeparator = from.keys.pop()!; // smallest key of the moved subtree
    const movedChild = from.children.pop()!;
    const oldSeparator = parent.keys[index - 1];

    to.keys.unshift(oldSeparator);
    to.children.unshift(movedChild);
    parent.keys[index - 1] = newSeparator;
    this.pager.get(movedChild).parent = to.id;
    this.stats.borrowLeft++;
  }

  private borrowInternalRight(
    to: InternalPage,
    from: InternalPage,
    parent: InternalPage,
    index: number,
  ): void {
    const oldSeparator = parent.keys[index]; // smallest key of from's first subtree
    const movedChild = from.children.shift()!;
    const newSeparator = from.keys.shift()!; // smallest key of from's new first subtree

    to.keys.push(oldSeparator);
    to.children.push(movedChild);
    parent.keys[index] = newSeparator;
    this.pager.get(movedChild).parent = to.id;
    this.stats.borrowRight++;
  }

  /** Internal page `left` absorbs `right`, pulling parent.keys[sepIndex] down. */
  private mergeInternal(
    left: InternalPage,
    right: InternalPage,
    parent: InternalPage,
    sepIndex: number,
  ): void {
    left.keys.push(parent.keys[sepIndex], ...right.keys);
    for (const childId of right.children) {
      left.children.push(childId);
      this.pager.get(childId).parent = left.id;
    }
    parent.keys.splice(sepIndex, 1);
    parent.children.splice(sepIndex + 1, 1);
    right.parent = NO_PAGE;
    this.pager.release(right.id);
    this.stats.merges++;
  }

  // ---- traversal helpers --------------------------------------------------

  private lowerBound(keys: string[], key: string): number {
    let lo = 0;
    let hi = keys.length;
    while (lo < hi) {
      const mid = (lo + hi) >> 1;
      if (keys[mid] < key) lo = mid + 1;
      else hi = mid;
    }
    return lo;
  }

  private upperBound(keys: string[], key: string): number {
    let lo = 0;
    let hi = keys.length;
    while (lo < hi) {
      const mid = (lo + hi) >> 1;
      if (keys[mid] <= key) lo = mid + 1;
      else hi = mid;
    }
    return lo;
  }

  private locate(key: string): { leaf: LeafPage<V>; path: PathEntry[] } {
    const path: PathEntry[] = [];
    let cur: Page<V> = this.pager.get(this.rootId);
    while (!cur.leaf) {
      const index = this.upperBound(cur.keys, key);
      path.push({ node: cur, index });
      cur = this.pager.get(cur.children[index]);
    }
    return { leaf: cur, path };
  }

  private leftmostLeaf(): LeafPage<V> | undefined {
    if (this.rootId === NO_PAGE) return undefined;
    let cur: Page<V> = this.pager.get(this.rootId);
    while (!cur.leaf) cur = this.pager.get(cur.children[0]);
    return cur;
  }

  private leftmostKey(id: number): string {
    let cur = this.pager.get(id);
    while (!cur.leaf) cur = this.pager.get(cur.children[0]);
    return cur.keys[0];
  }

  private rightmostKey(id: number): string {
    let cur = this.pager.get(id);
    while (!cur.leaf) cur = this.pager.get(cur.children[cur.children.length - 1]);
    return cur.keys[cur.keys.length - 1];
  }

  // ---- diagnostics / invariant checking ----------------------------------

  getStats(): BTreeStats {
    return {
      ...this.stats,
      reusedPages: this.pager.reused,
      watermark: this.pager.watermark,
    };
  }

  depth(): number {
    if (this.rootId === NO_PAGE) return 0;
    let depth = 1;
    let cur: Page<V> = this.pager.get(this.rootId);
    while (!cur.leaf) {
      depth++;
      cur = this.pager.get(cur.children[0]);
    }
    return depth;
  }

  debug(): BTreeDebug {
    const pages: PageSnapshot[] = [];
    for (const id of [...this.pager.pages.keys()].sort((a, b) => a - b)) {
      const p = this.pager.pages.get(id)!;
      pages.push({
        id: p.id,
        leaf: p.leaf,
        keys: [...p.keys],
        children: p.leaf ? [] : [...p.children],
        parent: p.parent,
        prev: p.leaf ? p.prev : NO_PAGE,
        next: p.leaf ? p.next : NO_PAGE,
      });
    }
    const leafChainKeys: string[] = [];
    for (let cur = this.leftmostLeaf(); cur; cur = cur.next ? (this.pager.get(cur.next) as LeafPage<V>) : undefined) {
      leafChainKeys.push(...cur.keys);
    }
    return {
      degree: this.t,
      rootId: this.rootId,
      size: this.count,
      depth: this.depth(),
      allocatedPages: pages.map((p) => p.id),
      freePages: [...this.pager.freeList].sort((a, b) => a - b),
      pages,
      leafChainKeys,
      stats: this.getStats(),
    };
  }

  /**
   * Verify every structural invariant; throw on the first violation:
   * sorted keys, occupancy, parent/child consistency, separator correctness,
   * leaf-chain integrity and the reachable-page set vs. the allocator.
   */
  assertValid(): void {
    const t = this.t;
    if (this.rootId === NO_PAGE) {
      if (this.count !== 0) throw new Error('btree invariant: empty root but size > 0');
      if (this.pager.pages.size !== 0) {
        throw new Error('btree invariant: empty tree but pages remain allocated');
      }
      this.assertFreeListHealthy();
      return;
    }

    const reachable = new Set<number>();
    const leavesInOrder: LeafPage<V>[] = [];
    let entryCount = 0;

    const walk = (page: Page<V>, expectedParent: number): void => {
      if (reachable.has(page.id)) {
        throw new Error(`btree invariant: page ${page.id} reachable twice`);
      }
      if (page.parent !== expectedParent) {
        throw new Error(
          `btree invariant: page ${page.id} parent is ${page.parent}, expected ${expectedParent}`,
        );
      }
      reachable.add(page.id);

      for (let i = 1; i < page.keys.length; i++) {
        if (page.keys[i - 1] >= page.keys[i]) {
          throw new Error(`btree invariant: keys not strictly sorted in page ${page.id}`);
        }
      }

      if (page.leaf) {
        if (page.keys.length !== page.values.length) {
          throw new Error(`btree invariant: key/value count mismatch in leaf ${page.id}`);
        }
        if (page.keys.length > 2 * t) {
          throw new Error(`btree invariant: leaf ${page.id} exceeds max occupancy`);
        }
        if (page.id !== this.rootId && page.keys.length < t) {
          throw new Error(`btree invariant: non-root leaf ${page.id} below min occupancy`);
        }
        leavesInOrder.push(page);
        entryCount += page.keys.length;
        return;
      }

      if (page.children.length !== page.keys.length + 1) {
        throw new Error(`btree invariant: internal page ${page.id} key/child count mismatch`);
      }
      if (page.children.length > 2 * t + 1) {
        throw new Error(`btree invariant: internal page ${page.id} exceeds max fanout`);
      }
      if (page.id === this.rootId) {
        if (page.children.length < 2) {
          throw new Error(`btree invariant: internal root ${page.id} was not folded`);
        }
      } else if (page.children.length < t + 1) {
        throw new Error(`btree invariant: non-root internal page ${page.id} below min fanout`);
      }

      for (const childId of page.children) {
        if (!this.pager.pages.has(childId)) {
          throw new Error(`btree invariant: page ${page.id} references missing page ${childId}`);
        }
        walk(this.pager.get(childId), page.id);
      }
      for (let i = 0; i < page.keys.length; i++) {
        const sep = page.keys[i];
        if (sep !== this.leftmostKey(page.children[i + 1])) {
          throw new Error(`btree invariant: stale separator in page ${page.id} at ${i}`);
        }
        if (sep <= this.rightmostKey(page.children[i])) {
          throw new Error(`btree invariant: separator ${sep} does not divide children of ${page.id}`);
        }
      }
    };

    walk(this.pager.get(this.rootId), NO_PAGE);

    // Leaf chain: leftmost -> next must enumerate exactly the DFS leaves.
    const first = this.leftmostLeaf()!;
    if (first.prev !== NO_PAGE) {
      throw new Error('btree invariant: leftmost leaf has a prev link');
    }
    let chainCur: LeafPage<V> | undefined = first;
    let chainIndex = 0;
    let previousId = NO_PAGE;
    while (chainCur) {
      const expected = leavesInOrder[chainIndex];
      if (!expected || chainCur.id !== expected.id) {
        throw new Error('btree invariant: leaf chain does not match reachable leaves');
      }
      if (chainCur.prev !== previousId) {
        throw new Error(`btree invariant: leaf ${chainCur.id} prev link broken`);
      }
      previousId = chainCur.id;
      chainCur = chainCur.next !== NO_PAGE ? (this.pager.get(chainCur.next) as LeafPage<V>) : undefined;
      chainIndex++;
    }
    if (chainIndex !== leavesInOrder.length) {
      throw new Error('btree invariant: leaf chain misses reachable leaves');
    }

    // Global key order across the whole chain.
    let lastKey: string | undefined;
    for (const leaf of leavesInOrder) {
      for (const key of leaf.keys) {
        if (lastKey !== undefined && key <= lastKey) {
          throw new Error('btree invariant: leaf chain keys are not globally sorted');
        }
        lastKey = key;
      }
    }

    if (entryCount !== this.count) {
      throw new Error(`btree invariant: live entries ${entryCount} != size ${this.count}`);
    }

    // Every allocated page must be reachable; no dangling or leaked pages.
    const allocated = [...this.pager.pages.keys()];
    if (allocated.length !== reachable.size || allocated.some((id) => !reachable.has(id))) {
      throw new Error('btree invariant: allocated page set differs from reachable set');
    }
    this.assertFreeListHealthy();
    if (this.pager.freeList.some((id) => reachable.has(id))) {
      throw new Error('btree invariant: a reachable page is marked free');
    }
  }

  private assertFreeListHealthy(): void {
    const seen = new Set<number>();
    for (const id of this.pager.freeList) {
      if (id <= 0 || seen.has(id)) {
        throw new Error(`btree invariant: corrupt free list entry ${id}`);
      }
      seen.add(id);
    }
  }
}
