/**
 * Fun-FP-JS - Functional Programming Library
 * Built: 2026-01-27T14:26:13.582Z
 * Static Land specification compliant
 */
const polyfills = {
    array: {
        flatMap: Array.prototype.flatMap
            ? (f, arr) => arr.flatMap(f)
            : (f, arr) => arr.reduce((acc, x) => acc.concat(f(x)), [])
    },
    object: {
        fromEntries: Object.fromEntries
            ? entries => Object.fromEntries(entries)
            : entries => entries.reduce((obj, [k, v]) => (obj[k] = v, obj), {}),
        entries: Object.entries
            ? obj => Object.entries(obj)
            : obj => Object.keys(obj).map(k => [k, obj[k]]),
        values: Object.values
            ? obj => Object.values(obj)
            : obj => Object.keys(obj).map(k => obj[k]),
        filter: (pred, obj) => polyfills.object.fromEntries(
            polyfills.object.entries(obj).filter(([k, v]) => pred(v, k))
        )
    }
};
const Symbols = {
    Algebra: Symbol.for('fun-fp-js/Algebra'),
    Setoid: Symbol.for('fun-fp-js/Setoid'),
    Ord: Symbol.for('fun-fp-js/Ord'),
    Semigroup: Symbol.for('fun-fp-js/Semigroup'),
    Monoid: Symbol.for('fun-fp-js/Monoid'),
    Group: Symbol.for('fun-fp-js/Group'),
    Semigroupoid: Symbol.for('fun-fp-js/Semigroupoid'),
    Category: Symbol.for('fun-fp-js/Category'),
    Filterable: Symbol.for('fun-fp-js/Filterable'),
    Functor: Symbol.for('fun-fp-js/Functor'),
    Bifunctor: Symbol.for('fun-fp-js/Bifunctor'),
    Contravariant: Symbol.for('fun-fp-js/Contravariant'),
    Profunctor: Symbol.for('fun-fp-js/Profunctor'),
    Apply: Symbol.for('fun-fp-js/Apply'),
    Applicative: Symbol.for('fun-fp-js/Applicative'),
    Alt: Symbol.for('fun-fp-js/Alt'),
    Plus: Symbol.for('fun-fp-js/Plus'),
    Alternative: Symbol.for('fun-fp-js/Alternative'),
    Chain: Symbol.for('fun-fp-js/Chain'),
    ChainRec: Symbol.for('fun-fp-js/ChainRec'),
    Monad: Symbol.for('fun-fp-js/Monad'),
    Foldable: Symbol.for('fun-fp-js/Foldable'),
    Extend: Symbol.for('fun-fp-js/Extend'),
    Comonad: Symbol.for('fun-fp-js/Comonad'),
    Traversable: Symbol.for('fun-fp-js/Traversable'),
    Maybe: Symbol.for('fun-fp-js/Maybe'),
    Either: Symbol.for('fun-fp-js/Either'),
    Task: Symbol.for('fun-fp-js/Task'),
    Free: Symbol.for('fun-fp-js/Free'),
    Pure: Symbol.for('fun-fp-js/Pure'),
    Impure: Symbol.for('fun-fp-js/Impure'),
    Reduced: Symbol.for('fun-fp-js/Reduced'),
    Validation: Symbol.for('fun-fp-js/Validation'),
    Reader: Symbol.for('fun-fp-js/Reader'),
    Writer: Symbol.for('fun-fp-js/Writer'),
    State: Symbol.for('fun-fp-js/State')
};
const types = {
    of: a => {
        if (a == null) return a === null ? 'null' : 'undefined';
        if (a._typeName !== undefined) return a._typeName;
        const typeName = typeof a;
        if (typeName !== 'object') return typeName;
        if (Array.isArray(a)) return 'Array';
        return a.constructor?.name || 'object';
    },
    equals: (a, b, typeName = '') => typeName ? types.of(a) === typeName && types.of(b) === typeName : types.of(a) === types.of(b),
    check: (val, expected) => {
        if (typeof expected !== 'string') return false;
        const actual = types.of(val);
        return actual === expected || actual.toLowerCase() === expected.toLowerCase();
    },
    isFunction: f => typeof f === 'function',
    checkFunction: (f, msg = '') => {
        types.isFunction(f) || raise(new TypeError(`Argument must be a function${msg ? ': ' + msg : ''}`));
        return f;
    },
    isPlainObject: a => typeof a === 'object' && a !== null && !Array.isArray(a) && Object.getPrototypeOf(a) === Object.prototype,
    isIterable: a => a != null && typeof a[Symbol.iterator] === 'function',
    dateCheckAndGet: d => {
        if (Number.isNaN(d.getTime())) raise(new TypeError('Invalid Date'));
        return d;
    },
};
const emptyFunc = () => { };
const identity = x => x;
const compose2 = (f, g) => x => types.checkFunction(f, 'compose2')(types.checkFunction(g, 'compose2')(x));
const raise = e => { throw e; };
const runCatch = (f, onError = emptyFunc) => (...args) => {
    try { return types.checkFunction(f, 'runCatch')(...args); }
    catch (e) { return onError(e); }
};
const constant = x => () => x;
const tuple = (...args) => args;
const unapply2 = f => (a, b) => types.checkFunction(f, 'unapply2')(a, b);
const curry2 = f => a => b => types.checkFunction(f, 'curry2')(a, b);
const uncurry2 = f => (a, b) => types.checkFunction(f, 'uncurry2')(a)(b);
const predicate = f => x => Boolean(runCatch(types.checkFunction(f, 'predicate'), () => false)(x));
const negate = f => x => !predicate(types.checkFunction(f, 'negate'))(x);
const flip2 = f => (a, b) => types.checkFunction(f, 'flip2')(b, a);
const flipCurried2 = f => a => b => types.checkFunction(f, 'flipCurried2')(b)(a);
const pipe2 = (f, g) => x => types.checkFunction(g, 'pipe2')(types.checkFunction(f, 'pipe2')(x));
const apply = f => args => {
    types.of(args) !== 'Array' && raise(new TypeError('apply: args must be an array'));
    return types.checkFunction(f, 'apply')(...args);
};
const unapply = f => (...args) => types.checkFunction(f, 'unapply')(args);
const curry = (f, arity = f.length) => {
    types.checkFunction(f, 'curry');
    return function _curry(...args) {
        return args.length >= arity ? f(...args) : (...next) => _curry(...args, ...next);
    }
};
const uncurry = f => (...args) => args.reduce((acc, arg, i) => types.checkFunction(acc, `uncurry(${i})`)(arg), f);
const predicateN = f => (...args) => runCatch(f, () => false)(...args);
const negateN = f => (...args) => !predicateN(f)(...args);
const flip = f => (...args) => types.checkFunction(f, 'flip')(...args.slice().reverse());
const flipCurried = f => (...as) => (...bs) => types.checkFunction(f, 'flipCurried')(...bs)(...as);
const pipe = (...fs) => x => fs.reduce((acc, f) => types.checkFunction(f, `pipe(${fs.length})`)(acc), x);
const compose = (...fs) => pipe(...fs.slice().reverse());
const tap = (...fs) => x => (fs.forEach(f => runCatch(f, config.tapErrorHandler)(x)), x);
const also = flipCurried(tap);
const into = flipCurried(pipe);
const partial = (f, ...args) => (...next) => types.checkFunction(f, 'partial')(...args, ...next);
const useOrLift = check => lift => x => predicate(check)(x) ? x : types.checkFunction(lift, 'useOrLift')(x);
const once = f => {
    types.checkFunction(f, 'once');
    let called = false;
    let result;
    return (...args) => {
        if (!called) {
            result = f(...args);
            called = true;
        }
        return result;
    };
};
const converge = (f, ...branches) => (...args) => types.checkFunction(f, 'converge')(...branches.map((branch, i) => types.checkFunction(branch, `converge:${i}`)(...args)));
const range = n => {
    if (n < 0) raise(new RangeError(`range: n must be non-negative, got ${n}`));
    return Array.from({ length: n }, (_, i) => i);
};
const rangeBy = (start, end) => start >= end ? [] : range(end - start).map(i => start + i);
const register = (target, instance, ...aliases) => {
    target[instance.constructor.name] = instance;
    for (const alias of aliases) { target[alias.toLowerCase()] = instance; }
};
const loadedModules = new Set();
const load = (...modules) => {
    for (const module of modules) {
        if (!loadedModules.has(module)) {
            new module();
            loadedModules.add(module);
        }
    }
};
const modules = [];
const DEV = typeof process !== 'undefined' && process.env
    ? process.env.NODE_ENV !== 'production'
    : true;
const config = { strictMode: DEV, tapErrorHandler: emptyFunc };
const setStrictMode = (val) => { config.strictMode = !!val; };
const setTapErrorHandler = (handler) => { config.tapErrorHandler = handler; };
const checkAndSet = (config => {
    const rules = {
        Setoid: {
            strict: (instance, equals) => {
                typeof equals !== 'function' && raise(new TypeError('Setoid.equals: equals must be a function'));
                instance.equals = (a, b) => (types.equals(a, b) && types.check(a, instance.type)) ? equals(a, b) : raise(new TypeError(`Setoid.equals: arguments must be the same type and match ${instance.type}`));
            }, loose: (instance, equals) => { instance.equals = (a, b) => equals(a, b); }
        },
        Ord: {
            strict: (instance, lte) => {
                typeof lte !== 'function' && raise(new TypeError('Ord.lte: lte must be a function'));
                instance.lte = (a, b) => (types.equals(a, b) && types.check(a, instance.type)) ? lte(a, b) : raise(new TypeError(`Ord.lte: arguments must be the same type and match ${instance.type}`));
            },
            loose: (instance, lte) => { instance.lte = (a, b) => lte(a, b); }
        },
        Semigroup: {
            strict: (instance, concat) => {
                typeof concat !== 'function' && raise(new TypeError('Semigroup.concat: concat must be a function'));
                instance.concat = (a, b) => (types.equals(a, b) && types.check(a, instance.type)) ? concat(a, b) : raise(new TypeError(`Semigroup.concat: arguments must be the same type and match ${instance.type}`));
            },
            loose: (instance, concat) => { instance.concat = (a, b) => concat(a, b); }
        },
        'Monoid.super': {
            strict: (semigroup) => { !(semigroup && semigroup[Symbols.Semigroup]) && raise(new TypeError('Monoid: argument must be a Semigroup')); },
            loose: emptyFunc
        },
        Monoid: {
            strict: (instance, semigroup, empty) => {
                typeof empty !== 'function' && raise(new TypeError('Monoid.empty: empty must be a function'));
                instance.empty = empty;
            },
            loose: (instance, semigroup, empty) => { instance.empty = empty; }
        },
        'Group.super': {
            strict: (monoid) => { !(monoid && monoid[Symbols.Monoid]) && raise(new TypeError('Group: argument must be a Monoid')); },
            loose: emptyFunc
        },
        Group: {
            strict: (instance, monoid, invert) => {
                !(monoid && monoid[Symbols.Monoid]) && raise(new TypeError('Group: argument must be a Monoid'));
                if (invert) {
                    typeof invert !== 'function' && raise(new TypeError('Group.invert: invert must be a function'));
                    instance.invert = a => types.check(a, instance.type) ? invert(a) : raise(new TypeError(`Group.invert: argument must be ${instance.type}`));
                }
            },
            loose: (instance, monoid, invert) => { if (invert) instance.invert = a => invert(a); }
        },
        Semigroupoid: {
            strict: (instance, compose) => {
                typeof compose !== 'function' && raise(new TypeError('Semigroupoid.compose: compose must be a function'));
                instance.compose = (f, g) => types.equals(f, g, 'function') ? compose(f, g) : raise(new TypeError('Semigroupoid.compose: both arguments must be functions'));
            },
            loose: (instance, compose) => { instance.compose = (f, g) => compose(f, g); }
        },
        'Category.super': {
            strict: (semigroupoid) => { !(semigroupoid && semigroupoid[Symbols.Semigroupoid]) && raise(new TypeError('Category: argument must be a Semigroupoid')); },
            loose: emptyFunc
        },
        Category: {
            strict: (instance, semigroupoid, id) => {
                typeof id !== 'function' && raise(new TypeError('Category.id: id must be a function'));
                instance.id = id;
            },
            loose: (instance, semigroupoid, id) => { instance.id = id; }
        },
        Filterable: {
            strict: (instance, filter) => {
                typeof filter !== 'function' && raise(new TypeError('Filterable.filter: filter must be a function'));
                instance.filter = (pred, a, ...rest) => (types.isFunction(pred) && types.check(a, instance.type)) ? filter(pred, a, ...rest) : raise(new TypeError(`Filterable.filter: arguments must be (function, ${instance.type})`));
            },
            loose: (instance, filter) => { instance.filter = (pred, a, ...rest) => filter(pred, a, ...rest); }
        },
        Functor: {
            strict: (instance, map) => {
                typeof map !== 'function' && raise(new TypeError('Functor.map: map must be a function'));
                instance.map = (f, a) => (types.isFunction(f) && types.check(a, instance.type)) ? map(f, a) : raise(new TypeError(`Functor.map: arguments must be (function, ${instance.type})`));
            },
            loose: (instance, map) => { instance.map = (f, a) => map(f, a); }
        },
        Bifunctor: {
            strict: (instance, bimap) => {
                typeof bimap !== 'function' && raise(new TypeError('Bifunctor.bimap: bimap must be a function'));
                instance.bimap = (f, g, a) => (types.equals(f, g, 'function') && types.check(a, instance.type)) ? bimap(f, g, a) : raise(new TypeError(`Bifunctor.bimap: arguments must be (function, function, ${instance.type})`));
            },
            loose: (instance, bimap) => { instance.bimap = (f, g, a) => bimap(f, g, a); }
        },
        Contravariant: {
            strict: (instance, contramap) => {
                typeof contramap !== 'function' && raise(new TypeError('Contravariant.contramap: contramap must be a function'));
                instance.contramap = (f, g) => types.equals(f, g, 'function') ? contramap(f, g) : raise(new TypeError('Contravariant.contramap: both arguments must be functions'));
            },
            loose: (instance, contramap) => { instance.contramap = (f, g) => contramap(f, g); }
        },
        Profunctor: {
            strict: (instance, promap) => {
                typeof promap !== 'function' && raise(new TypeError('Profunctor.promap: promap must be a function'));
                instance.promap = (f, g, fn) => (types.equals(f, g, 'function') && types.isFunction(fn)) ? promap(f, g, fn) : raise(new TypeError('Profunctor.promap: all arguments must be functions'));
            },
            loose: (instance, promap) => { instance.promap = (f, g, fn) => promap(f, g, fn); }
        },
        'Apply.super': {
            strict: (functor) => { !(functor && functor[Symbols.Functor]) && raise(new TypeError('Apply: argument must be a Functor')); },
            loose: emptyFunc
        },
        Apply: {
            strict: (instance, functor, ap) => {
                if (ap) {
                    typeof ap !== 'function' && raise(new TypeError('Apply.ap: ap must be a function'));
                    instance.ap = (fs, values) => types.equals(fs, values, instance.type) ? ap(fs, values) : raise(new TypeError(`Apply.ap: both arguments must be ${instance.type}`));
                }
            },
            loose: (instance, functor, ap) => { if (ap) instance.ap = (fs, values) => ap(fs, values); }
        },
        'Applicative.super': {
            strict: (apply) => { !(apply && apply[Symbols.Apply]) && raise(new TypeError('Applicative: argument must be an Apply')); },
            loose: emptyFunc
        },
        Applicative: {
            strict: (instance, apply, of) => {
                typeof of !== 'function' && raise(new TypeError('Applicative.of: of must be a function'));
                instance.of = of;
            },
            loose: (instance, apply, of) => { instance.of = of; }
        },
        'Alt.super': {
            strict: (functor) => { !(functor && functor[Symbols.Functor]) && raise(new TypeError('Alt: argument must be a Functor')); },
            loose: emptyFunc
        },
        Alt: {
            strict: (instance, functor, alt) => {
                if (alt) {
                    typeof alt !== 'function' && raise(new TypeError('Alt.alt: alt must be a function'));
                    instance.alt = (a, b) => types.equals(a, b, instance.type) ? alt(a, b) : raise(new TypeError(`Alt.alt: both arguments must be ${instance.type}`));
                }
            },
            loose: (instance, functor, alt) => { if (alt) instance.alt = (a, b) => alt(a, b); }
        },
        'Plus.super': {
            strict: (alt) => { !(alt && alt[Symbols.Alt]) && raise(new TypeError('Plus: argument must be an Alt')); },
            loose: emptyFunc
        },
        Plus: {
            strict: (instance, alt, zero) => {
                typeof zero !== 'function' && raise(new TypeError('Plus.zero: zero must be a function'));
                instance.zero = zero;
            },
            loose: (instance, alt, zero) => { instance.zero = zero; }
        },
        'Chain.super': {
            strict: (apply) => { !(apply && apply[Symbols.Apply]) && raise(new TypeError('Chain: argument must be an Apply')); },
            loose: emptyFunc
        },
        Alternative: {
            strict: (applicative, plus) => {
                !(applicative && applicative[Symbols.Applicative]) && raise(new TypeError('Alternative: first argument must be an Applicative'));
                !(plus && plus[Symbols.Plus]) && raise(new TypeError('Alternative: second argument must be a Plus'));
            },
            loose: emptyFunc
        },
        Chain: {
            strict: (instance, apply, chain) => {
                if (chain) {
                    typeof chain !== 'function' && raise(new TypeError('Chain.chain: chain must be a function'));
                    instance.chain = (f, a) => (types.isFunction(f) && types.check(a, instance.type)) ? chain(f, a) : raise(new TypeError(`Chain.chain: arguments must be (function, ${instance.type})`));
                }
            },
            loose: (instance, apply, chain) => { if (chain) instance.chain = (f, a) => chain(f, a); }
        },
        'ChainRec.super': {
            strict: (chain) => { !(chain && chain[Symbols.Chain]) && raise(new TypeError('ChainRec: argument must be a Chain')); },
            loose: emptyFunc
        },
        ChainRec: {
            strict: (instance, chain, chainRec) => {
                if (chainRec) {
                    typeof chainRec !== 'function' && raise(new TypeError('ChainRec.chainRec: chainRec must be a function'));
                    instance.chainRec = (f, i) => types.isFunction(f) ? chainRec(f, i) : raise(new TypeError('ChainRec.chainRec: first argument must be a function'));
                }
            },
            loose: (instance, chain, chainRec) => { if (chainRec) instance.chainRec = (f, i) => chainRec(f, i); }
        },
        Monad: {
            strict: (applicative, chain) => {
                !(applicative && applicative[Symbols.Applicative]) && raise(new TypeError('Monad: first argument must be an Applicative'));
                !(chain && chain[Symbols.Chain]) && raise(new TypeError('Monad: second argument must be a Chain'));
            },
            loose: emptyFunc
        },
        Foldable: {
            strict: (instance, reduce) => {
                typeof reduce !== 'function' && raise(new TypeError('Foldable.reduce: reduce must be a function'));
                instance.reduce = (f, init, a) => (types.isFunction(f) && types.check(a, instance.type)) ? reduce(f, init, a) : raise(new TypeError(`Foldable.reduce: arguments must be (function, initial, ${instance.type})`));
            },
            loose: (instance, reduce) => { instance.reduce = (f, init, a) => reduce(f, init, a); }
        },
        'Extend.super': {
            strict: (functor) => { !(functor && functor[Symbols.Functor]) && raise(new TypeError('Extend: argument must be a Functor')); },
            loose: emptyFunc
        },
        Extend: {
            strict: (instance, functor, extend) => {
                if (extend) {
                    typeof extend !== 'function' && raise(new TypeError('Extend.extend: extend must be a function'));
                    instance.extend = (f, a) => (types.isFunction(f) && types.check(a, instance.type)) ? extend(f, a) : raise(new TypeError(`Extend.extend: arguments must be (function, ${instance.type})`));
                }
            },
            loose: (instance, functor, extend) => { if (extend) instance.extend = (f, a) => extend(f, a); }
        },
        'Comonad.super': {
            strict: (extend) => { !(extend && extend[Symbols.Extend]) && raise(new TypeError('Comonad: argument must be an Extend')); },
            loose: emptyFunc
        },
        Comonad: {
            strict: (instance, extend, extract) => {
                if (extract) {
                    typeof extract !== 'function' && raise(new TypeError('Comonad.extract: extract must be a function'));
                    instance.extract = a => types.check(a, instance.type) ? extract(a) : raise(new TypeError(`Comonad.extract: argument must be ${instance.type}`));
                }
            },
            loose: (instance, extend, extract) => { if (extract) instance.extract = a => extract(a); }
        },
        'Traversable.super': {
            strict: (functor, foldable) => {
                !(functor && functor[Symbols.Functor]) && raise(new TypeError('Traversable: first argument must be a Functor'));
                !(foldable && foldable[Symbols.Foldable]) && raise(new TypeError('Traversable: second argument must be a Foldable'));
            },
            loose: emptyFunc
        },
        Traversable: {
            strict: (instance, functor, foldable, traverse) => {
                if (traverse) {
                    typeof traverse !== 'function' && raise(new TypeError('Traversable.traverse: traverse must be a function'));
                    instance.traverse = (applicative, f, a) => {
                        if (!applicative[Symbols.Applicative]) return raise(new TypeError('Traversable.traverse: first argument must be an Applicative'));
                        if (!types.isFunction(f)) return raise(new TypeError('Traversable.traverse: second argument must be a function'));
                        if (!types.check(a, instance.type)) return raise(new TypeError(`Traversable.traverse: third argument must be ${instance.type}`));
                        return traverse(applicative, f, a);
                    };
                }
            },
            loose: (instance, functor, foldable, traverse) => { if (traverse) instance.traverse = (applicative, f, a) => traverse(applicative, f, a); }
        },
    };
    return key => {
        const rule = rules[key];
        if (!rule) raise(new TypeError(`checkAndSet: unknown key '${key}'`));
        return (instance, ...args) => { config.strictMode ? rule.strict(instance, ...args) : rule.loose(instance, ...args); };
    };
})(config);
class Algebra { constructor(type) { this.type = type; } }
Algebra.prototype[Symbols.Algebra] = true;
class Setoid extends Algebra {
    constructor(equals, type, registry, ...registryKeys) {
        super(type);
        checkAndSet('Setoid')(this, equals);
        registry && register(registry, this, ...registryKeys);
    }
    equals() { raise(new Error('Setoid: equals is not implemented')); }
}
Setoid.prototype[Symbols.Setoid] = true;
class Ord extends Algebra {
    constructor(lte, type, registry, ...aliases) {
        super(type);
        checkAndSet('Ord')(this, lte);
        registry && register(registry, this, ...aliases);
    }
    lte() { raise(new Error('Ord: lte is not implemented')); }
}
Ord.prototype[Symbols.Ord] = true;
class Semigroup extends Algebra {
    constructor(concat, type, registry, ...aliases) {
        super(type);
        checkAndSet('Semigroup')(this, concat);
        registry && register(registry, this, ...aliases);
    }
    concat() { raise(new Error('Semigroup: concat is not implemented')); }
}
Semigroup.prototype[Symbols.Semigroup] = true;
class Monoid extends Semigroup {
    constructor(semigroup, empty, type, registry, ...aliases) {
        checkAndSet('Monoid.super')(semigroup);
        super(semigroup.concat, type);
        checkAndSet('Monoid')(this, semigroup, empty);
        registry && register(registry, this, ...aliases);
    }
    empty() { raise(new Error('Monoid: empty is not implemented')); }
}
Monoid.prototype[Symbols.Monoid] = true;
class Group extends Monoid {
    constructor(monoid, invert, type, registry, ...aliases) {
        checkAndSet('Group.super')(monoid);
        super(monoid, monoid.empty, type);
        checkAndSet('Group')(this, monoid, invert);
        registry && register(registry, this, ...aliases);
    }
    invert() { raise(new Error('Group: invert is not implemented')); }
}
Group.prototype[Symbols.Group] = true;
class Semigroupoid extends Algebra {
    constructor(compose, type, registry, ...registryKeys) {
        super(type);
        checkAndSet('Semigroupoid')(this, compose);
        registry && register(registry, this, ...registryKeys);
    }
    compose() { raise(new Error('Semigroupoid: compose is not implemented')); }
}
Semigroupoid.prototype[Symbols.Semigroupoid] = true;
class Category extends Semigroupoid {
    constructor(semigroupoid, id, type, registry, ...aliases) {
        checkAndSet('Category.super')(semigroupoid);
        super(semigroupoid.compose, type);
        checkAndSet('Category')(this, semigroupoid, id);
        registry && register(registry, this, ...aliases);
    }
    id() { raise(new Error('Category: id is not implemented')); }
}
Category.prototype[Symbols.Category] = true;
class Filterable extends Algebra {
    constructor(filter, type, registry, ...aliases) {
        super(type);
        checkAndSet('Filterable')(this, filter);
        registry && register(registry, this, ...aliases);
    }
    filter() { raise(new Error('Filterable: filter is not implemented')); }
}
Filterable.prototype[Symbols.Filterable] = true;
class Functor extends Algebra {
    constructor(map, type, registry, ...aliases) {
        super(type);
        checkAndSet('Functor')(this, map);
        registry && register(registry, this, ...aliases);
    }
    map() { raise(new Error('Functor: map is not implemented')); }
}
Functor.prototype[Symbols.Functor] = true;
class Bifunctor extends Algebra {
    constructor(bimap, type, registry, ...aliases) {
        super(type);
        checkAndSet('Bifunctor')(this, bimap);
        registry && register(registry, this, ...aliases);
    }
    bimap() { raise(new Error('Bifunctor: bimap is not implemented')); }
}
Bifunctor.prototype[Symbols.Bifunctor] = true;
class Contravariant extends Algebra {
    constructor(contramap, type, registry, ...aliases) {
        super(type);
        checkAndSet('Contravariant')(this, contramap);
        registry && register(registry, this, ...aliases);
    }
    contramap() { raise(new Error('Contravariant: contramap is not implemented')); }
}
Contravariant.prototype[Symbols.Contravariant] = true;
class Profunctor extends Algebra {
    constructor(promap, type, registry, ...aliases) {
        super(type);
        checkAndSet('Profunctor')(this, promap);
        registry && register(registry, this, ...aliases);
    }
    promap() { raise(new Error('Profunctor: promap is not implemented')); }
}
Profunctor.prototype[Symbols.Profunctor] = true;
class Apply extends Functor { // F(a -> b) => F(a) => F(b)
    constructor(functor, ap, type, registry, ...aliases) {
        checkAndSet('Apply.super')(functor);
        super(functor.map, type);
        checkAndSet('Apply')(this, functor, ap);
        registry && register(registry, this, ...aliases);
    }
    ap() { raise(new Error('Apply: ap is not implemented')); }
}
Apply.prototype[Symbols.Apply] = true;
class Applicative extends Apply {
    constructor(apply, of, type, registry, ...aliases) {
        checkAndSet('Applicative.super')(apply);
        super(apply, apply.ap, type);
        checkAndSet('Applicative')(this, apply, of);
        registry && register(registry, this, ...aliases);
    }
    of() { raise(new Error('Applicative: of is not implemented')); }
}
Applicative.prototype[Symbols.Applicative] = true;
class Alt extends Functor {
    constructor(functor, alt, type, registry, ...aliases) {
        checkAndSet('Alt.super')(functor);
        super(functor.map, type);
        checkAndSet('Alt')(this, functor, alt);
        registry && register(registry, this, ...aliases);
    }
    alt() { raise(new Error('Alt: alt is not implemented')); }
}
Alt.prototype[Symbols.Alt] = true;
class Plus extends Alt {
    constructor(alt, zero, type, registry, ...aliases) {
        checkAndSet('Plus.super')(alt);
        super(alt, alt.alt, type);
        checkAndSet('Plus')(this, alt, zero);
        registry && register(registry, this, ...aliases);
    }
    zero() { raise(new Error('Plus: zero is not implemented')); }
}
Plus.prototype[Symbols.Plus] = true;
class Alternative extends Applicative {
    constructor(applicative, plus, type, registry, ...aliases) {
        checkAndSet('Alternative')(applicative, plus);
        super(applicative, applicative.of, type);
        this.ap = applicative.ap;
        this.alt = plus.alt;
        this.zero = plus.zero;
        registry && register(registry, this, ...aliases);
    }
}
Alternative.prototype[Symbols.Alternative] = true;
class Chain extends Apply {
    constructor(apply, chain, type, registry, ...aliases) {
        checkAndSet('Chain.super')(apply);
        super(apply, apply.ap, type);
        checkAndSet('Chain')(this, apply, chain);
        registry && register(registry, this, ...aliases);
    }
    chain() { raise(new Error('Chain: chain is not implemented')); }
}
Chain.prototype[Symbols.Chain] = true;
class ChainRec extends Chain {
    constructor(chain, chainRec, type, registry, ...aliases) {
        checkAndSet('ChainRec.super')(chain);
        super(chain, chain.chain, type);
        checkAndSet('ChainRec')(this, chain, chainRec);
        registry && register(registry, this, ...aliases);
    }
    chainRec() { raise(new Error('ChainRec: chainRec is not implemented')); }
}
ChainRec.prototype[Symbols.ChainRec] = true;
class Monad extends Applicative {
    constructor(applicative, chain, type, registry, ...aliases) {
        checkAndSet('Monad')(applicative, chain);
        super(applicative, applicative.of, type);
        this.ap = applicative.ap;
        this.chain = chain.chain;
        registry && register(registry, this, ...aliases);
    }
}
Monad.prototype[Symbols.Monad] = true;
class Foldable extends Algebra {
    constructor(reduce, type, registry, ...aliases) {
        super(type);
        checkAndSet('Foldable')(this, reduce);
        registry && register(registry, this, ...aliases);
    }
    reduce() { raise(new Error('Foldable: reduce is not implemented')); }
}
Foldable.prototype[Symbols.Foldable] = true;
class Extend extends Functor {
    constructor(functor, extend, type, registry, ...aliases) {
        checkAndSet('Extend.super')(functor);
        super(functor.map, type);
        checkAndSet('Extend')(this, functor, extend);
        registry && register(registry, this, ...aliases);
    }
    extend() { raise(new Error('Extend: extend is not implemented')); }
}
Extend.prototype[Symbols.Extend] = true;
class Comonad extends Extend {
    constructor(extend, extract, type, registry, ...aliases) {
        checkAndSet('Comonad.super')(extend);
        super(extend, extend.extend, type);
        checkAndSet('Comonad')(this, extend, extract);
        registry && register(registry, this, ...aliases);
    }
    extract() { raise(new Error('Comonad: extract is not implemented')); }
}
Comonad.prototype[Symbols.Comonad] = true;
class Traversable extends Functor {
    constructor(functor, foldable, traverse, type, registry, ...aliases) {
        checkAndSet('Traversable.super')(functor, foldable);
        super(functor.map, type);
        this.reduce = foldable.reduce;
        checkAndSet('Traversable')(this, functor, foldable, traverse);
        registry && register(registry, this, ...aliases);
    }
    traverse() { raise(new Error('Traversable: traverse is not implemented')); }
}
Traversable.prototype[Symbols.Traversable] = true;

const withTypeRegistry = (TypeClass, defaultResolver = null) => {
    TypeClass.types = {};
    TypeClass.resolver = key => TypeClass.types[key] || defaultResolver?.(key);
    TypeClass.of = key => TypeClass.resolver(key)
        || raise(new TypeError(`${TypeClass.name}.of: unsupported key ${key}`));
};

Setoid.op = (a, b) => a === b;
withTypeRegistry(Setoid, key => key === 'default' ? { equals: Setoid.op } : null);

Ord.op = (a, b) => a <= b;
withTypeRegistry(Ord, key => key === 'default' ? { lte: Ord.op } : null);

withTypeRegistry(Semigroup);
withTypeRegistry(Monoid);
withTypeRegistry(Group);
withTypeRegistry(Semigroupoid);
withTypeRegistry(Category);
withTypeRegistry(Filterable);
withTypeRegistry(Functor);
withTypeRegistry(Bifunctor);
withTypeRegistry(Contravariant);
withTypeRegistry(Profunctor);
withTypeRegistry(Apply);
withTypeRegistry(Applicative);
withTypeRegistry(Alt);
withTypeRegistry(Plus);
withTypeRegistry(Alternative);
withTypeRegistry(Chain);
withTypeRegistry(ChainRec);
ChainRec.next = value => ({ tag: 'next', value });
ChainRec.done = value => ({ tag: 'done', value });
withTypeRegistry(Monad);
withTypeRegistry(Foldable);
withTypeRegistry(Extend);
withTypeRegistry(Comonad);
withTypeRegistry(Traversable);

/* Function */
class FunctionSemigroup extends Semigroup {
    constructor() {
        super(compose2, 'function', Semigroup.types, 'function');
    }
}
modules.push(FunctionSemigroup);
class FunctionMonoid extends Monoid {
    constructor() {
        super(Semigroup.types.FunctionSemigroup, () => identity, 'function', Monoid.types, 'function');
    }
}
modules.push(FunctionMonoid);
class FunctionSemigroupoid extends Semigroupoid {
    constructor() {
        super(compose2, 'function', Semigroupoid.types, 'function');
    }
}
modules.push(FunctionSemigroupoid);
class FunctionCategory extends Category {
    constructor() {
        super(Semigroupoid.types.FunctionSemigroupoid, identity, 'function', Category.types, 'function');
    }
}
modules.push(FunctionCategory);
class PredicateContravariant extends Contravariant {
    constructor() {
        super((f, pred) => a => pred(f(a)), 'function', Contravariant.types, 'predicate');
    }
}
modules.push(PredicateContravariant);
class FunctionProfunctor extends Profunctor {
    constructor() {
        super((f, g, fn) => x => g(fn(f(x))), 'function', Profunctor.types, 'function');
    }
}
modules.push(FunctionProfunctor);
/* Boolean */
class BooleanSetoid extends Setoid {
    constructor() {
        super(Setoid.op, 'boolean', Setoid.types, 'boolean');
    }
}
modules.push(BooleanSetoid);
class BooleanAllSemigroup extends Semigroup {
    constructor() {
        super((x, y) => x && y, 'boolean', Semigroup.types, 'boolean');
    }
}
modules.push(BooleanAllSemigroup);
class BooleanAnySemigroup extends Semigroup {
    constructor() {
        super((x, y) => x || y, 'boolean', Semigroup.types);
    }
}
modules.push(BooleanAnySemigroup);
class BooleanXorSemigroup extends Semigroup {
    constructor() {
        super((x, y) => x !== y, 'boolean', Semigroup.types);
    }
}
modules.push(BooleanXorSemigroup);
class BooleanAllMonoid extends Monoid {
    constructor() {
        super(Semigroup.types.BooleanAllSemigroup, () => true, 'boolean', Monoid.types, 'boolean');
    }
}
modules.push(BooleanAllMonoid);
class BooleanAnyMonoid extends Monoid {
    constructor() {
        super(Semigroup.types.BooleanAnySemigroup, () => false, 'boolean', Monoid.types);
    }
}
modules.push(BooleanAnyMonoid);
class BooleanXorMonoid extends Monoid {
    constructor() {
        super(Semigroup.types.BooleanXorSemigroup, () => false, 'boolean', Monoid.types);
    }
}
modules.push(BooleanXorMonoid);
class BooleanXorGroup extends Group {
    constructor() {
        super(Monoid.types.BooleanXorMonoid, x => x, 'boolean', Group.types);
    }
}
modules.push(BooleanXorGroup);
/* Number */
class NumberSetoid extends Setoid {
    constructor() {
        super(Setoid.op, 'number', Setoid.types, 'number');
    }
}
modules.push(NumberSetoid);
class NumberOrd extends Ord {
    constructor() {
        super(Ord.op, 'number', Ord.types, 'number');
    }
}
modules.push(NumberOrd);
class NumberSumSemigroup extends Semigroup {
    constructor() {
        super((x, y) => x + y, 'number', Semigroup.types, 'number');
    }
}
modules.push(NumberSumSemigroup);
class NumberProductSemigroup extends Semigroup {
    constructor() {
        super((x, y) => x * y, 'number', Semigroup.types);
    }
}
modules.push(NumberProductSemigroup);
class NumberMaxSemigroup extends Semigroup {
    constructor() {
        super(Math.max, 'number', Semigroup.types);
    }
}
modules.push(NumberMaxSemigroup);
class NumberMinSemigroup extends Semigroup {
    constructor() {
        super(Math.min, 'number', Semigroup.types);
    }
}
modules.push(NumberMinSemigroup);
class NumberSumMonoid extends Monoid {
    constructor() {
        super(Semigroup.types.NumberSumSemigroup, () => 0, 'number', Monoid.types, 'number');
    }
}
modules.push(NumberSumMonoid);
class NumberProductMonoid extends Monoid {
    constructor() {
        super(Semigroup.types.NumberProductSemigroup, () => 1, 'number', Monoid.types);
    }
}
modules.push(NumberProductMonoid);
class NumberMaxMonoid extends Monoid {
    constructor() {
        super(Semigroup.types.NumberMaxSemigroup, () => -Infinity, 'number', Monoid.types);
    }
}
modules.push(NumberMaxMonoid);
class NumberMinMonoid extends Monoid {
    constructor() {
        super(Semigroup.types.NumberMinSemigroup, () => Infinity, 'number', Monoid.types);
    }
}
modules.push(NumberMinMonoid);
class NumberSumGroup extends Group {
    constructor() {
        super(Monoid.types.NumberSumMonoid, x => -x, 'number', Group.types, 'number');
    }
}
modules.push(NumberSumGroup);
class NumberProductGroup extends Group {
    constructor() {
        super(Monoid.types.NumberProductMonoid, x => 1 / x, 'number', Group.types);
    }
}
modules.push(NumberProductGroup);
/* String */
class StringSetoid extends Setoid {
    constructor() {
        super(Setoid.op, 'string', Setoid.types, 'string');
    }
}
modules.push(StringSetoid);
class StringOrd extends Ord {
    constructor() {
        super(Ord.op, 'string', Ord.types, 'string');
    }
}
modules.push(StringOrd);
class StringLengthOrd extends Ord {
    constructor() {
        super((x, y) => x.length <= y.length, 'string', Ord.types);
    }
}
modules.push(StringLengthOrd);
class StringLocaleOrd extends Ord {
    constructor() {
        super((x, y) => x.localeCompare(y) <= 0, 'string', Ord.types);
    }
}
modules.push(StringLocaleOrd);
class StringSemigroup extends Semigroup {
    constructor() {
        super((x, y) => x + y, 'string', Semigroup.types, 'string');
    }
}
modules.push(StringSemigroup);
class StringMonoid extends Monoid {
    constructor() {
        super(Semigroup.types.StringSemigroup, () => '', 'string', Monoid.types, 'string');
    }
}
modules.push(StringMonoid);
/* Object */
class FirstSemigroup extends Semigroup {
    constructor() {
        super(x => x, 'object', Semigroup.types, 'first');
    }
}
modules.push(FirstSemigroup);
class LastSemigroup extends Semigroup {
    constructor() {
        super((x, y) => y, 'object', Semigroup.types, 'last');
    }
}
modules.push(LastSemigroup);
class ObjectFilterable extends Filterable {
    constructor() {
        super((pred, obj) => polyfills.object.filter(pred, obj), 'object', Filterable.types, 'object');
    }
}
modules.push(ObjectFilterable);
class ObjectFoldable extends Foldable {
    constructor() {
        super((f, init, obj) => polyfills.object.values(obj).reduce(f, init), 'object', Foldable.types, 'object');
    }
}
modules.push(ObjectFoldable);
/* Array */
class ArraySemigroup extends Semigroup {
    constructor() {
        super((x, y) => x.concat(y), 'Array', Semigroup.types, 'array');
    }
}
modules.push(ArraySemigroup);
class ArrayMonoid extends Monoid {
    constructor() {
        super(Semigroup.types.ArraySemigroup, () => [], 'Array', Monoid.types, 'array');
    }
}
modules.push(ArrayMonoid);
class ArrayFilterable extends Filterable {
    constructor() {
        super((pred, arr) => arr.filter(pred), 'Array', Filterable.types, 'array');
    }
}
modules.push(ArrayFilterable);
class ArrayFunctor extends Functor {
    constructor() {
        super((f, arr) => arr.map(f), 'Array', Functor.types, 'array');
    }
}
modules.push(ArrayFunctor);
class TupleBifunctor extends Bifunctor {
    constructor() {
        super((f, g, [a, b]) => [f(a), g(b)], 'Array', Bifunctor.types, 'tuple');
    }
}
modules.push(TupleBifunctor);
class ArrayApply extends Apply {
    constructor() {
        super(Functor.types.ArrayFunctor,
            (fs, values) => polyfills.array.flatMap(f => Functor.types.ArrayFunctor.map(f, values), fs),
            'Array', Apply.types, 'array');
    }
}
modules.push(ArrayApply);
class ArrayApplicative extends Applicative {
    constructor() {
        super(Apply.types.ArrayApply, x => [x], 'Array', Applicative.types, 'array');
    }
}
modules.push(ArrayApplicative);
class ArrayAlt extends Alt {
    constructor() {
        super(Functor.types.ArrayFunctor, (a, b) => a.concat(b), 'Array', Alt.types, 'array');
    }
}
modules.push(ArrayAlt);
class ArrayPlus extends Plus {
    constructor() {
        super(Alt.types.ArrayAlt, () => [], 'Array', Plus.types, 'array');
    }
}
modules.push(ArrayPlus);
class ArrayAlternative extends Alternative {
    constructor() {
        super(Applicative.types.ArrayApplicative, Plus.types.ArrayPlus, 'Array', Alternative.types, 'array');
    }
}
modules.push(ArrayAlternative);
class ArrayChain extends Chain {
    constructor() {
        super(Apply.types.ArrayApply, polyfills.array.flatMap, 'Array', Chain.types, 'array');
    }
}
modules.push(ArrayChain);
class ArrayChainRec extends ChainRec {
    constructor() {
        super(Chain.types.ArrayChain, (f, i) => {
            const res = [];
            const queue = f(ChainRec.next, ChainRec.done, i);
            while (queue.length > 0) {
                const step = queue.shift();
                step.tag === 'next' ? queue.unshift(...f(ChainRec.next, ChainRec.done, step.value)) : res.push(step.value);
            }
            return res;
        }, 'Array', ChainRec.types, 'array');
    }
}
modules.push(ArrayChainRec);
class ArrayMonad extends Monad {
    constructor() {
        super(Applicative.types.ArrayApplicative, Chain.types.ArrayChain, 'Array', Monad.types, 'array');
    }
}
modules.push(ArrayMonad);
class ArrayFoldable extends Foldable {
    constructor() {
        super((f, init, arr) => arr.reduce(f, init), 'Array', Foldable.types, 'array');
    }
}
modules.push(ArrayFoldable);
class ArrayExtend extends Extend {
    constructor() {
        super(Functor.types.ArrayFunctor,
            (f, arr) => arr.map((_, i) => f(arr.slice(i))),
            'Array', Extend.types, 'array');
    }
}
modules.push(ArrayExtend);
class ArrayComonad extends Comonad {
    constructor() {
        super(Extend.types.ArrayExtend, arr => arr[0], 'Array', Comonad.types, 'array');
    }
}
modules.push(ArrayComonad);
class ArrayTraversable extends Traversable {
    constructor() {
        super(Functor.types.ArrayFunctor,
            Foldable.types.ArrayFoldable,
            (applicative, f, arr) => applicative.map(
                result => [...result],
                arr.reduce(
                    (acc, x) => applicative.ap(applicative.map(a => b => (a.push(b), a), acc), f(x)),
                    applicative.of([])
                )
            ),
            'Array', Traversable.types, 'array');
    }
}
modules.push(ArrayTraversable);
/* Date */
class DateSetoid extends Setoid {
    constructor() {
        super((x, y) => types.dateCheckAndGet(x).getTime() === types.dateCheckAndGet(y).getTime(), 'date', Setoid.types, 'date');
    }
}
modules.push(DateSetoid);
class DateOrd extends Ord {
    constructor() {
        super((x, y) => types.dateCheckAndGet(x).getTime() <= types.dateCheckAndGet(y).getTime(), 'date', Ord.types, 'date');
    }
}
modules.push(DateOrd);
/* Maybe */
class Maybe {
    isJust() { return false; }
    isNothing() { return false; }
}
class Just extends Maybe {
    constructor(value) {
        super(); this.value = value; this._typeName = 'Maybe';
    }
    isJust() { return true; }
    map(f) { return Functor.of('maybe').map(f, this); }
    chain(f) { return Chain.of('maybe').chain(f, this); }
}
class Nothing extends Maybe {
    constructor() {
        super(); this._typeName = 'Maybe';
    }
    isNothing() { return true; }
    map(f) { return Functor.of('maybe').map(f, this); }
    chain(f) { return Chain.of('maybe').chain(f, this); }
}
Maybe.prototype[Symbols.Maybe] = true;
Maybe.Just = x => new Just(x);
Maybe.Nothing = () => new Nothing();
Maybe.of = x => new Just(x);
Maybe.isMaybe = x => x != null && x[Symbols.Maybe] === true;
Maybe.isJust = x => Maybe.isMaybe(x) && x.isJust();
Maybe.isNothing = x => Maybe.isMaybe(x) && x.isNothing();
Maybe.fromNullable = x => x == null ? new Nothing() : new Just(x);
Maybe.fold = (onNothing, onJust, m) => m.isJust() ? onJust(m.value) : onNothing();
Maybe.catch = runCatch(f => Maybe.Just(f()), Maybe.Nothing);
class MaybeSemigroupoid extends Semigroupoid {
    constructor() {
        super((f, g) => x => Chain.types.MaybeChain.chain(f, g(x)), 'Maybe', Semigroupoid.types, 'maybe');
    }
}
modules.push(MaybeSemigroupoid);
class MaybeCategory extends Category {
    constructor() {
        super(Semigroupoid.types.MaybeSemigroupoid, Maybe.Just, 'Maybe', Category.types, 'maybe');
    }
}
modules.push(MaybeCategory);
class MaybeFilterable extends Filterable {
    constructor() {
        super((pred, m) => m.isJust() && pred(m.value) ? m : Maybe.Nothing(), 'Maybe', Filterable.types, 'maybe');
    }
}
modules.push(MaybeFilterable);
class MaybeFunctor extends Functor {
    constructor() {
        super((f, m) => m.isJust() ? Maybe.Just(f(m.value)) : m, 'Maybe', Functor.types, 'maybe');
    }
}
modules.push(MaybeFunctor);
class MaybeApply extends Apply {
    constructor() {
        super(Functor.types.MaybeFunctor,
            (mf, mx) => mf.isNothing() ? mf : mx.isNothing() ? mx : Maybe.Just(mf.value(mx.value)),
            'Maybe', Apply.types, 'maybe');
    }
}
modules.push(MaybeApply);
class MaybeApplicative extends Applicative {
    constructor() {
        super(Apply.types.MaybeApply, Maybe.Just, 'Maybe', Applicative.types, 'maybe');
    }
}
modules.push(MaybeApplicative);
class MaybeAlt extends Alt {
    constructor() {
        super(Functor.types.MaybeFunctor, (a, b) => a.isNothing() ? b : a, 'Maybe', Alt.types, 'maybe');
    }
}
modules.push(MaybeAlt);
class MaybePlus extends Plus {
    constructor() {
        super(Alt.types.MaybeAlt, Maybe.Nothing, 'Maybe', Plus.types, 'maybe');
    }
}
modules.push(MaybePlus);
class MaybeAlternative extends Alternative {
    constructor() {
        super(Applicative.types.MaybeApplicative, Plus.types.MaybePlus, 'Maybe', Alternative.types, 'maybe');
    }
}
modules.push(MaybeAlternative);
class MaybeChain extends Chain {
    constructor() {
        super(Apply.types.MaybeApply, (f, m) => m.isJust() ? f(m.value) : m, 'Maybe', Chain.types, 'maybe');
    }
}
modules.push(MaybeChain);
class MaybeChainRec extends ChainRec {
    constructor() {
        super(Chain.types.MaybeChain, (f, i) => {
            let result = f(ChainRec.next, ChainRec.done, i);
            while (result.isJust() && result.value.tag === 'next') {
                result = f(ChainRec.next, ChainRec.done, result.value.value);
            }
            return result.isNothing() ? result : Maybe.Just(result.value.value);
        }, 'Maybe', ChainRec.types, 'maybe');
    }
}
modules.push(MaybeChainRec);
class MaybeMonad extends Monad {
    constructor() {
        super(Applicative.types.MaybeApplicative, Chain.types.MaybeChain, 'Maybe', Monad.types, 'maybe');
    }
}
modules.push(MaybeMonad);
class MaybeFoldable extends Foldable {
    constructor() {
        super((f, init, m) => m.isJust() ? f(init, m.value) : init, 'Maybe', Foldable.types, 'maybe');
    }
}
modules.push(MaybeFoldable);
class MaybeTraversable extends Traversable {
    constructor() {
        super(Functor.types.MaybeFunctor, Foldable.types.MaybeFoldable, (applicative, f, m) =>
            m.isJust() ? applicative.map(Maybe.Just, f(m.value)) : applicative.of(m)
            , 'Maybe', Traversable.types, 'maybe');
    }
}
modules.push(MaybeTraversable);
/* Either */
class Either {
    isLeft() { return false; }
    isRight() { return false; }
}
class Left extends Either {
    constructor(value) { super(); this.value = value; this._typeName = 'Either'; }
    isLeft() { return true; }
    map(f) { return Functor.of('either').map(f, this); }
    chain(f) { return Chain.of('either').chain(f, this); }
}
class Right extends Either {
    constructor(value) { super(); this.value = value; this._typeName = 'Either'; }
    isRight() { return true; }
    map(f) { return Functor.of('either').map(f, this); }
    chain(f) { return Chain.of('either').chain(f, this); }
}
Either.prototype[Symbols.Either] = true;
Either.Left = x => new Left(x);
Either.Right = x => new Right(x);
Either.of = x => new Right(x);
Either.isEither = x => x != null && x[Symbols.Either] === true;
Either.isLeft = x => Either.isEither(x) && x.isLeft();
Either.isRight = x => Either.isEither(x) && x.isRight();
Either.fromNullable = x => x == null ? Either.Left(null) : Either.Right(x);
Either.fold = (onLeft, onRight, e) => e.isLeft() ? onLeft(e.value) : onRight(e.value);
Either.catch = runCatch(f => Either.Right(f()), Either.Left);
class EitherSemigroupoid extends Semigroupoid {
    constructor() {
        super((f, g) => x => Chain.types.EitherChain.chain(f, g(x)), 'function', Semigroupoid.types, 'either');
    }
}
modules.push(EitherSemigroupoid);
class EitherCategory extends Category {
    constructor() {
        super(Semigroupoid.types.EitherSemigroupoid, Either.Right, 'function', Category.types, 'either');
    }
}
modules.push(EitherCategory);
class EitherFilterable extends Filterable {
    constructor() {
        super((pred, e, onFalse = identity) => e.isLeft() ? e : (pred(e.value) ? e : Either.Left(onFalse(e.value))), 'Either', Filterable.types, 'either');
    }
}
modules.push(EitherFilterable);
class EitherFunctor extends Functor {
    constructor() {
        super((f, e) => e.isRight() ? Either.Right(f(e.value)) : e, 'Either', Functor.types, 'either');
    }
}
modules.push(EitherFunctor);
class EitherBifunctor extends Bifunctor {
    constructor() {
        super((f, g, e) => e.isLeft() ? Either.Left(f(e.value)) : Either.Right(g(e.value)),
            'Either', Bifunctor.types, 'either');
    }
}
modules.push(EitherBifunctor);
class EitherApply extends Apply {
    constructor() {
        super(Functor.types.EitherFunctor,
            (ef, ex) => ef.isLeft() ? ef : ex.isLeft() ? ex : Either.Right(ef.value(ex.value)),
            'Either', Apply.types, 'either');
    }
}
modules.push(EitherApply);
class EitherApplicative extends Applicative {
    constructor() {
        super(Apply.types.EitherApply, Either.Right, 'Either', Applicative.types, 'either');
    }
}
modules.push(EitherApplicative);
class EitherAlt extends Alt {
    constructor() {
        super(Functor.types.EitherFunctor, (a, b) => a.isLeft() ? b : a, 'Either', Alt.types, 'either');
    }
}
modules.push(EitherAlt);
class EitherChain extends Chain {
    constructor() {
        super(Apply.types.EitherApply, (f, e) => e.isRight() ? f(e.value) : e, 'Either', Chain.types, 'either');
    }
}
modules.push(EitherChain);
class EitherChainRec extends ChainRec {
    constructor() {
        super(Chain.types.EitherChain, (f, i) => {
            let result = f(ChainRec.next, ChainRec.done, i);
            while (result.isRight() && result.value.tag === 'next') {
                result = f(ChainRec.next, ChainRec.done, result.value.value);
            }
            return result.isLeft() ? result : Either.Right(result.value.value);
        }, 'Either', ChainRec.types, 'either');
    }
}
modules.push(EitherChainRec);
class EitherMonad extends Monad {
    constructor() {
        super(Applicative.types.EitherApplicative, Chain.types.EitherChain, 'Either', Monad.types, 'either');
    }
}
modules.push(EitherMonad);
class EitherFoldable extends Foldable {
    constructor() {
        super((f, init, e) => e.isRight() ? f(init, e.value) : init, 'Either', Foldable.types, 'either');
    }
}
modules.push(EitherFoldable);
class EitherTraversable extends Traversable {
    constructor() {
        super(Functor.types.EitherFunctor, Foldable.types.EitherFoldable, (applicative, f, e) =>
            e.isRight() ? applicative.map(Either.Right, f(e.value)) : applicative.of(e)
            , 'Either', Traversable.types, 'either');
    }
}
modules.push(EitherTraversable);
/* Task */
class Task {
    constructor(computation) {
        // fork를 1회 settle로 래핑하여 다중 호출 방지
        this.fork = (reject, resolve) => {
            let settled = false;
            try {
                computation(
                    e => { if (settled) return; settled = true; reject(e); },
                    v => { if (settled) return; settled = true; resolve(v); }
                );
            } catch (e) {
                if (!settled) { settled = true; reject(e); }
            }
        };
        this._typeName = 'Task';
    }
    map(f) { return Functor.of('task').map(f, this); }
    chain(f) { return Chain.of('task').chain(f, this); }
}
Task.prototype[Symbols.Task] = true;
const settledFork = (task, onReject, onResolve) => {
    let settled = false;
    task.fork(
        e => { if (!settled) { settled = true; onReject(e); } },
        v => { if (!settled) { settled = true; onResolve(v); } }
    );
};
const createSettledGuard = () => {
    let settled = false;
    return {
        isSettled: () => settled,
        guard: callback => (...args) => {
            if (settled) return;
            settled = true;
            callback(...args);
        },
        check: callback => (...args) => {
            if (settled) return;
            callback(...args);
        }
    };
};
Task.of = x => new Task((_, resolve) => resolve(x));
Task.rejected = x => new Task((reject, _) => reject(x));
Task.isTask = x => x != null && x[Symbols.Task] === true;
Task.fold = (onRejected, onResolved, task) => task.fork(onRejected, onResolved);
Task.fromPromise = promiseFn => (...args) => new Task((reject, resolve) => {
    try {
        const result = promiseFn(...args);
        if (result && typeof result.then === 'function') {
            result.then(resolve).catch(reject);
        } else {
            resolve(result); // non-Promise 값은 그대로 resolve
        }
    } catch (e) {
        reject(e); // 즉시 throw 시 reject
    }
});
Task.fromEither = e => e.isRight() ? Task.of(e.value) : Task.rejected(e.value);
Task.all = tasks => new Task((reject, resolve) => {
    const list = Array.isArray(tasks) ? tasks : [tasks];
    if (list.length === 0) return resolve([]);
    if (!list.every(Task.isTask)) raise(new TypeError('Task.all: all elements must be Task'));
    const results = new Array(list.length);
    let completed = 0, done = false;
    list.forEach((t, i) => {
        t.fork(
            e => { if (done) return; done = true; reject(e); },
            v => {
                if (done) return;
                results[i] = v;
                completed++;
                if (completed === list.length) {
                    done = true;
                    resolve(results);
                }
            }
        );
    });
});
Task.race = tasks => new Task((reject, resolve) => {
    const list = Array.isArray(tasks) ? tasks : [tasks];
    if (list.length === 0) return reject(new Error('race: empty task list'));
    if (!list.every(Task.isTask)) raise(new TypeError('Task.race: all elements must be Task'));
    let done = false;
    list.forEach(t => t.fork(e => { if (!done) { done = true; reject(e); } }, v => { if (!done) { done = true; resolve(v); } }));
});
class TaskSemigroupoid extends Semigroupoid {
    constructor() {
        super((f, g) => x => Chain.types.TaskChain.chain(f, g(x)), 'function', Semigroupoid.types, 'task');
    }
}
modules.push(TaskSemigroupoid);
class TaskCategory extends Category {
    constructor() {
        super(Semigroupoid.types.TaskSemigroupoid, Task.of, 'function', Category.types, 'task');
    }
}
modules.push(TaskCategory);
class TaskFilterable extends Filterable {
    constructor() {
        super((pred, t) => new Task((reject, resolve) =>
            t.fork(reject, x => pred(x) ? resolve(x) : reject(x))
        ), 'Task', Filterable.types, 'task');
    }
}
modules.push(TaskFilterable);
class TaskFunctor extends Functor {
    constructor() {
        super((f, task) => new Task((reject, resolve) => {
            settledFork(task, reject, x => resolve(f(x)));
        }), 'Task', Functor.types, 'task');
    }
}
modules.push(TaskFunctor);
class TaskApply extends Apply {
    constructor() {
        super(Functor.types.TaskFunctor, (taskFn, taskVal) => new Task((reject, resolve) => {
            const g = createSettledGuard();
            let func, value, funcReady = false, valueReady = false;
            const tryResolve = () => {
                if (funcReady && valueReady) {
                    try { g.guard(resolve)(func(value)); }
                    catch (e) { g.guard(reject)(e); }
                }
            };
            taskFn.fork(g.guard(reject), g.check(f => { func = f; funcReady = true; tryResolve(); }));
            taskVal.fork(g.guard(reject), g.check(v => { value = v; valueReady = true; tryResolve(); }));
        }), 'Task', Apply.types, 'task');
    }
}
modules.push(TaskApply);
class TaskApplicative extends Applicative {
    constructor() {
        super(Apply.types.TaskApply, Task.of, 'Task', Applicative.types, 'task');
    }
}
modules.push(TaskApplicative);
class TaskAlt extends Alt {
    constructor() {
        super(Functor.types.TaskFunctor, (a, b) => new Task((reject, resolve) => {
            const g = createSettledGuard();
            a.fork(
                g.check(_ => b.fork(g.guard(reject), g.guard(resolve))),
                g.guard(resolve)
            );
        }), 'Task', Alt.types, 'task');
    }
}
modules.push(TaskAlt);
class TaskChain extends Chain {
    constructor() {
        super(Apply.types.TaskApply,
            (f, task) => new Task((reject, resolve) => {
                const g = createSettledGuard();
                task.fork(
                    g.guard(reject),
                    g.check(x => {
                        try { f(x).fork(g.guard(reject), g.guard(resolve)); }
                        catch (e) { g.guard(reject)(e); }
                    })
                );
            }),
            'Task', Chain.types, 'task');
    }
}
modules.push(TaskChain);
class TaskChainRec extends ChainRec {
    constructor() {
        super(Chain.types.TaskChain,
            (f, initial) => new Task((reject, resolve) => {
                const loop = current => {
                    try {
                        f(ChainRec.next, ChainRec.done, current)
                            .fork(reject, result => {
                                result.tag === 'next' ? loop(result.value) : resolve(result.value);
                            });
                    } catch (e) { reject(e); }
                };
                loop(initial);
            }), 'Task', ChainRec.types, 'task');
    }
}
modules.push(TaskChainRec);
class TaskMonad extends Monad {
    constructor() {
        super(Applicative.types.TaskApplicative, Chain.types.TaskChain, 'Task', Monad.types, 'task');
    }
}
modules.push(TaskMonad);
/* Validation */
class Validation {
    isValid() { return false; }
    isInvalid() { return false; }
}
class Valid extends Validation {
    constructor(value) { super(); this.value = value; this._typeName = 'Validation'; }
    isValid() { return true; }
    map(f) { return Functor.of('validation').map(f, this); }
}
class Invalid extends Validation {
    constructor(errors, monoid = Monoid.of('array')) {
        super();
        this.errors = errors;
        this.monoid = monoid;
        this._typeName = 'Validation';
    }
    isInvalid() { return true; }
    map(f) { return this; }
}
Validation.prototype[Symbols.Validation] = true;
Validation.Valid = x => new Valid(x);
Validation.Invalid = (errors, monoid) => new Invalid(errors, monoid);
Validation.of = x => new Valid(x);
Validation.isValidation = x => x != null && x[Symbols.Validation] === true;
Validation.isValid = x => Validation.isValidation(x) && x.isValid();
Validation.isInvalid = x => Validation.isValidation(x) && x.isInvalid();
Validation.fromEither = (e, monoid) => e.isRight()
    ? Validation.Valid(e.value)
    : Validation.Invalid(e.value, monoid);
Validation.prototype.toEither = function () {
    return this.isValid() ? Either.Right(this.value) : Either.Left(this.errors);
};
Validation.fold = (onInvalid, onValid, v) =>
    v.isValid() ? onValid(v.value) : onInvalid(v.errors);
Validation.map = (f, v) => Functor.of('validation').map(f, v);
Validation.ap = (vf, va) => Apply.of('validation').ap(vf, va);
Validation.bimap = (f, g, v) => Bifunctor.of('validation').bimap(f, g, v);
Validation.reduce = (f, init, v) => Foldable.of('validation').reduce(f, init, v);
Validation.collect = (...validators) => f => (...args) => {
    if (validators.length === 0) return Validation.Valid(f());
    const validations = validators.map((validator, i) => {
        const result = validator(args[i]);
        return result.isRight()
            ? Validation.Valid(result.value)
            : Validation.Invalid([result.value]); // wrap in array for Monoid.of('array')
    });
    const curriedF = curry(f, validators.length);
    return validations.reduce(
        (acc, v) => Apply.of('validation').ap(acc, v),
        Validation.Valid(curriedF)
    );
};
class ValidationFunctor extends Functor {
    constructor() {
        super((f, v) => v.isValid() ? Validation.Valid(f(v.value)) : v,
            'Validation', Functor.types, 'validation');
    }
}
modules.push(ValidationFunctor);
class ValidationBifunctor extends Bifunctor {
    constructor() {
        super((f, g, v) => v.isInvalid()
            ? Validation.Invalid(f(v.errors), v.monoid)
            : Validation.Valid(g(v.value)),
            'Validation', Bifunctor.types, 'validation');
    }
}
modules.push(ValidationBifunctor);
class ValidationApply extends Apply {
    constructor() {
        super(Functor.types.ValidationFunctor,
            (vf, va) => {
                if (vf.isInvalid() && va.isInvalid()) {
                    const monoid = vf.monoid;
                    return Validation.Invalid(
                        monoid.concat(vf.errors, va.errors),
                        monoid
                    );
                }
                if (vf.isInvalid()) return vf;
                if (va.isInvalid()) return va;
                return Validation.Valid(vf.value(va.value));
            },
            'Validation', Apply.types, 'validation');
    }
}
modules.push(ValidationApply);
class ValidationApplicative extends Applicative {
    constructor() {
        super(Apply.types.ValidationApply, Validation.Valid,
            'Validation', Applicative.types, 'validation');
    }
}
modules.push(ValidationApplicative);
class ValidationFoldable extends Foldable {
    constructor() {
        super((f, init, v) => v.isValid() ? f(init, v.value) : init,
            'Validation', Foldable.types, 'validation');
    }
}
modules.push(ValidationFoldable);
/* Reader */
class Reader {
    constructor(run) {
        types.checkFunction(run, 'Reader');
        this._run = run;
        this._typeName = 'Reader';
    }
    run(env) { return this._run(env); }
    map(f) { return Functor.of('reader').map(f, this); }
    chain(f) { return Chain.of('reader').chain(f, this); }
}
Reader.prototype[Symbols.Reader] = true;
Reader.of = x => new Reader(_ => x);
Reader.isReader = x => x != null && x[Symbols.Reader] === true;
Reader.ask = new Reader(env => env);
Reader.asks = f => new Reader(env => f(env));
Reader.local = (f, reader) => new Reader(env => reader.run(f(env)));
class ReaderFunctor extends Functor {
    constructor() {
        super((f, r) => new Reader(env => f(r.run(env))), 'Reader', Functor.types, 'reader');
    }
}
modules.push(ReaderFunctor);
class ReaderApply extends Apply {
    constructor() {
        super(Functor.types.ReaderFunctor,
            (rf, ra) => new Reader(env => rf.run(env)(ra.run(env))),
            'Reader', Apply.types, 'reader');
    }
}
modules.push(ReaderApply);
class ReaderApplicative extends Applicative {
    constructor() {
        super(Apply.types.ReaderApply, Reader.of, 'Reader', Applicative.types, 'reader');
    }
}
modules.push(ReaderApplicative);
class ReaderChain extends Chain {
    constructor() {
        super(Apply.types.ReaderApply,
            (f, r) => new Reader(env => f(r.run(env)).run(env)),
            'Reader', Chain.types, 'reader');
    }
}
modules.push(ReaderChain);
class ReaderMonad extends Monad {
    constructor() {
        super(Applicative.types.ReaderApplicative, Chain.types.ReaderChain, 'Reader', Monad.types, 'reader');
    }
}
modules.push(ReaderMonad);
/* Writer */
class Writer {
    constructor(value, output, monoid = Monoid.of('array')) {
        this.value = value;
        this.output = output;
        this.monoid = monoid;
        this._typeName = 'Writer';
    }
    run() { return [this.value, this.output]; }
    exec() { return this.value; }
    map(f) { return Functor.of('writer').map(f, this); }
    chain(f) { return Chain.of('writer').chain(f, this); }
}
Writer.prototype[Symbols.Writer] = true;
Writer.of = (x, monoid = Monoid.of('array')) => new Writer(x, monoid.empty(), monoid);
Writer.isWriter = x => x != null && x[Symbols.Writer] === true;
Writer.tell = (output, monoid = Monoid.of('array')) => new Writer(undefined, output, monoid);
Writer.listen = w => new Writer([w.value, w.output], w.output, w.monoid);
Writer.listens = (f, w) => new Writer([w.value, f(w.output)], w.output, w.monoid);
Writer.pass = w => {
    const [a, f] = w.value;
    return new Writer(a, f(w.output), w.monoid);
};
Writer.censor = (f, w) => new Writer(w.value, f(w.output), w.monoid);
class WriterFunctor extends Functor {
    constructor() {
        super((f, w) => new Writer(f(w.value), w.output, w.monoid), 'Writer', Functor.types, 'writer');
    }
}
modules.push(WriterFunctor);
class WriterApply extends Apply {
    constructor() {
        super(Functor.types.WriterFunctor,
            (wf, wa) => new Writer(wf.value(wa.value), wf.monoid.concat(wf.output, wa.output), wf.monoid),
            'Writer', Apply.types, 'writer');
    }
}
modules.push(WriterApply);
class WriterApplicative extends Applicative {
    constructor() {
        super(Apply.types.WriterApply, Writer.of, 'Writer', Applicative.types, 'writer');
    }
}
modules.push(WriterApplicative);
class WriterChain extends Chain {
    constructor() {
        super(Apply.types.WriterApply,
            (f, w) => {
                const next = f(w.value);
                return new Writer(next.value, w.monoid.concat(w.output, next.output), w.monoid);
            },
            'Writer', Chain.types, 'writer');
    }
}
modules.push(WriterChain);
class WriterMonad extends Monad {
    constructor() {
        super(Applicative.types.WriterApplicative, Chain.types.WriterChain, 'Writer', Monad.types, 'writer');
    }
}
modules.push(WriterMonad);
/* State */
class State {
    constructor(run) {
        types.checkFunction(run, 'State');
        this._run = run;
        this._typeName = 'State';
    }
    run(s) { return this._run(s); }
    eval(s) { return this.run(s)[0]; }
    exec(s) { return this.run(s)[1]; }
    map(f) { return Functor.of('state').map(f, this); }
    chain(f) { return Chain.of('state').chain(f, this); }
}
State.prototype[Symbols.State] = true;
State.of = x => new State(s => [x, s]);
State.isState = x => x != null && x[Symbols.State] === true;
State.get = new State(s => [s, s]);
State.put = s => new State(_ => [undefined, s]);
State.modify = f => new State(s => [undefined, f(s)]);
State.gets = f => new State(s => [f(s), s]);
class StateFunctor extends Functor {
    constructor() {
        super((f, st) => new State(s => {
            const [a, s2] = st.run(s);
            return [f(a), s2];
        }), 'State', Functor.types, 'state');
    }
}
modules.push(StateFunctor);
class StateApply extends Apply {
    constructor() {
        super(Functor.types.StateFunctor,
            (sf, sa) => new State(s => {
                const [f, s2] = sf.run(s);
                const [a, s3] = sa.run(s2);
                return [f(a), s3];
            }),
            'State', Apply.types, 'state');
    }
}
modules.push(StateApply);
class StateApplicative extends Applicative {
    constructor() {
        super(Apply.types.StateApply, State.of, 'State', Applicative.types, 'state');
    }
}
modules.push(StateApplicative);
class StateChain extends Chain {
    constructor() {
        super(Apply.types.StateApply,
            (f, st) => new State(s => {
                const [a, s2] = st.run(s);
                return f(a).run(s2);
            }),
            'State', Chain.types, 'state');
    }
}
modules.push(StateChain);
class StateMonad extends Monad {
    constructor() {
        super(Applicative.types.StateApplicative, Chain.types.StateChain, 'State', Monad.types, 'state');
    }
}
modules.push(StateMonad);
/* Utilities */
const sequence = (traversable, applicative, u) => {
    if (!traversable || typeof traversable.traverse !== 'function') {
        raise(new TypeError('sequence: first argument must be a Traversable with traverse method'));
    }
    if (!types.check(u, traversable.type)) {
        raise(new TypeError(`sequence: u must be ${traversable.type}`));
    }
    return traversable.traverse(applicative, identity, u);
};
const foldMap = (foldable, monoid) => {
    if (!(foldable && foldable[Symbols.Foldable] === true)) {
        raise(new TypeError('foldMap: first argument must be a Foldable'));
    }
    if (!(monoid && monoid[Symbols.Monoid] === true)) {
        raise(new TypeError('foldMap: second argument must be a Monoid'));
    }
    return f => fa => foldable.reduce(
        (acc, a) => monoid.concat(acc, types.checkFunction(f, 'foldMap')(a)),
        monoid.empty(),
        fa
    );
};
const lift = applicative => {
    if (!(applicative && applicative[Symbols.Applicative] === true)) {
        raise(new TypeError('lift: first argument must be an Applicative'));
    }
    return f => (...args) => {
        types.checkFunction(f, 'lift');
        if (args.length === 0) return applicative.of(f());
        return args.slice(1).reduce((acc, arg) => applicative.ap(acc, arg), applicative.map(curry(f, args.length), args[0]));
    };
};
const pipeK = (monad, foldable = Foldable.of('array')) => {
    if (!(monad && monad[Symbols.Monad] === true)) {
        raise(new TypeError('pipeK: first argument must be a Monad'));
    }
    if (!(foldable && foldable[Symbols.Foldable] === true)) {
        raise(new TypeError('pipeK: second argument must be a Foldable'));
    }
    return fns => x => foldable.reduce((acc, fn) => monad.chain(types.checkFunction(fn, 'pipeK'), acc), monad.of(x), fns);
};
const composeK = (monad, foldable = Foldable.of('array')) => {
    if (!(monad && monad[Symbols.Monad] === true)) {
        raise(new TypeError('composeK: first argument must be a Monad'));
    }
    if (!(foldable && foldable[Symbols.Foldable] === true)) {
        raise(new TypeError('composeK: second argument must be a Foldable'));
    }
    return fns => pipeK(monad, foldable)(fns.slice().reverse());
};
Maybe.toEither = (defaultLeft, m) => m.isJust() ? Either.Right(m.value) : Either.Left(defaultLeft);
Maybe.pipe = (m, ...fns) => {
    if (!Maybe.isMaybe(m)) raise(new TypeError('Maybe.pipe: first argument must be a Maybe'));
    return fns.reduce((acc, fn) => {
        if (!Maybe.isMaybe(acc)) return acc;
        return acc.isJust() ? fn(acc) : acc;
    }, m);
};
Either.toMaybe = e => e.isRight() ? Maybe.Just(e.value) : Maybe.Nothing();
Either.pipe = (e, ...fns) => {
    if (!Either.isEither(e)) raise(new TypeError('Either.pipe: first argument must be an Either'));
    return fns.reduce((acc, fn) => {
        if (!Either.isEither(acc)) return acc;
        return acc.isRight() ? fn(acc) : acc;
    }, e);
};
const { transducer } = (() => {
    class Reduced {
        constructor(value) {
            this.value = value;
            this[Symbols.Reduced] = true;
        }
        static of(value) { return new Reduced(value); }
        static isReduced(value) { return value != null && value[Symbols.Reduced] === true; }
    }
    const transduce = transducer => reducer => initialValue => collection => {
        if (!types.isIterable(collection)) {
            raise(new TypeError(`transduce: expected an iterable, but got ${typeof collection}`));
        }
        const transformedReducer = types.checkFunction(transducer, 'transducer.transduce:transducer')(types.checkFunction(reducer, 'transducer.transduce:reducer'));
        let accumulator = initialValue;
        for (const item of collection) {
            accumulator = transformedReducer(accumulator, item);
            if (Reduced.isReduced(accumulator)) {
                return accumulator.value;
            }
        }
        return accumulator;
    };
    const map = f => reducer => (acc, val) => types.checkFunction(reducer, 'transducer.map:reducer')(acc, types.checkFunction(f, 'transducer.map:f')(val));
    const filter = p => reducer => (acc, val) => types.checkFunction(p, 'transducer.filter:p')(val) ? types.checkFunction(reducer, 'transducer.filter:reducer')(acc, val) : acc;
    const take = count => {
        if (typeof count !== 'number' || !Number.isInteger(count) || count < 1) {
            raise(new TypeError(`transducer.take: expected a positive integer (>= 1), but got ${count}`));
        }
        return reducer => {
            let taken = 0;
            return (accumulator, value) => {
                if (taken < count) {
                    taken++;
                    const result = reducer(accumulator, value);
                    return taken === count ? Reduced.of(result) : result;
                }
                return Reduced.of(accumulator);
            };
        };
    };
    return {
        transducer: {
            Reduced, of: Reduced.of, isReduced: Reduced.isReduced, transduce, map, filter, take,
        },
    };
})();
const { Free, trampoline } = (() => {
    const reentrantGuard = (runner, f, onReentry = f) => {
        let active = false;
        return (...args) => {
            if (active) return onReentry(...args);
            active = true;
            return runCatch(
                () => {
                    const result = runner(f(...args));
                    if (result instanceof Promise || (result && typeof result.then === 'function')) {
                        return result.finally(() => { active = false; });
                    }
                    active = false;
                    return result;
                },
                e => { active = false; throw e; }
            )();
        };
    };
    class Free {
        static of(x) { return new Pure(x); }
        static pure(x) { return new Pure(x); }
        static impure(functor) {
            functor[Symbols.Functor] || raise(new Error('Free.impure: expected a functor'));
            return new Impure(functor);
        }
        static isPure(x) { return x != null && x[Symbols.Pure] === true; }
        static isImpure(x) { return x != null && x[Symbols.Impure] === true; }
        static isFree(x) { return Free.isPure(x) || Free.isImpure(x); }
        static liftF(command) {
            command[Symbols.Functor] || raise(new Error('Free.liftF: expected a functor'));
            return Free.isFree(command)
                ? command
                : Free.impure(command.map(Free.pure));
        }
        static *runGenerator(runner, program) {
            let step = program;
            while (Free.isImpure(step)) {
                step = yield runner(step.functor);
                if (Free.isPure(step) && Free.isFree(step.value)) {
                    step = step.value;
                }
            }
            return Free.isPure(step) ? step.value : step;
        }
        static runSync(runner) {
            return target => {
                const execute = program => {
                    const gen = Free.runGenerator(runner, program);
                    let result = gen.next();
                    while (!result.done) {
                        result = gen.next(result.value);
                    }
                    return result.value;
                };
                return typeof target === 'function' ? reentrantGuard(execute, target) : execute(target);
            };
        }
        static runAsync(runner) {
            return target => {
                const execute = async program => {
                    const gen = Free.runGenerator(runner, program);
                    let result = gen.next();
                    while (!result.done) {
                        result = gen.next(await result.value);
                    }
                    return result.value;
                };
                return typeof target === 'function' ? reentrantGuard(execute, target) : execute(target);
            };
        }
        static runWithTask(runner) {
            return program => new Promise((resolve, reject) => {
                const step = free => {
                    if (Free.isPure(free)) return resolve(free.value);
                    if (Free.isImpure(free)) {
                        runner(free.functor).fork(reject, step);
                    } else {
                        reject(new Error('runWithTask: unknown Free type'));
                    }
                };
                step(program);
            });
        }
    }
    class Pure extends Free {
        constructor(value) {
            super();
            this.value = value;
            this._typeName = 'Free';
            this[Symbol.toStringTag] = 'Pure';
            this[Symbols.Pure] = true;
        }
        map(f) { return Functor.of('free').map(f, this); }
        chain(f) { return Chain.of('free').chain(f, this); }
    }
    class Impure extends Free {
        constructor(functor) {
            super();
            functor[Symbols.Functor] || raise(new Error('Impure: expected a functor'));
            this.functor = functor;
            this._typeName = 'Free';
            this[Symbol.toStringTag] = 'Impure';
            this[Symbols.Impure] = true;
        }
        map(f) { return Functor.of('free').map(f, this); }
        chain(f) { return Chain.of('free').chain(f, this); }
    }
    Free.prototype[Symbols.Free] = true;
    class Thunk {
        constructor(f) {
            types.checkFunction(f, 'Thunk');
            this.f = f;
            this[Symbol.toStringTag] = 'Thunk';
            this[Symbols.Functor] = true;
        }
        map(g) { return new Thunk(compose2(g, this.f)); }
        run() { return this.f(); }
        static of(f) { return new Thunk(f); }
        static done(value) { return Free.pure(value); }
        static suspend(f) { return Free.liftF(new Thunk(f)); }
    }
    const trampoline = Free.runSync(thunk => thunk.run());
    Free.Pure = Pure;
    Free.Impure = Impure;
    Free.Thunk = Thunk;
    Free.trampoline = trampoline;
    return { Free, trampoline };
})();
/* Free Static Land */
class FreeFunctor extends Functor {
    constructor() {
        super(
            (f, free) => Free.isPure(free)
                ? Free.pure(f(free.value))
                : Free.impure(free.functor.map(prevFree => Functor.of('free').map(f, prevFree))),
            'Free', Functor.types, 'free'
        );
    }
}
modules.push(FreeFunctor);
class FreeApply extends Apply {
    constructor() {
        super(
            Functor.types.FreeFunctor,
            (mf, mx) => Chain.of('free').chain(f => Functor.of('free').map(f, mx), mf),
            'Free', Apply.types, 'free'
        );
    }
}
modules.push(FreeApply);
class FreeApplicative extends Applicative {
    constructor() {
        super(Apply.types.FreeApply, Free.pure, 'Free', Applicative.types, 'free');
    }
}
modules.push(FreeApplicative);
class FreeChain extends Chain {
    constructor() {
        super(
            Apply.types.FreeApply,
            (f, free) => Free.isPure(free)
                ? f(free.value)
                : Free.impure(free.functor.map(prevFree => Chain.of('free').chain(f, prevFree))),
            'Free', Chain.types, 'free'
        );
    }
}
modules.push(FreeChain);
class FreeMonad extends Monad {
    constructor() {
        super(Applicative.types.FreeApplicative, Chain.types.FreeChain, 'Free', Monad.types, 'free');
    }
}
modules.push(FreeMonad);
load(...modules);

/* ═══════════════════════════════════════════════════════════════
   Static Methods (Eta Reduced)
   - load() 이후에 정의해야 TypeClass.of()가 정상 작동
   ═══════════════════════════════════════════════════════════════ */

// Functor
Maybe.map = Functor.of('maybe').map;
Either.map = Functor.of('either').map;
Task.map = Functor.of('task').map;
Reader.map = Functor.of('reader').map;
Writer.map = Functor.of('writer').map;
State.map = Functor.of('state').map;
Free.map = Functor.of('free').map;

// Apply
Maybe.ap = Apply.of('maybe').ap;
Either.ap = Apply.of('either').ap;
Task.ap = Apply.of('task').ap;
Reader.ap = Apply.of('reader').ap;
Writer.ap = Apply.of('writer').ap;
State.ap = Apply.of('state').ap;
Free.ap = Apply.of('free').ap;

// Chain
Maybe.chain = Chain.of('maybe').chain;
Either.chain = Chain.of('either').chain;
Task.chain = Chain.of('task').chain;
Reader.chain = Chain.of('reader').chain;
Writer.chain = Chain.of('writer').chain;
State.chain = Chain.of('state').chain;
Free.chain = Chain.of('free').chain;

// Alt
Maybe.alt = Alt.of('maybe').alt;
Either.alt = Alt.of('either').alt;
Task.alt = Alt.of('task').alt;

// Plus
Maybe.zero = () => Plus.of('maybe').zero();

// Filterable
Maybe.filter = Filterable.of('maybe').filter;
Task.filter = Filterable.of('task').filter;

// Foldable (3+ args - no eta reduction)
Maybe.reduce = (f, init, m) => Foldable.of('maybe').reduce(f, init, m);
Either.reduce = (f, init, e) => Foldable.of('either').reduce(f, init, e);

// Traversable (3+ args - no eta reduction)
Maybe.traverse = (applicative, f, m) => Traversable.of('maybe').traverse(applicative, f, m);
Either.traverse = (applicative, f, e) => Traversable.of('either').traverse(applicative, f, e);

// Bifunctor (3 args - no eta reduction)
Either.bimap = (f, g, e) => Bifunctor.of('either').bimap(f, g, e);

// Filterable with 3 args (no eta reduction)
Either.filter = (pred, e, onFalse) => Filterable.of('either').filter(pred, e, onFalse);

// ChainRec
Maybe.chainRec = ChainRec.of('maybe').chainRec;
Either.chainRec = ChainRec.of('either').chainRec;
Task.chainRec = ChainRec.of('task').chainRec;

// pipeK (현재 API 유지 - variadic)
Maybe.pipeK = (...fns) => pipeK(Monad.of('maybe'))(fns);
Either.pipeK = (...fns) => pipeK(Monad.of('either'))(fns);
Task.pipeK = (...fns) => pipeK(Monad.of('task'))(fns);
Reader.pipeK = (...fns) => pipeK(Monad.of('reader'))(fns);
Writer.pipeK = (...fns) => pipeK(Monad.of('writer'))(fns);
State.pipeK = (...fns) => pipeK(Monad.of('state'))(fns);
Free.pipeK = (...fns) => pipeK(Monad.of('free'))(fns);

// composeK (현재 API 유지 - variadic)
Maybe.composeK = (...fns) => composeK(Monad.of('maybe'))(fns);
Either.composeK = (...fns) => composeK(Monad.of('either'))(fns);
Task.composeK = (...fns) => composeK(Monad.of('task'))(fns);
Reader.composeK = (...fns) => composeK(Monad.of('reader'))(fns);
Writer.composeK = (...fns) => composeK(Monad.of('writer'))(fns);
State.composeK = (...fns) => composeK(Monad.of('state'))(fns);
Free.composeK = (...fns) => composeK(Monad.of('free'))(fns);

// lift (eta reduced)
Reader.lift = lift(Applicative.of('reader'));
Writer.lift = lift(Applicative.of('writer'));
State.lift = lift(Applicative.of('state'));
Free.lift = lift(Applicative.of('free'));

// lift (with error handling - cannot eta reduce)
Maybe.lift = f => runCatch(lift(Applicative.of('maybe'))(f), Maybe.Nothing);
Either.lift = f => runCatch(lift(Applicative.of('either'))(f), Either.Left);
Task.lift = f => runCatch(lift(Applicative.of('task'))(f), Task.rejected);

const extra = (() => {
    const path = keyStr => data => keyStr.split('.').map(k => k.trim()).reduce(
        (acc, key) => Chain.types.EitherChain.chain(obj => Either.fromNullable(obj[key]), acc),
        Either.fromNullable(data)
    );
    const template = (message, data) => message.replace(/\{\{([^}]+)\}\}/g,
        (match, keyStr) => Either.fold(_ => match, identity, path(keyStr)(data)));
    return { path, template };
})();

export default {
    Algebra, Setoid, Ord, Semigroup, Monoid, Group, Semigroupoid, Category,
    Filterable, Functor, Bifunctor, Contravariant, Profunctor,
    Apply, Applicative, Alt, Plus, Alternative, Chain, ChainRec, Monad, Foldable,
    Extend, Comonad, Traversable, Maybe, Either, Task, Free, Validation, Reader, Writer, State,
    identity, compose, compose2, sequence, foldMap, lift, pipeK, composeK, runCatch,
    constant, tuple, apply, unapply, unapply2, curry, curry2, uncurry, uncurry2,
    predicate, predicateN, negate, negateN,
    flip, flip2, flipCurried, flipCurried2, pipe, pipe2,
    tap, also, into, useOrLift, partial, once, converge, range, rangeBy, transducer, trampoline,
    extra, setStrictMode, setTapErrorHandler
};
