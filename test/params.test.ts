import { expect, it } from 'vitest';
import {
    compile,
    evalFilter,
    JsonPathError,
    parse,
    query,
    select,
    testFilter,
    update,
} from '../src/index.js';

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

const data = {
    threshold: 1,
    items: [
        { id: 1, price: 5, tag: 'a.b', enabled: false },
        { id: 2, price: 10, tag: '$[*]', enabled: true },
        { id: 3, price: null, tag: 'x', enabled: null },
        { id: 4 /* price/tag missing */ },
    ],
    byKey: { 'we"ird': 7, 'a.b': 8, '0': 'zero' },
};

function expectJsonPathError(fn: () => unknown): JsonPathError {
    try {
        fn();
        throw new Error('expected JsonPathError');
    } catch (e) {
        expect(e).toBeInstanceOf(JsonPathError);
        return e as JsonPathError;
    }
}

// ---------------------------------------------------------------------------
// compile(): reusable structure, parameters are execution-time values
// ---------------------------------------------------------------------------

it('a saved query executes repeatedly with different parameters', () => {
    const saved = compile('$.items[?(@.price > :min)].id');
    expect(query(data, saved, { min: 4 })).toEqual([1, 2]);
    expect(query(data, saved, { min: 6 })).toEqual([2]);
    expect(query(data, saved, { min: 100 })).toEqual([]);
    // the compiled object is unchanged and still reusable
    expect(saved.source).toBe('$.items[?(@.price > :min)].id');
    expect(query(data, saved, { min: 4 })).toEqual([1, 2]);
});

it('bind() attaches a copied parameter map; call params take precedence', () => {
    const saved = compile('$.items[?(@.price > :min)].id');
    const over6 = saved.bind({ min: 6 });
    expect(query(data, over6)).toEqual([2]);
    // a bound query is reusable too, and per-call params win
    expect(query(data, over6, { min: 4 })).toEqual([1, 2]);
    expect(query(data, over6)).toEqual([2]);
    // bind merges over earlier bindings
    const also = saved.bind({ min: 6 }).bind({ min: 0 });
    expect(query(data, also)).toEqual([1, 2]);
});

it('parameter values are never re-parsed as JSONPath syntax', () => {
    const saved = compile('$.items[?(@.tag == :need)].id');
    // quotes and path punctuation are ordinary characters of the value
    expect(query(data, saved, { need: 'a.b' })).toEqual([1]);
    expect(query(data, saved, { need: '$[*]' })).toEqual([2]);
    expect(query(data, saved, { need: '"quoted"' })).toEqual([]);
    // a value used as a field name: embedded quote does not break the segment
    expect(query(data, compile('$.byKey[:k]'), { k: 'we"ird' })).toEqual([7]);
    expect(query(data, compile('$.byKey[:k]'), { k: 'a.b' })).toEqual([8]);
});

it('parameters decide field names and array positions as bracket segments', () => {
    const fieldQ = compile('$.byKey[:k]');
    expect(query(data, fieldQ, { k: 'a.b' })).toEqual([8]);
    const idxQ = compile('$.items[:i].id');
    expect(query(data, idxQ, { i: 0 })).toEqual([1]);
    expect(query(data, idxQ, { i: 3 })).toEqual([4]);
    // negative / out-of-range integer mirrors the fixed-index semantics:
    // a missing result, not an error and not a wrap-around
    expect(select(data, idxQ, { i: -1 })).toMatchObject([{ present: false, path: ['items', -1, 'id'] }]);
    expect(select(data, idxQ, { i: 9 })).toMatchObject([{ present: false, path: ['items', 9, 'id'] }]);
    // integer parameter on an object reads the matching string key
    expect(query(data, compile('$.byKey[:i]'), { i: 0 })).toEqual(['zero']);
});

it('parameter segments work inside filter paths', () => {
    const d = { rows: [{ v: { k: 9 } }, { v: { other: 1 } }] };
    expect(query(d, '$.rows[?(@.v[:name])].v', { name: 'k' }).map((v) => (v as { k: number }).k)).toEqual([
        9,
    ]);
    // the same parameter drives navigation on the root value inside a filter
    expect(query(d, '$.rows[?(@.v[:name] == :want)]', { name: 'k', want: 9 })).toEqual([
        { v: { k: 9 } },
    ]);
});

it('accepts placeholders passed through a raw string or parsed Token[] too', () => {
    expect(query(data, '$.items[?(@.price > :min)].id', { min: 6 })).toEqual([2]);
    const tokens = parse('$.items[:i].id');
    expect(tokens.some((t) => t.kind === 'param')).toBe(true);
    expect(query(data, tokens, { i: 1 })).toEqual([2]);
});

// ---------------------------------------------------------------------------
// Three-state values: missing parameter != null != concrete falsy values
// ---------------------------------------------------------------------------

it('null / false / 0 / "" parameters stay distinct from a missing parameter', () => {
    // bare parameter: literals go through truthiness, but null/false/0 are
    // still PROVIDED (they never surface as a missing-parameter failure)
    expect(testFilter(':f', { root: {}, params: { f: false } })).toBe(false);
    expect(testFilter(':f', { root: {}, params: { f: 0 } })).toBe(false);
    expect(testFilter(':f', { root: {}, params: { f: '' } })).toBe(false);
    expect(testFilter(':f', { root: {}, params: { f: null } })).toBe(false);
    expect(testFilter(':f', { root: {}, params: { f: [] } })).toBe(true);

    // evalFilter exposes the exact states
    expect(evalFilter(':f', { root: {}, params: { f: null } })).toMatchObject({ state: 'null' });
    expect(evalFilter(':f', { root: {}, params: { f: false } })).toMatchObject({
        state: 'concrete',
        value: false,
    });
    expect(evalFilter(':f', { root: {}, params: { f: 0 } })).toMatchObject({
        state: 'concrete',
        value: 0,
    });
});

it('equality against a parameter preserves the three-state model', () => {
    const saved = compile('$.items[?(@.price == :p)].id');
    // explicit null parameter matches the concrete-null item only, not the
    // item where price is missing
    expect(query(data, saved, { p: null })).toEqual([3]);
    // false is a concrete value and never collapses onto null/missing
    expect(query(data, '$.items[?(@.enabled == :e)].id', { e: false })).toEqual([1]);
    expect(query(data, '$.items[?(@.enabled == :e)].id', { e: null })).toEqual([3]);
});

it('missing parameters are located EPARAM failures, never silent empty matches', () => {
    const saved = compile('$.items[?(@.price > :min)].id');
    const err = expectJsonPathError(() => query(data, saved, {}));
    expect(err.code).toBe('EPARAM');
    // the diagnostic points back at the saved filter expression ...
    expect(err.expression).toBe('@.price > :min');
    expect(err.offending).toBe(':min');
    // ... and at the document element being filtered when it occurred
    expect(err.path).toEqual(['items', 0]);

    // top-level segment placeholder
    const err2 = expectJsonPathError(() => query(data, '$.items[:i].id'));
    expect(err2.code).toBe('EPARAM');
    expect(err2.expression).toBe('$.items[:i].id');
    expect(err2.offending).toBe(':i');
    expect(err2.path).toEqual(['items']);

    // explicit undefined counts as not supplied
    const err3 = expectJsonPathError(() =>
        query(data, saved, { min: undefined as unknown as number }),
    );
    expect(err3.code).toBe('EPARAM');

    // a missing parameter under a false-ish branch is never reached thanks
    // to the existing short-circuit evaluation
    expect(testFilter('false && :nope', { root: {}, params: {} })).toBe(false);
    expect(testFilter('true || :nope', { root: {}, params: {} })).toBe(true);
});

it('parameters unusable at a field/index position are located EPARAM failures', () => {
    for (const bad of [null, false, true, 1.5, {}, []]) {
        const err = expectJsonPathError(() => query(data, '$.items[:i].id', { i: bad }));
        expect(err.code).toBe('EPARAM');
        expect(err.expression).toBe('$.items[:i].id');
        expect(err.path).toEqual(['items']);
    }
    // a string IS a valid field; on an array it follows the existing
    // "array + named field -> missing" rule rather than becoming an index
    expect(query(data, '$.items[:i].id', { i: 'str-but-on-array' })).toEqual([]);
    // missing value at a segment slot is equally an error, not empty
    const err = expectJsonPathError(() => query(data, '$.byKey[:k]'));
    expect(err.code).toBe('EPARAM');
    expect(err.path).toEqual(['byKey']);
});

it('document type errors with parameters stay ETYPE with a document path', () => {
    // the parameter (a valid field name) resolves fine; navigating that
    // field off a concrete number is the document's type error
    const err = expectJsonPathError(() =>
        query({ items: [5] }, '$.items[0][:k]', { k: 'x' }),
    );
    expect(err.code).toBe('ETYPE');
    expect(err.path).toEqual(['items', 0]);
});

it('malformed parameter placeholders are parse errors', () => {
    expect(() => compile('$.:x')).toThrowError(JsonPathError);
    expect(() => compile('$.items[:]')).toThrowError(JsonPathError);
    expect(() => compile('$.items[?(:)]')).toThrowError(JsonPathError);
});

// ---------------------------------------------------------------------------
// query / select / update consistency with the same parameters
// ---------------------------------------------------------------------------

it('select, query and update select the same nodes for one parameter set', () => {
    const saved = compile('$.items[?(@.price > :min)].id');
    const d = structuredClone(data);
    const expectedPaths = [
        ['items', 0, 'id'],
        ['items', 1, 'id'],
    ];
    expect(query(data, saved, { min: 4 })).toEqual([1, 2]);
    expect(select(data, saved, { min: 4 }).map((m) => m.path)).toEqual(expectedPaths);

    const r = update(d, saved, () => 99, { min: 4 });
    expect(r.changes.map((c) => c.path)).toEqual(expectedPaths);
    expect(query(r.root, '$.items[*].id')).toEqual([99, 99, 3, 4]);

    // and with a bound query
    const bound = saved.bind({ min: 6 });
    const d2 = structuredClone(data);
    expect(select(data, bound).map((m) => m.path)).toEqual([['items', 1, 'id']]);
    const r2 = update(d2, bound, () => 0);
    expect(r2.changes.map((c) => c.path)).toEqual([['items', 1, 'id']]);
});

it('a throwing replacer leaves no residue for later parameterized executions', () => {
    const saved = compile('$.items[?(@.price > :min)].id');
    const d = structuredClone(data);
    expect(() =>
        update(d, saved, () => {
            throw new Error('boom');
        }, { min: 4 }),
    ).toThrow('boom');
    // later execution against the shared saved query is unaffected
    expect(query(data, saved, { min: 4 })).toEqual([1, 2]);
    expect(query(data, saved, { min: 6 })).toEqual([2]);
});

// ---------------------------------------------------------------------------
// Isolation: one saved query, many requests, roots and parameter sets
// ---------------------------------------------------------------------------

it('concurrent executions of one saved query never share state', async () => {
    const saved = compile('$.items[?(@.price > :min)].id');
    const docA = { items: [{ id: 'a1', price: 1 }, { id: 'a2', price: 50 }] };
    const docB = { items: [{ id: 'b1', price: 10 }, { id: 'b2', price: 5 }] };

    const runs = Array.from({ length: 50 }, (_, i) =>
        Promise.resolve().then(async () => {
            // interleave: yield before and after evaluation
            await Promise.resolve();
            const root = i % 2 === 0 ? docA : docB;
            const min = i % 2 === 0 ? 10 : 7;
            const got = query(root, saved, { min });
            await Promise.resolve();
            if (i % 2 === 0) expect(got).toEqual(['a2']);
            else expect(got).toEqual(['b1']);
        }),
    );
    await Promise.all(runs);

    // re-entrant use from inside an update replacer, with different params
    // and a different root, must not perturb the outer execution's matches
    const outer = structuredClone(docA);
    const seen: (string | number)[][] = [];
    update(
        outer,
        saved,
        (v, p) => {
            seen.push(p);
            // nested execution on another document with other parameters
            expect(query(docB, saved, { min: 7 })).toEqual(['b1']);
            return v;
        },
        { min: 10 },
    );
    expect(seen).toEqual([['items', 1, 'id']]);
});

it('per-call parameters merge over bound parameters without mutating them', () => {
    const d = {
        items: [
            { id: 1, price: 1, tag: 'a' },
            { id: 2, price: 9, tag: 'b' },
        ],
    };
    const saved = compile('$.items[?(@.price > :min && @.tag == :tag)].id');
    const bound = saved.bind({ min: 0, tag: 'a' });
    expect(query(d, bound)).toEqual([1]);
    // override only one of the two; the other still comes from the binding
    expect(query(d, bound, { tag: 'b' })).toEqual([2]);
    // original binding intact
    expect(query(d, bound)).toEqual([1]);
    // params object handed in is never retained
    const mutable = { min: 0, tag: 'a' };
    query(d, saved, mutable);
    mutable.min = 1000;
    expect(query(d, saved, { min: 0, tag: 'a' })).toEqual([1]);
});

// ---------------------------------------------------------------------------
// Backwards compatibility: strings, Token[], quoted names, quoted filters
// ---------------------------------------------------------------------------

it('old string and Token[] calls behave exactly as before', () => {
    expect(query({ a: 1 }, parse('$.a'))).toEqual([1]);
    expect(query(data, '$.items[?(@.enabled)].id')).toEqual([1, 2, 3]);
    expect(select(data, '$.items[*].enabled')).toHaveLength(4);
});

it('quoted field names and quoted filter literals still parse alongside params', () => {
    expect(query(data, `$['byKey']['we"ird']`)).toEqual([7]);
    expect(query(data, `$.byKey["a.b"]`)).toEqual([8]);
    // quoted string literal inside a filter with an adjacent parameter:
    // item 3 (tag "x") passes only when the threshold admits its null price?
    // no — null ordering is Nothing; lower the threshold using a concrete
    // item instead to prove both literals coexist in one expression
    const d = { items: [{ tag: 'x', price: 5 }, { tag: 'x', price: 1 }] };
    const saved = compile('$.items[?(@.tag == "x" && @.price > :min)].price');
    expect(query(d, saved, { min: 2 })).toEqual([5]);
    // a quote character inside a parameter value stays data, not syntax
    const qd = { items: [{ tag: 'he said "hi"' }] };
    expect(query(qd, compile('$.items[?(@.tag == :t)].tag'), { t: `he said "hi"` })).toEqual([
        'he said "hi"',
    ]);
});
