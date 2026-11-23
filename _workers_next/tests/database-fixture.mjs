import { DatabaseSync } from 'node:sqlite';
import { createRequire } from 'node:module';
import { readFileSync, existsSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import vm from 'node:vm';
import ts from 'typescript';

const require = createRequire(import.meta.url);
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const isDocker = Boolean(JSON.parse(readFileSync(path.join(root, 'package.json'), 'utf8')).dependencies['better-sqlite3']);
export const API_KEY = 'test-inventory-key-0123456789abcdef';

// Model D1's async API with a real, isolated SQLite database, including batch rollback.
function d1Binding(sqlite) {
    let pending = Promise.resolve();
    const prepare = (sql, params = []) => ({
        bind(...values) {
            if (values.length > 100) throw new Error('D1 parameter limit exceeded');
            return prepare(sql, values);
        },
        async all() { return { results: sqlite.prepare(sql).all(...params) }; },
        async first(column) {
            const row = sqlite.prepare(sql).get(...params);
            return row ? (column ? row[column] : row) : null;
        },
        async raw() { return sqlite.prepare(sql).all(...params).map((row) => Object.values(row)); },
        async run() {
            const statement = sqlite.prepare(sql);
            if (statement.columns().length) return { results: statement.all(...params), meta: { changes: 0 } };
            const result = statement.run(...params);
            return { results: [], meta: { changes: result.changes } };
        },
    });
    return {
        prepare,
        batch(statements) {
            const result = pending.then(async () => {
                sqlite.exec('BEGIN IMMEDIATE');
                try {
                    const results = [];
                    for (const statement of statements) results.push(await statement.run());
                    sqlite.exec('COMMIT');
                    return results;
                } catch (error) { sqlite.exec('ROLLBACK'); throw error; }
            });
            pending = result.catch(() => {});
            return result;
        },
    };
}

export function fixture(t, { env: overrides = {}, initialize = true, fetch: initialFetch, mocks: extraMocks = {}, globals = {} } = {}) {
    const directory = mkdtempSync(path.join(tmpdir(), 'ldc-db-test-'));
    const sqlite = isDocker ? null : new DatabaseSync(':memory:');
    sqlite?.exec('PRAGMA foreign_keys = ON');
    const binding = sqlite ? d1Binding(sqlite) : null;
    const env = {
        NODE_ENV: 'production', AUTH_SECRET: 'isolated-test-auth-secret', DATABASE_PATH: path.join(directory, 'test.sqlite'),
        INVENTORY_API_KEY: API_KEY, NEXT_PUBLIC_APP_URL: 'https://shop.example', ...overrides,
    };
    const invalidations = [];
    let networkFetch = initialFetch || (() => { throw new Error('Network disabled in database tests'); });
    const modules = new Map();
    const mocks = {
        '@opennextjs/cloudflare': { getCloudflareContext: () => ({ env: { DB: binding } }) },
        'next/cache': {
            revalidatePath: (value) => invalidations.push(value), revalidateTag: (value) => invalidations.push(value),
            updateTag() {}, unstable_cache: (fn) => fn,
            unstable_noStore() {},
        },
        react: { cache: (fn) => fn },
        'next/server': { after() {} },
        ...extraMocks,
    };
    function load(relative) {
        const resolved = (relative.endsWith('.json') ? [''] : ['.ts', '.tsx', '/index.ts']).map((suffix) => path.join(root, 'src', relative + suffix)).find(existsSync);
        if (!resolved) throw new Error(`Missing test module ${relative}`);
        if (modules.has(resolved)) return modules.get(resolved).exports;
        const loadedModule = { exports: {} };
        modules.set(resolved, loadedModule);
        if (resolved.endsWith('.json')) {
            loadedModule.exports = JSON.parse(readFileSync(resolved, 'utf8'));
            return loadedModule.exports;
        }
        const { outputText } = ts.transpileModule(readFileSync(resolved, 'utf8'), {
            compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022, esModuleInterop: true, jsx: ts.JsxEmit.ReactJSX },
        });
        vm.runInNewContext(outputText, {
            module: loadedModule, exports: loadedModule.exports,
            require: (name) => {
                if (mocks[name]) return mocks[name];
                if (name.startsWith('@/')) return load(name.slice(2));
                if (name.startsWith('.')) return load(path.relative(path.join(root, 'src'), path.resolve(path.dirname(resolved), name)));
                return require(name);
            },
            process: { env, cwd: () => root }, console: { log() {}, warn() {}, error() {} },
            crypto: globalThis.crypto, TextEncoder, TextDecoder, Request, Response, URL, Date,
            fetch: (...args) => {
                if (args[1]?.redirect === 'error') throw new TypeError('Workers fetch supports only follow or manual redirects');
                return networkFetch(...args);
            }, AbortSignal,
            setTimeout, clearTimeout, setInterval, clearInterval, atob, btoa, Buffer, URLSearchParams, ...globals,
        }, { filename: resolved });
        return loadedModule.exports;
    }
    const driver = load('lib/db/index');
    const schema = load('lib/db/schema');
    const queries = load('lib/db/queries');
    t.after(async () => {
        if (sqlite) sqlite.close();
        else driver.db.$client.close();
        rmSync(directory, { recursive: true, force: true });
    });
    return {
        ...driver, schema, queries, load, env, invalidations, isDocker,
        setFetch(fn) { networkFetch = fn; },
        reload(relative) {
            modules.delete(path.join(root, 'src', relative + '.ts'));
            return load(relative);
        },
        ready: initialize ? queries.ensureDatabaseInitialized() : Promise.resolve(),
    };
}
