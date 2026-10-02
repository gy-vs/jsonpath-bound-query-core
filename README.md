# JSONPath Engine

Run `npm install`, `npm test`, and `npm run build`.

## Saved (compiled) queries with execution-time parameters

`compile(path)` parses a JSONPath once into a structure you can reuse across
requests and documents. Placeholders named `:name` are part of the query
structure; their values are supplied at execution time as plain JS values and
are **never parsed as JSONPath**, so quotes or path punctuation inside a
parameter cannot change what the query means.

```ts
import { compile, query, select, update } from './src/index.js';

const byPrice = compile('$.items[?(@.price > :min)].id');

query(docA, byPrice, { min: 10 });        // parameters per execution
const bound = byPrice.bind({ min: 10 });  // parameters fixed once
query(docB, bound);
query(docB, bound, { min: 0 });           // per-call params win over bound ones
```

Placeholders are accepted:

- as filter operands: `[?(@.price > :min)]`, `[?(@.tag == :need)]`, bare `:flag`;
- as bracket segments at the top level and inside filter paths: `$.byKey[:k]`,
  `@.items[:idx]`.

A string parameter selects a field; an integer parameter selects an array
index (negative / out-of-range gives a missing result, exactly like a fixed
index). `null`, booleans, fractions, objects and arrays cannot occupy a
field/index slot and raise a located `EPARAM` error.

Parameter values preserve the three-state model:

- not supplied (or explicitly `undefined`) → `EPARAM` failure, never a silent
  empty match;
- `null` → the NULL state (`:p == null` matches only actual nulls);
- `false` / `0` / `""` → concrete values, never confused with "missing".

`query`, `select` and `update` share one evaluator and accept the same
compiled/bound query plus the same parameters, so they always select the same
nodes. A compiled query keeps no mutable per-execution state: concurrent
executions on different roots with different parameters (including re-entrant
calls inside an `update` replacer) cannot interfere, and a failing replacer
leaves nothing behind. Errors are still `JsonPathError` instances carrying
`code`, the saved `expression`/`offending` text, and the absolute document
`path` where the failure occurred.

Plain strings and pre-parsed `Token[]` remain accepted everywhere, exactly as
before:

```ts
query(doc, '$.items[?(@.x > 1)]');
query(doc, parse('$.items[?(@.x > 1)]'));
query(doc, '$.items[?(@.x > :min)]', { min: 1 });
```
