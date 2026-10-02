import { expect, it } from 'vitest';
import {
    evalFilter,
    JsonPathError,
    paramNames,
    parse,
    query,
    select,
    testFilter,
    update,
    type Token,
} from '../src/index.js';

const store = {
    items: [
        { id: 1, price: 5, tag: 'a', n: 0 },
        { id: 2, price: 15, tag: 'b', n: null },
        { id: 3, price: 25, tag: 'a' }, // n missing
        { id: 4, price: 35, tag: 'c', n: false },
    ],
    'odd.key': { '0': 'zero', x: 1 },
    threshold: 20,
};

// ---------------------------------------------------------------------------
// A parsed query is a reusable shape; params vary per execution
// ---------------------------------------------------------------------------

it('one saved query serves many executions with different params', () => {
    const saved = parse('$.items[?(@.price <= :max)].id');
    expect(query(store, saved, { max: 15 })).toEqual([1, 2]);
    expect(query(store, saved, { max: 30 })).toEqual([1, 2, 3]);
    expect(query(store, saved, { max: 100 })).toEqual([1, 2, 3, 4]);
    // re-running with an earlier param set gives the earlier result again
    expect(query(store, saved, { max: 15 })).toEqual([1, 2]);
    // the string form accepts the same params
    expect(query(store, '$.items[?(@.price <= :max)].id', { max: 15 })).toEqual([1, 2]);
});

it('params can decide a field or an array position', () => {
    const byKey = parse('$[:key]');
    expect(query({ a: 1, b: 2 }, byKey, { key: 'a' })).toEqual([1]);
    expect(query({ a: 1, b: 2 }, byKey, { key: 'b' })).toEqual([2]);

    const byIndex = parse('$.items[:i].id');
    expect(query(store, byIndex, { i: 0 })).toEqual([1]);
    expect(query(store, byIndex, { i: 3 })).toEqual([4]);
    // out-of-range / negative follow ordinary index semantics: missing
    expect(query(store, byIndex, { i: 9 })).toEqual([]);
    expect(query([10, 20], '$[:i]', { i: -1 })).toEqual([]);
    expect(query([10, 20, 30], '$[:i]', { i: 1 })).toEqual([20]);
});

it('param values are data only, never re-parsed as JSONPath syntax', () => {
    const doc = { '$.items': 1, 'a.b': 2, '*': 3, 'x[0]': 4 };
    const saved = parse('$[:k]');
    expect(query(doc, saved, { k: '$.items' })).toEqual([1]);
    expect(query(doc, saved, { k: 'a.b' })).toEqual([2]);
    // "*" is the field literally named "*", not a wildcard
    expect(query(doc, saved, { k: '*' })).toEqual([3]);
    expect(query(doc, saved, { k: 'x[0]' })).toEqual([4]);
    expect(query(doc, saved, { k: 'missing' })).toEqual([]);

    // injection attempt through a filter comparison stays a string compare
    const d = { rows: [{ name: 'a' }, { name: '" || true || "' }, { name: 'b' }] };
    const t = parse('$.rows[?(@.name == :q)]');
    expect(query(d, t, { q: '" || true || "' })).toEqual([{ name: '" || true || "' }]);
    expect(query(d, t, { q: 'a' })).toEqual([{ name: 'a' }]);
    expect(query(d, t, { q: '$.rows[0].name' })).toEqual([]);
});

// ---------------------------------------------------------------------------
// Missing / unusable params are locatable failures, not empty matches
// ---------------------------------------------------------------------------

it('missing params raise EPARAM with expression and document path', () => {
    const saved = parse('$.items[?(@.price <= :max)].id');
    try {
        query(store, saved);
        throw new Error('should have thrown');
    } catch (e) {
        expect(e).toBeInstanceOf(JsonPathError);
        const err = e as JsonPathError;
        expect(err.code).toBe('EPARAM');
        expect(err.expression).toBe('@.price <= :max');
        expect(err.offending).toBe(':max');
        expect(err.path).toEqual(['items', 0]);
    }
    // step position, string form: the saved path text is the expression
    try {
        query(store, '$[:k]');
        throw new Error('should have thrown');
    } catch (e) {
        const err = e as JsonPathError;
        expect(err.code).toBe('EPARAM');
        expect(err.expression).toBe('$[:k]');
        expect(err.offending).toBe(':k');
        expect(err.path).toEqual([]);
    }
    // an explicit undefined counts as not supplied
    expect(() => query(store, '$[:k]', { k: undefined })).toThrowError(JsonPathError);
    // inherited Object.prototype members are not parameters ...
    expect(() => query({ toString: 7 }, '$[:toString]')).toThrowError(JsonPathError);
    // ... but an own property with that name is
    expect(query({ toString: 7 }, '$[:toString]', { toString: 'toString' })).toEqual([7]);
});

it('params that cannot serve at a step position raise EPARAM', () => {
    for (const bad of [true, null, 1.5, NaN, {}, []]) {
        try {
            query(store, '$[:k]', { k: bad });
            throw new Error('should have thrown');
        } catch (e) {
            expect(e).toBeInstanceOf(JsonPathError);
            const err = e as JsonPathError;
            expect(err.code).toBe('EPARAM');
            expect(err.message).toContain(':k');
        }
    }
});

// ---------------------------------------------------------------------------
// Three-state semantics survive parameterization
// ---------------------------------------------------------------------------

it('param values keep missing / null / false / 0 distinct', () => {
    const eq = parse('$.items[?(@.n == :v)].id');
    expect(query(store, eq, { v: 0 })).toEqual([1]); // 0 matches 0, not null/missing
    expect(query(store, eq, { v: null })).toEqual([2]); // null matches concrete null only
    expect(query(store, eq, { v: false })).toEqual([4]);

    const ne = parse('$.items[?(@.n != :v)].id');
    // concrete non-null values; the missing-n item is still excluded
    expect(query(store, ne, { v: null })).toEqual([1, 4]);

    // a bare param tests truthiness of its value, exactly like a literal
    const d = { rows: [{ f: 0 }, { f: 1 }, {}] };
    expect(query(d, '$.rows[?(:flag)]', { flag: false })).toEqual([]);
    expect(query(d, '$.rows[?(:flag)]', { flag: 'x' })).toEqual([{ f: 0 }, { f: 1 }, {}]);
});

// ---------------------------------------------------------------------------
// query / select / update agree for the same params
// ---------------------------------------------------------------------------

it('select and update select the same nodes for the same params', () => {
    const saved = parse('$.items[?(@.price >= :min)].price');
    const params = { min: 20 };
    const sel = select(store, saved, params);
    expect(sel.map((m) => m.path)).toEqual([
        ['items', 2, 'price'],
        ['items', 3, 'price'],
    ]);
    const res = update(structuredClone(store), saved, () => 0, params);
    expect(res.changes.map((c) => c.path)).toEqual(sel.map((m) => m.path));
    expect(query(res.root, '$.items[*].price')).toEqual([5, 15, 0, 0]);
    // same saved query, other params -> other nodes
    const res2 = update(structuredClone(store), saved, () => 0, { min: 40 });
    expect(res2.changes).toHaveLength(0);
    // deletion through a param-driven filter
    const d = { list: [{ id: 1 }, { id: 2 }, { id: 3 }] };
    const r = update(d, '$.list[?(@.id == :target)]', () => undefined, { target: 2 });
    expect(r.root).toEqual({ list: [{ id: 1 }, { id: 3 }] });
});

// ---------------------------------------------------------------------------
// Concurrent / repeated executions do not pollute each other
// ---------------------------------------------------------------------------

it('interleaved executions with different params and documents stay independent', () => {
    const saved = parse('$.items[?(@.price <= :max)].id');
    const other = { items: [{ id: 9, price: 1 }, { id: 10, price: 50 }] };
    const a1 = query(store, saved, { max: 15 });
    const b1 = query(other, saved, { max: 10 });
    const a2 = query(store, saved, { max: 15 });
    expect(a1).toEqual([1, 2]);
    expect(b1).toEqual([9]);
    expect(a2).toEqual(a1);
});

it('executions do not mutate the saved tokens or the params object', () => {
    const saved = parse('$.items[?(@.price <= :max && @[:k] == :v)].id');
    const before = JSON.stringify(saved);
    const params = { max: 100, k: 'tag', v: 'a' };
    query(store, saved, params);
    select(store, saved, { max: 5, k: 'tag', v: 'b' });
    update(structuredClone(store), saved, (x) => x, { max: 100, k: 'tag', v: 'a' });
    expect(JSON.stringify(saved)).toBe(before);
    expect(params).toEqual({ max: 100, k: 'tag', v: 'a' });
});

it('a failed update leaves no residue for later executions of the saved query', () => {
    const saved = parse('$.items[?(@.price >= :min)].price');
    const d = structuredClone(store);
    expect(() =>
        update(
            d,
            saved,
            () => {
                throw new Error('boom');
            },
            { min: 20 },
        ),
    ).toThrowError('boom');
    // the failed run did not partially rewrite its document ...
    expect(query(d, '$.items[*].price')).toEqual([5, 15, 25, 35]);
    // ... and the saved query still matches purely by its own params
    expect(query(store, saved, { min: 20 })).toEqual([25, 35]);
    expect(query(store, saved, { min: 10 })).toEqual([15, 25, 35]);
});

it('error diagnostics belong to the execution that failed', () => {
    const saved = parse('$.rows[?(@.v < :lim)]');
    let err: JsonPathError | undefined;
    try {
        query({ rows: [{ v: 1 }] }, saved, { lim: 'z' });
        throw new Error('should have thrown');
    } catch (e) {
        err = e as JsonPathError;
    }
    expect(err).toBeInstanceOf(JsonPathError);
    expect(err?.code).toBe('ETYPE');
    expect(err?.expression).toBe('@.v < :lim');
    expect(err?.path).toEqual(['rows', 0]);
    // the same saved query with other params/documents is unaffected
    expect(query({ rows: [{ v: 1 }] }, saved, { lim: 2 })).toEqual([{ v: 1 }]);
    // a later failing run reports its own document location
    try {
        query({ rows: [{ v: 9 }, { v: 'x' }] }, saved, { lim: 2 });
        throw new Error('should have thrown');
    } catch (e) {
        expect((e as JsonPathError).path).toEqual(['rows', 1]);
    }
});

// ---------------------------------------------------------------------------
// Existing syntax keeps working alongside placeholders
// ---------------------------------------------------------------------------

it('quoted field names and filters mix with params', () => {
    expect(query(store, "$['odd.key']['0']")).toEqual(['zero']);
    expect(query(store, "$['odd.key'][:k]", { k: 'x' })).toEqual([1]);
    const saved = parse("$.items[?(@['tag'] == :tag)].id");
    expect(query(store, saved, { tag: 'a' })).toEqual([1, 3]);
});

it('param steps work inside filter paths, including $ root paths', () => {
    const saved = parse('$.items[?(@[:k] == :v)].id');
    expect(query(store, saved, { k: 'tag', v: 'a' })).toEqual([1, 3]);
    expect(query(store, saved, { k: 'price', v: 15 })).toEqual([2]);
    expect(query(store, saved, { k: 'n', v: null })).toEqual([2]);

    const d = { lim: 2, rows: [{ n: 1 }, { n: 5 }] };
    expect(query(d, '$.rows[?(@.n > $[:k])].n', { k: 'lim' })).toEqual([5]);
});

it('evalFilter / testFilter accept params', () => {
    expect(testFilter('@.n > :min', { root: {}, current: { n: 3 } }, { min: 2 })).toBe(true);
    expect(evalFilter(':v', { root: {} }, { v: null })).toMatchObject({ state: 'null' });
    expect(evalFilter(':v', { root: {} }, { v: 0 })).toMatchObject({
        state: 'concrete',
        value: 0,
    });
    expect(() => testFilter('@.n > :min', { root: {}, current: { n: 3 } })).toThrowError(
        JsonPathError,
    );
});

// ---------------------------------------------------------------------------
// Introspection, serialization, and old call shapes
// ---------------------------------------------------------------------------

it('paramNames lists the placeholders of a saved query in first-use order', () => {
    expect(paramNames('$.items[?(@.price <= :max && @.tag == :tag)][:i]')).toEqual([
        'max',
        'tag',
        'i',
    ]);
    expect(paramNames(parse('$[:k].x'))).toEqual(['k']);
    expect(paramNames(parse('$.a'))).toEqual([]);
});

it('saved tokens survive a JSON round-trip (serializable saved queries)', () => {
    const saved = parse('$.items[?(@.price <= :max)].id');
    const revived = JSON.parse(JSON.stringify(saved)) as Token[];
    expect(query(store, revived, { max: 15 })).toEqual([1, 2]);
    const byKey = JSON.parse(JSON.stringify(parse('$[:k]'))) as Token[];
    expect(query({ a: 1 }, byKey, { k: 'a' })).toEqual([1]);
});

it('old call shapes are unchanged', () => {
    expect(query(store, '$.items[*].id')).toEqual([1, 2, 3, 4]);
    expect(query(store, parse('$.items[*].id'))).toEqual([1, 2, 3, 4]);
    expect(query(store, '$.items[*].id', {})).toEqual([1, 2, 3, 4]);
    expect(query(store, '$.items[?(@.price > $.threshold)].id')).toEqual([3, 4]);
});

it('malformed placeholders are parse errors', () => {
    expect(() => parse('$[:]')).toThrowError(JsonPathError);
    expect(() => parse('$[:1bad]')).toThrowError(JsonPathError);
    expect(() => query({}, '$.a[?(@.x == :)]')).toThrowError(JsonPathError);
});

it('async callers can share one saved query concurrently', async () => {
    const saved = parse('$.items[?(@.price <= :max)].id');
    const runs = await Promise.all([
        Promise.resolve().then(() => query(store, saved, { max: 15 })),
        Promise.resolve().then(() => query(store, saved, { max: 30 })),
        Promise.resolve().then(() => select(store, saved, { max: 25 })),
    ]);
    expect(runs[0]).toEqual([1, 2]);
    expect(runs[1]).toEqual([1, 2, 3]);
    expect(runs[2].map((m) => m.value)).toEqual([1, 2, 3]);
});
