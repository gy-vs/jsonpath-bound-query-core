# JSONPath Engine

Run `npm install`, `npm test`, and `npm run build`.

## Parameterized queries

A query can be parsed once and executed many times with different values.
Placeholders are written `:name` and become part of the parsed token/AST
form — they are never string-interpolated:

```ts
import { parse, query, select, update } from 'jsonpath-filter-core';

const saved = parse('$.items[?(@.price <= :max)][:field]');

query(doc, saved, { max: 100, field: 'id' });   // one execution
select(doc, saved, { max: 20, field: 'sku' });  // another, same saved query
update(doc, saved, replacer, { max: 20, field: 'sku' }); // same matches as select
```

- **Filter position** (`$.items[?(@.price <= :max)]`) accepts any JSON value.
- **Step position** (`$[:key]`, `$.items[:i]`, `@[:k]`) accepts a string
  (field name) or an integer (array index).

A parameter value is data only: even when it looks like JSONPath syntax
(`"*"`, `"a.b"`, `"$..x"`) it selects nothing but itself. Missing
parameters and values that cannot serve at their position raise
`JsonPathError` with code `EPARAM`, carrying the saved expression and the
document path of the failing execution — they never silently yield empty
matches. `paramNames(path)` lists the placeholders a saved query declares.

Evaluation keeps no shared state: one parsed query can serve concurrent
executions with different documents and different parameters, and parsed
tokens survive `JSON.stringify`/`JSON.parse` for storage.
