# B-tree index core

Paged B+tree with complete delete-time rebalancing.

Run `npm install`, then `npm test` and `npm run build`.

## Operations

Every structural mutation keeps four things in sync atomically:

1. the parent's separator key (tight routing keys — a separator always equals
   the minimum key reachable in the child it points at);
2. child pages' `parent` references;
3. the leaf `prev`/`next` chain;
4. the page allocator (freed pages go on a free list and their ids are reused
   before fresh ids are minted).

The rebalance path starts at the affected leaf and walks the ancestor stack:

- **borrow left** — take the last item of the left sibling; rotate the parent
  separator down and the left sibling's new routing key up;
- **borrow right** — symmetric, taking the first item of the right sibling;
- **merge left / merge right** — when neither sibling can spare an item,
  concatenate two leaves (or two internal children around their separator),
  remove the right page from the parent and release it to the free list;
- **root collapse** — after a merge leaves a non-leaf root with exactly one
  child, that child becomes the new root. Collapse cascades level by level
  while draining a tree.

The root is exempt from minimum occupancy (a root leaf may be nearly empty),
but an internal root with a single child is never legal and is always folded.

## API

```ts
const t = new BTree<number, number>({ order: 4, compare: (a, b) => a - b });
t.insert(1, 10);   // duplicate keys upsert
t.get(1);          // 10
t.has(1);          // true
t.delete(1);       // false when the key is absent (structure untouched)
t.range(0, 9);     // inclusive scan along the leaf chain
t.keys(); t.values(); t.size;
t.stats();         // { allocated, reused, livePages, freePages, depth }
t.validate();      // throws on any structural invariant violation
t.clear();
```

`validate()` checks global and per-page ordering, min/max occupancy (root
exempt), every parent/child reference, separator tightness, the leaf chain in
both directions, entry counts and that the allocator live set is exactly the
set of reachable pages (no dangling or leaked pages). The default key type is
`string`; pass `compare` for other key types.
