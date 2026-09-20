/**
 * Paged B+tree with delete-time rebalancing.
 *
 * Four structural operations, each keeping ALL of the following in sync:
 *   1. the separator key in the parent
 *   2. the parent reference of the affected child page(s)
 *   3. the leaf doubly-linked chain (prev / next)
 *   4. the page allocator (free list / reuse counters)
 *
 * Rebalance walks from the affected leaf upwards: on underflow a node
 * borrows from a sibling (left then right) or merges (left then right).
 * The root may sit below the normal minimum occupancy, but a non-leaf root
 * left with a single child is always collapsed.
 */

export type Comparator<K> = (a: K, b: K) => number;

interface Entry<K, V> {
  key: K;
  value: V;
}

export type PageId = number;

interface BasePage {
  id: PageId;
  parent: PageId | null;
}

export interface LeafPage<K, V> extends BasePage {
  kind: 'leaf';
  entries: Entry<K, V>[];
  prev: PageId | null;
  next: PageId | null;
}

export interface InternalPage<K> extends BasePage {
  kind: 'internal';
  keys: K[];
  children: PageId[];
}

export type Page<K, V> = LeafPage<K, V> | InternalPage<K>;

export type RebalanceEvent =
  | { type: 'borrow-left'; page: PageId; from: PageId; level: number }
  | { type: 'borrow-right'; page: PageId; from: PageId; level: number }
  | { type: 'merge-left'; survivor: PageId; removed: PageId; level: number }
  | { type: 'merge-right'; survivor: PageId; removed: PageId; level: number }
  | { type: 'split'; left: PageId; right: PageId; level: number }
  | { type: 'root-collapse'; oldRoot: PageId; newRoot: PageId };

interface AncestorFrame<K> {
  page: InternalPage<K>;
  /** index of the child inside `page.children` that led us here */
  index: number;
}

export interface BTreeStats {
  /** ids ever handed out */
  allocated: number;
  /** pages created by reusing a freed id */
  reused: number;
  /** live pages */
  livePages: number;
  /** free-list size (must equal live-reachable consistency) */
  freePages: number;
  depth: number;
}

export class BTree<V, K = string> {
  readonly order: number;
  /** minimum entries in a non-root leaf */
  readonly minLeaf: number;
  /** minimum keys in a non-root internal node (children = keys + 1) */
  readonly minInternal: number;

  #cmp: Comparator<K>;
  #pages = new Map<PageId, Page<K, V>>();
  #free: PageId[] = [];
  #nextId = 0;
  #reused = 0;
  #root: PageId;
  #count = 0;

  /** record of every structural mutation, asserted against by the tests */
  readonly events: RebalanceEvent[] = [];

  constructor(options?: { order?: number; compare?: Comparator<K> }) {
    const order = options?.order ?? 4;
    if (order < 3) {
      throw new Error('order must be at least 3 so two minimum nodes can merge');
    }
    this.order = order;
    this.minLeaf = Math.ceil(order / 2);
    this.minInternal = Math.floor(order / 2);
    this.#cmp =
      options?.compare ??
      ((a: K, b: K) => (a === b ? 0 : (a as unknown as string) < (b as unknown as string) ? -1 : 1));
    this.#root = this.#newLeaf();
  }

  // ----- allocator ---------------------------------------------------------

  #newLeaf(): PageId {
    const id = this.#obtainId();
    this.#pages.set(id, { kind: 'leaf', id, parent: null, entries: [], prev: null, next: null });
    return id;
  }

  #newInternal(): PageId {
    const id = this.#obtainId();
    this.#pages.set(id, { kind: 'internal', id, parent: null, keys: [], children: [] });
    return id;
  }

  #obtainId(): PageId {
    const recycled = this.#free.pop();
    if (recycled !== undefined) {
      this.#reused++;
      return recycled;
    }
    return this.#nextId++;
  }

  /** remove a page that has just been merged away and hand its id back */
  #releasePage(id: PageId): void {
    this.#pages.delete(id);
    this.#free.push(id);
  }

  #page(id: PageId): Page<K, V> {
    const p = this.#pages.get(id);
    if (!p) throw new Error(`dangling page reference: ${id}`);
    return p;
  }

  #leaf(id: PageId): LeafPage<K, V> {
    const p = this.#page(id);
    if (p.kind !== 'leaf') throw new Error('expected leaf page');
    return p;
  }

  #internal(id: PageId): InternalPage<K> {
    const p = this.#page(id);
    if (p.kind !== 'internal') throw new Error('expected internal page');
    return p;
  }

  // ----- helpers -----------------------------------------------------------

  /** first child index whose separator is strictly greater than key */
  #upperBound(page: InternalPage<K>, key: K): number {
    let lo = 0;
    let hi = page.keys.length;
    while (lo < hi) {
      const mid = (lo + hi) >>> 1;
      if (this.#cmp(page.keys[mid], key) <= 0) lo = mid + 1;
      else hi = mid;
    }
    return lo;
  }

  #findLeaf(key: K): { leaf: LeafPage<K, V>; ancestors: AncestorFrame<K>[] } {
    const ancestors: AncestorFrame<K>[] = [];
    let node = this.#page(this.#root);
    while (node.kind === 'internal') {
      const index = this.#upperBound(node, key);
      ancestors.push({ page: node, index });
      node = this.#page(node.children[index]);
    }
    return { leaf: node, ancestors };
  }

  // ----- public API --------------------------------------------------------

  get size(): number {
    return this.#count;
  }

  /** duplicate keys replace the existing value (upsert) */
  insert(key: K, value: V): void {
    const { leaf, ancestors } = this.#findLeaf(key);

    let at = 0;
    while (at < leaf.entries.length && this.#cmp(leaf.entries[at].key, key) < 0) at++;

    if (at < leaf.entries.length && this.#cmp(leaf.entries[at].key, key) === 0) {
      leaf.entries[at].value = value;
      return;
    }

    leaf.entries.splice(at, 0, { key, value });
    this.#count++;

    // separator sync: if the new entry became the leaf's minimum, every
    // routing key that reaches this subtree may have to follow it
    if (at === 0 && leaf.parent !== null) {
      this.#propagateMinimum(ancestors, key);
    }

    if (leaf.entries.length > this.order) {
      this.#split(leaf, ancestors);
    }
  }

  get(key: K): V | undefined {
    const { leaf } = this.#findLeaf(key);
    const at = leaf.entries.findIndex((e) => this.#cmp(e.key, key) === 0);
    return at >= 0 ? leaf.entries[at].value : undefined;
  }

  has(key: K): boolean {
    const { leaf } = this.#findLeaf(key);
    return leaf.entries.some((e) => this.#cmp(e.key, key) === 0);
  }

  /** @returns false when the key was never present (structure untouched) */
  delete(key: K): boolean {
    const { leaf, ancestors } = this.#findLeaf(key);
    const at = leaf.entries.findIndex((e) => this.#cmp(e.key, key) === 0);
    if (at < 0) return false;

    leaf.entries.splice(at, 1);
    this.#count--;

    if (at === 0 && leaf.parent !== null && leaf.entries.length > 0) {
      // the routing key may have changed; push the new minimum up, possibly
      // through several leftmost-child frames
      this.#propagateMinimum(ancestors, leaf.entries[0].key);
    }

    if (leaf.parent !== null && leaf.entries.length < this.minLeaf) {
      this.#repair(leaf.id, ancestors);
    }
    return true;
  }

  /** inclusive range scan along the leaf chain */
  range(start: K, end: K): { key: K; value: V }[] {
    let leaf: LeafPage<K, V> | null = this.#leftmostLeaf();
    const out: Entry<K, V>[] = [];
    while (leaf) {
      for (const e of leaf.entries) {
        if (this.#cmp(e.key, start) >= 0 && this.#cmp(e.key, end) <= 0) out.push(e);
      }
      leaf = leaf.next === null ? null : this.#leaf(leaf.next);
    }
    return out.map((e) => ({ key: e.key, value: e.value }));
  }

  keys(): K[] {
    return this.#allLeaves().flatMap((l) => l.entries.map((e) => e.key));
  }

  values(): V[] {
    return this.#allLeaves().flatMap((l) => l.entries.map((e) => e.value));
  }

  clear(): void {
    this.#pages.clear();
    this.#free.length = 0;
    this.#nextId = 0;
    this.#reused = 0;
    this.#count = 0;
    this.events.length = 0;
    this.#root = this.#newLeaf();
  }

  stats(): BTreeStats {
    return {
      allocated: this.#nextId,
      reused: this.#reused,
      livePages: this.#pages.size,
      freePages: this.#free.length,
      depth: this.depth(),
    };
  }

  // ----- structural operations --------------------------------------------

  /**
   * The minimum routing key of a subtree has changed to `key` (the affected
   * leaf's new first entry).  Walk the ancestor frames bottom-up: while the
   * descent kept taking the leftmost child (index 0) the change keeps
   * propagating; at the first frame with index > 0 rewrite its separator.
   */
  #propagateMinimum(ancestors: AncestorFrame<K>[], key: K): void {
    for (let lvl = ancestors.length - 1; lvl >= 0; lvl--) {
      const frame = ancestors[lvl];
      if (frame.index === 0) continue;
      frame.page.keys[frame.index - 1] = key;
      return;
    }
  }

  #minimumKeyOfSubtree(node: InternalPage<K>): K {
    let cur: Page<K, V> = node;
    while (cur.kind === 'internal') cur = this.#page(cur.children[0]);
    return cur.entries[0].key;
  }

  /** split an overfull leaf or internal node, propagating upwards */
  #split(child: Page<K, V>, ancestors: AncestorFrame<K>[]): void {
    if (child.kind === 'leaf') this.#splitLeaf(child, ancestors);
    else this.#splitInternal(child, ancestors);
  }

  #splitLeaf(leaf: LeafPage<K, V>, ancestors: AncestorFrame<K>[]): void {
    const at = Math.floor((leaf.entries.length + 1) / 2);
    const right = this.#leaf(this.#newLeaf());
    right.entries = leaf.entries.splice(at);
    // splice `right` between `leaf` and its old successor
    this.#linkAfterSplit(leaf.id, right.id);

    const sep = right.entries[0].key;
    const level = ancestors.length;
    this.#insertIntoParent(leaf.id, sep, right.id, ancestors);
    this.events.push({ type: 'split', left: leaf.id, right: right.id, level });
  }

  /** splice `rightId` into the leaf chain immediately after `leftId` */
  #linkAfterSplit(leftId: PageId, rightId: PageId): void {
    const left = this.#leaf(leftId);
    const right = this.#leaf(rightId);
    const after = left.next === null ? null : this.#leaf(left.next);
    left.next = right.id;
    right.prev = left.id;
    right.next = after ? after.id : null;
    if (after) after.prev = right.id;
  }

  #splitInternal(node: InternalPage<K>, ancestors: AncestorFrame<K>[]): void {
    const at = Math.floor(node.keys.length / 2);
    const upKey = node.keys[at];
    const right = this.#internal(this.#newInternal());
    right.keys = node.keys.splice(at + 1);
    right.children = node.children.splice(at + 1);
    node.keys.length = at;
    for (const cid of right.children) this.#page(cid).parent = right.id;

    const level = ancestors.length;
    this.#insertIntoParent(node.id, upKey, right.id, ancestors);
    this.events.push({ type: 'split', left: node.id, right: right.id, level });
  }

  /**
   * Insert (separator, rightChild) right after leftChild in its parent.
   * Splits the parent in turn if it overflows; builds a new root at the top.
   */
  #insertIntoParent(
    leftId: PageId,
    sep: K,
    rightId: PageId,
    ancestors: AncestorFrame<K>[],
  ): void {
    const frame = ancestors.pop();
    if (!frame) {
      this.#makeNewRoot(leftId, sep, rightId);
      return;
    }
    const parent = frame.page;
    const i = frame.index;
    parent.keys.splice(i, 0, sep);
    parent.children.splice(i + 1, 0, rightId);
    this.#page(rightId).parent = parent.id;

    if (parent.children.length > this.order + 1) {
      // i.e. parent.keys.length > order
      this.#split(parent, ancestors);
    }
  }

  #makeNewRoot(leftId: PageId, sep: K, rightId: PageId): void {
    const root = this.#internal(this.#newInternal());
    root.keys = [sep];
    root.children = [leftId, rightId];
    this.#page(leftId).parent = root.id;
    this.#page(rightId).parent = root.id;
    this.#root = root.id;
  }

  /**
   * Fix an underflowing non-root node by borrowing or merging, then recurse
   * up the ancestor stack.  Collapses a non-leaf root with one child.
   */
  #repair(startId: PageId, startAncestors: AncestorFrame<K>[]): void {
    let id = startId;
    const ancestors = startAncestors;

    while (ancestors.length > 0) {
      const frame = ancestors[ancestors.length - 1];
      const parent = frame.page;
      const i = parent.children.indexOf(id);
      if (i < 0) throw new Error('ancestor stack does not lead to child');
      const node = this.#page(id);
      const min = node.kind === 'leaf' ? this.minLeaf : this.minInternal;
      const size = node.kind === 'leaf' ? node.entries.length : node.keys.length;
      if (size >= min) return;

      const left = i > 0 ? this.#page(parent.children[i - 1]) : null;
      const right = i < parent.children.length - 1 ? this.#page(parent.children[i + 1]) : null;
      const leftRich =
        left !== null &&
        (left.kind === 'leaf'
          ? left.entries.length > this.minLeaf
          : left.keys.length > this.minInternal);
      const rightRich =
        right !== null &&
        (right.kind === 'leaf'
          ? right.entries.length > this.minLeaf
          : right.keys.length > this.minInternal);

      if (leftRich) {
        this.#borrowFromLeft(node, left as Page<K, V>, parent, i);
        this.events.push({
          type: 'borrow-left',
          page: id,
          from: left!.id,
          level: ancestors.length,
        });
        return; // borrowing fills us without shrinking the parent
      }
      if (rightRich) {
        this.#borrowFromRight(node, right as Page<K, V>, parent, i);
        this.events.push({
          type: 'borrow-right',
          page: id,
          from: right!.id,
          level: ancestors.length,
        });
        return;
      }

      // neither sibling can spare an item: merge, preferring the left side
      if (left) {
        const { survivor, removed } = this.#mergeChildren(parent, i - 1);
        this.events.push({
          type: 'merge-left',
          survivor,
          removed,
          level: this.#depthOf(parent.id),
        });
        id = this.#afterMerge(parent, ancestors, i - 1);
      } else {
        const { survivor, removed } = this.#mergeChildren(parent, i);
        this.events.push({
          type: 'merge-right',
          survivor,
          removed,
          level: this.#depthOf(parent.id),
        });
        id = this.#afterMerge(parent, ancestors, i);
      }
      // loop: the parent (or what became of it) may now underflow itself
    }

    this.#collapseRootIfNeeded();
  }

  /** move one item from `from` (at parent index i-1) into `node` (index i) */
  #borrowFromLeft(node: Page<K, V>, from: Page<K, V>, parent: InternalPage<K>, i: number): void {
    if (node.kind === 'leaf' && from.kind === 'leaf') {
      const item = from.entries.pop()!;
      node.entries.unshift(item);
      // leaf-chain links already connect them in order; nothing to re-link
      parent.keys[i - 1] = node.entries[0].key;
    } else if (node.kind === 'internal' && from.kind === 'internal') {
      const sep = parent.keys[i - 1];
      const movedChild = from.children.pop()!;
      node.keys.unshift(sep);
      node.children.unshift(movedChild);
      this.#page(movedChild).parent = node.id;
      parent.keys[i - 1] = from.keys.pop()!;
    } else {
      throw new Error('cannot borrow between leaf and internal page');
    }
  }

  /** move one item from `from` (at parent index i+1) into `node` (index i) */
  #borrowFromRight(node: Page<K, V>, from: Page<K, V>, parent: InternalPage<K>, i: number): void {
    if (node.kind === 'leaf' && from.kind === 'leaf') {
      const item = from.entries.shift()!;
      node.entries.push(item);
      parent.keys[i] = from.entries[0].key;
    } else if (node.kind === 'internal' && from.kind === 'internal') {
      const sep = parent.keys[i];
      const movedChild = from.children.shift()!;
      node.keys.push(sep);
      node.children.push(movedChild);
      this.#page(movedChild).parent = node.id;
      parent.keys[i] = from.keys.shift()!;
    } else {
      throw new Error('cannot borrow between leaf and internal page');
    }
  }

  /**
   * Merge parent.children[i] and parent.children[i+1] into the left child,
   * removing the right page and separator i.  Updates child parent refs,
   * the leaf chain and the allocator.  Returns the kept/freed page ids.
   */
  #mergeChildren(parent: InternalPage<K>, i: number): { survivor: PageId; removed: PageId } {
    const a = this.#page(parent.children[i]);
    const b = this.#page(parent.children[i + 1]);
    const sep = parent.keys[i];

    if (a.kind === 'leaf' && b.kind === 'leaf') {
      // leaves concatenate; there is no separator entry between them
      a.entries.push(...b.entries);
      a.next = b.next;
      if (b.next !== null) this.#leaf(b.next).prev = a.id;
    } else if (a.kind === 'internal' && b.kind === 'internal') {
      a.keys.push(sep, ...b.keys);
      for (const cid of b.children) this.#page(cid).parent = a.id;
      a.children.push(...b.children);
    } else {
      throw new Error('cannot merge leaf with internal page');
    }

    parent.keys.splice(i, 1);
    parent.children.splice(i + 1, 1);
    this.#releasePage(b.id);
    return { survivor: a.id, removed: b.id };
  }

  /**
   * After a merge inside `parent` at separator index `i`, keep walking up.
   * If the parent itself disappears (root with one child) returns the
   * surviving child as the new current node and pops the stack.
   */
  #afterMerge(parent: InternalPage<K>, ancestors: AncestorFrame<K>[], i: number): PageId {
    if (parent.parent === null) {
      if (parent.children.length === 1) {
        const childId = parent.children[0];
        const child = this.#page(childId);
        child.parent = null;
        this.#root = childId;
        this.events.push({ type: 'root-collapse', oldRoot: parent.id, newRoot: childId });
        this.#releasePage(parent.id);
        ancestors.pop();
        return childId;
      }
      // single-child leaf root case cannot happen here (parent is internal);
      // an internal root with >= 2 children is legal regardless of minimum
      return parent.children[Math.min(i, parent.children.length - 1)];
    }
    ancestors.pop();
    return parent.id; // the parent itself may now be under-full; loop repairs it
  }

  #collapseRootIfNeeded(): void {
    // defensive loop: collapses can cascade only when building new roots,
    // but keep folding until the root is stable
    for (;;) {
      const root = this.#page(this.#root);
      if (root.kind !== 'internal' || root.children.length !== 1) return;
      const childId = root.children[0];
      this.#page(childId).parent = null;
      this.#root = childId;
      this.events.push({ type: 'root-collapse', oldRoot: root.id, newRoot: childId });
      this.#releasePage(root.id);
    }
  }

  // ----- traversal / introspection ----------------------------------------

  #leftmostLeaf(): LeafPage<K, V> {
    let node = this.#page(this.#root);
    while (node.kind === 'internal') node = this.#page(node.children[0]);
    return node;
  }

  #allLeaves(): LeafPage<K, V>[] {
    const out: LeafPage<K, V>[] = [];
    let leaf: LeafPage<K, V> | null = this.#leftmostLeaf();
    while (leaf) {
      out.push(leaf);
      leaf = leaf.next === null ? null : this.#leaf(leaf.next);
    }
    return out;
  }

  depth(): number {
    let d = 1;
    let node = this.#page(this.#root);
    while (node.kind === 'internal') {
      d++;
      node = this.#page(node.children[0]);
    }
    return d;
  }

  #depthOf(id: PageId): number {
    let d = 0;
    let cur: Page<K, V> | undefined = this.#pages.get(id);
    while (cur && cur.parent !== null) {
      d++;
      cur = this.#pages.get(cur.parent);
    }
    return d;
  }

  /**
   * Full structural validation.  Throws on any violation of:
   *  - global ordering and per-page sorting
   *  - minimum / maximum occupancy (root exempt)
   *  - parent/child references and separator tightness
   *  - leaf prev/next chain (forward and backward)
   *  - reachable-page set == allocator live set (no dangling / leaked pages)
   *  - entry count and duplicate-key rules
   */
  validate(): void {
    const reachable = new Set<PageId>();
    let visitedEntries = 0;

    const walk = (id: PageId, expectedParent: PageId | null, lo: K | null, hi: K | null): void => {
      if (reachable.has(id)) throw new Error(`page ${id} reachable twice`);
      reachable.add(id);
      const node = this.#page(id); // throws on dangling id

      if (node.parent !== expectedParent) {
        throw new Error(`page ${id} parent ref ${node.parent} != ${expectedParent}`);
      }

      if (node.kind === 'leaf') {
        const n = node.entries.length;
        for (let k = 1; k < n; k++) {
          if (this.#cmp(node.entries[k - 1].key, node.entries[k].key) > 0) {
            throw new Error(`leaf ${id} not sorted`);
          }
        }
        if (lo !== null && n > 0 && this.#cmp(node.entries[0].key, lo) < 0) {
          throw new Error(`leaf ${id} contains key below subtree bound ${String(lo)}`);
        }
        if (hi !== null && n > 0 && this.#cmp(node.entries[n - 1].key, hi) >= 0) {
          throw new Error(`leaf ${id} contains key at/above subtree bound ${String(hi)}`);
        }
        if (n > this.order) throw new Error(`leaf ${id} overfull (${n})`);
        if (expectedParent !== null && n < this.minLeaf) {
          throw new Error(`non-root leaf ${id} underfull (${n} < ${this.minLeaf})`);
        }
        visitedEntries += n;
        return;
      }

      const nk = node.keys.length;
      const nc = node.children.length;
      if (nc < 2) throw new Error(`internal page ${id} has ${nc} children (min 2)`);
      if (nk !== nc - 1) throw new Error(`internal page ${id}: ${nk} keys vs ${nc} children`);
      if (nc > this.order + 1) throw new Error(`internal page ${id} overfull`);
      if (expectedParent !== null && nk < this.minInternal) {
        throw new Error(`non-root internal ${id} underfull (${nk} < ${this.minInternal})`);
      }
      for (let k = 1; k < nk; k++) {
        if (this.#cmp(node.keys[k - 1], node.keys[k]) >= 0) {
          throw new Error(`internal page ${id} separators not strictly sorted`);
        }
      }
      for (let k = 0; k < nc; k++) {
        const childLo = k === 0 ? lo : node.keys[k - 1];
        const childHi = k < nk ? node.keys[k] : hi;
        walk(node.children[k], id, childLo, childHi);
        // separator tightness: key[k] must equal child k+1's minimum key
        if (k < nk) {
          const child = this.#page(node.children[k + 1]);
          const minKey =
            child.kind === 'leaf'
              ? child.entries[0]?.key
              : this.#minimumKeyOfSubtree(child as InternalPage<K>);
          if (minKey === undefined || this.#cmp(minKey, node.keys[k]) !== 0) {
            throw new Error(
              `page ${id} separator ${k} (${String(node.keys[k])}) is not the minimum of child ${node.children[k + 1]} (${String(minKey)})`,
            );
          }
        }
      }
    };

    const root = this.#page(this.#root);
    if (root.parent !== null) throw new Error('root has a parent reference');
    walk(this.#root, null, null, null);

    // allocator live set must equal the reachable set (no leaks, no dangling)
    const live = new Set(this.#pages.keys());
    for (const id of live) if (!reachable.has(id)) throw new Error(`unreachable live page ${id} (leak)`);
    for (const id of reachable) if (!live.has(id)) throw new Error(`reachable id ${id} missing from allocator`);
    for (const id of this.#free) {
      if (live.has(id)) throw new Error(`freed id ${id} still live`);
      if (id < 0 || id >= this.#nextId) throw new Error(`free list holds unknown id ${id}`);
    }

    // leaf chain: forward...
    const leaves = this.#allLeaves();
    if (leaves.length === 0) throw new Error('leaf chain is empty');
    for (let i = 0; i < leaves.length - 1; i++) {
      if (leaves[i].next !== leaves[i + 1].id) {
        throw new Error(`leaf chain forward break at ${leaves[i].id}`);
      }
      if (leaves[i + 1].prev !== leaves[i].id) {
        throw new Error(`leaf chain backward break at ${leaves[i + 1].id}`);
      }
      const a = leaves[i].entries;
      const b = leaves[i + 1].entries;
      if (
        a.length > 0 &&
        b.length > 0 &&
        this.#cmp(a[a.length - 1].key, b[0].key) >= 0
      ) {
        throw new Error('leaf chain not globally sorted across boundary');
      }
    }
    if (leaves[0].prev !== null) throw new Error('first leaf has non-null prev');
    if (leaves[leaves.length - 1].next !== null) throw new Error('last leaf has non-null next');

    if (visitedEntries !== this.#count) {
      throw new Error(`entry count ${visitedEntries} != tracked size ${this.#count}`);
    }

    // global sorted key sequence (duplicates allowed only with upsert, i.e. unique)
    const allKeys = leaves.flatMap((l) => l.entries.map((e) => e.key));
    for (let k = 1; k < allKeys.length; k++) {
      if (this.#cmp(allKeys[k - 1], allKeys[k]) > 0) throw new Error('global key order violated');
      if (this.#cmp(allKeys[k - 1], allKeys[k]) === 0) throw new Error('duplicate key present');
    }
  }
}
