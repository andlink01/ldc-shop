import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { test } from 'node:test';

const workflow = fs.readFileSync(new URL('../.github/workflows/sync.yml', import.meta.url), 'utf8');
const scriptBlock = workflow.split(/          script: \|\r?\n/)[1];
assert.ok(scriptBlock, 'The sync workflow must contain its GitHub script');
const script = scriptBlock.replace(/^ {12}/gm, '');
const AsyncFunction = Object.getPrototypeOf(async function () {}).constructor;

function git(cwd, ...args) {
    return execFileSync('git', args, {
        cwd,
        encoding: 'utf8',
        stdio: ['ignore', 'pipe', 'pipe'],
        env: {
            ...process.env,
            GIT_AUTHOR_NAME: 'Sync test',
            GIT_AUTHOR_EMAIL: 'sync-test@example.invalid',
            GIT_COMMITTER_NAME: 'Sync test',
            GIT_COMMITTER_EMAIL: 'sync-test@example.invalid',
            GIT_TERMINAL_PROMPT: '0',
        },
    }).trim();
}

function commit(cwd, filename, content) {
    const destination = path.join(cwd, filename);
    fs.mkdirSync(path.dirname(destination), { recursive: true });
    fs.writeFileSync(destination, content);
    git(cwd, 'add', filename);
    git(cwd, 'commit', '-m', `Update ${filename}`);
    return git(cwd, 'rev-parse', 'HEAD');
}

function fixture(t) {
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'ldc-shop-sync-test-'));
    t.after(() => {
        const resolved = fs.realpathSync(directory);
        assert.equal(path.dirname(resolved).toLowerCase(), fs.realpathSync(os.tmpdir()).toLowerCase());
        assert.ok(path.basename(resolved).startsWith('ldc-shop-sync-test-'));
        fs.rmSync(resolved, { recursive: true, force: true });
    });
    const upstreamWork = path.join(directory, 'upstream-work');
    const upstream = path.join(directory, 'upstream.git');
    const origin = path.join(directory, 'origin.git');
    const work = path.join(directory, 'work');
    fs.mkdirSync(upstreamWork);
    git(upstreamWork, 'init', '--initial-branch=main');
    commit(upstreamWork, 'app.txt', 'original\n');
    git(directory, 'clone', '--bare', upstreamWork, upstream);
    git(upstreamWork, 'remote', 'add', 'origin', upstream);
    git(directory, 'clone', '--bare', upstream, origin);
    git(directory, 'clone', origin, work);

    return {
        directory, upstreamWork, upstream, origin, work,
        remoteHead: () => git(origin, 'rev-parse', 'refs/heads/main'),
        publishUpstream(filename, content) {
            const head = commit(upstreamWork, filename, content);
            git(upstreamWork, 'push', 'origin', 'main');
            return head;
        },
        publishCustom(filename, content) {
            const head = commit(work, filename, content);
            git(work, 'push', 'origin', 'main');
            return head;
        },
        async run(beforePush) {
            const failures = [];
            const localFs = {
                existsSync: (file) => fs.existsSync(path.join(work, file)),
                readFileSync: (file, encoding) => fs.readFileSync(path.join(work, file), encoding),
                writeFileSync: (file, content) => fs.writeFileSync(path.join(work, file), content),
            };
            await new AsyncFunction('require', 'exec', 'core', 'console', script)(
                (name) => {
                    if (name === 'fs') return localFs;
                    if (name === 'path') return path;
                    throw new Error(`Unexpected module: ${name}`);
                },
                {
                    async exec(command, args) {
                        assert.equal(command, 'git');
                        const localArgs = args.map((arg) => {
                            if (arg === 'https://github.com/chatgptuk/ldc-shop.git') return upstream;
                            if (arg === '--global') return '--local';
                            return arg;
                        });
                        if (localArgs[0] === 'push') await beforePush?.();
                        git(work, ...localArgs);
                    },
                },
                { setFailed: (message) => failures.push(message) },
                { log() {} },
            );
            return failures;
        },
    };
}

test('sync retains custom commits and D1 configuration while publishing upstream updates', async (t) => {
    const repo = fixture(t);
    const config = '{"d1_databases":[{"database_name":"user-shop","database_id":"test-only"}]}\n';
    const custom = repo.publishCustom('_workers_next/wrangler.json', config);
    const update = repo.publishUpstream('feature.txt', 'upstream feature\n');

    assert.deepEqual(await repo.run(), []);
    git(repo.origin, 'merge-base', '--is-ancestor', custom, 'main');
    git(repo.origin, 'merge-base', '--is-ancestor', update, 'main');
    assert.equal(git(repo.origin, 'show', 'main:_workers_next/wrangler.json'), config.trim());
    assert.equal(git(repo.origin, 'show', 'main:feature.txt'), 'upstream feature');
});

test('conflicting upstream changes fail without changing the remote branch', async (t) => {
    const repo = fixture(t);
    const custom = repo.publishCustom('app.txt', 'user customization\n');
    repo.publishUpstream('app.txt', 'conflicting upstream change\n');

    const failures = await repo.run();
    assert.equal(failures.length, 1);
    assert.equal(repo.remoteHead(), custom);
    assert.equal(git(repo.origin, 'show', 'main:app.txt'), 'user customization');
});

test('a concurrent remote update is preserved when the sync push is rejected', async (t) => {
    const repo = fixture(t);
    repo.publishCustom('custom.txt', 'user customization\n');
    repo.publishUpstream('feature.txt', 'upstream feature\n');
    let concurrent;

    const failures = await repo.run(() => {
        const other = path.join(repo.directory, 'other-work');
        git(repo.directory, 'clone', repo.origin, other);
        concurrent = commit(other, 'concurrent.txt', 'another contributor\n');
        git(other, 'push', 'origin', 'main');
    });
    assert.equal(failures.length, 1);
    assert.equal(repo.remoteHead(), concurrent);
    assert.equal(git(repo.origin, 'show', 'main:concurrent.txt'), 'another contributor');
});

for (const withD1Config of [false, true]) {
    test(`sync removes reintroduced Vercel files and retains both supported variants (D1 config: ${withD1Config})`, async (t) => {
        const repo = fixture(t);
        repo.publishCustom('AGENTS.md', 'Fork maintenance rules\n');
        if (withD1Config) {
            repo.publishCustom('_workers_next/wrangler.json', '{"d1_databases":[]}\n');
        }
        repo.publishUpstream('_workers_next/src/app/page.tsx', 'Workers app\n');
        repo.publishUpstream('_docker/src/app/page.tsx', 'Docker app\n');
        repo.publishUpstream('src/app/new/page.tsx', 'retired Vercel app\n');
        repo.publishUpstream('vercel.json', '{}\n');
        repo.publishUpstream('scripts/export-data.ts', 'retired export\n');

        assert.deepEqual(await repo.run(), []);
        const files = git(repo.origin, 'ls-tree', '-r', '--name-only', 'main').split('\n');
        assert.ok(!files.some((file) => file.startsWith('src/')));
        assert.ok(!files.includes('vercel.json'));
        assert.ok(!files.includes('scripts/export-data.ts'));
        assert.ok(files.includes('_workers_next/src/app/page.tsx'));
        assert.ok(files.includes('_docker/src/app/page.tsx'));
        assert.ok(files.includes('AGENTS.md'));
        assert.equal(git(repo.work, 'status', '--porcelain'), '');
    });
}
