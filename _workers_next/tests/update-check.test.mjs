import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { test } from 'node:test'
import vm from 'node:vm'
import ts from 'typescript'
import { basename } from 'node:path'
import { fileURLToPath } from 'node:url'

const packageJson = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8'))
const directory = basename(fileURLToPath(new URL('..', import.meta.url)))

function loadChecker(fetchMock, currentVersion = packageJson.version, admin = true) {
    const loaded = new Map()
    function load(relative) {
        if (loaded.has(relative)) return loaded.get(relative)
        const source = readFileSync(new URL(`../src/${relative}.ts`, import.meta.url), 'utf8')
        const { outputText } = ts.transpileModule(source, {
            compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022, esModuleInterop: true },
        })
        const exports = {}
        loaded.set(relative, exports)
        vm.runInNewContext(outputText, {
            exports,
            require: (name) => name === '../../package.json' ? { ...packageJson, version: currentVersion }
                : name === '@/actions/admin' ? { checkAdmin: async () => { if (!admin) throw new Error('Unauthorized') } } : load(name.slice(2)),
            fetch: fetchMock, Error, AbortSignal,
        }, { filename: relative })
        return exports
    }
    return { client: load('lib/update-check-client'), server: load('actions/update-check') }
}

for (const entry of ['client', 'server']) {
    const invoke = (checker, current) => entry === 'client' ? checker.client.checkForUpdatesClient(current) : checker.server.checkForUpdates()
    for (const [current, latest, hasUpdate] of [
        ['1.4.3', '1.4.3', false],
        ['1.4.2', '1.4.3', true],
        ['1.4.3', '1.4.1', false],
        ['1.9.0', '1.10.0', true],
        ['1.5.0-rc.1', '1.5.0-rc.2', true],
        ['1.5.0-rc.2', '1.5.0', true],
        ['1.5.0', '1.5.0-rc.2', false],
        ['1.4.3+local', '1.4.3+remote', false],
    ]) {
        test(`${entry}: own main manifest ${latest} compared to ${current}`, async () => {
            const requests = []
            const checker = loadChecker(async (url, options) => {
                requests.push({ url, options })
                return Response.json({ name: packageJson.name, version: latest })
            }, current)
            const result = await invoke(checker, current)
            assert.equal(result.hasUpdate, hasUpdate)
            assert.equal(result.currentVersion, current)
            assert.equal(result.latestVersion, latest)
            assert.equal(result.releaseUrl, `https://github.com/andlink01/ldc-shop/tree/main/${directory}`)
            assert.equal(requests.length, 1)
            assert.equal(requests[0].url, `https://raw.githubusercontent.com/andlink01/ldc-shop/main/${directory}/package.json`)
            assert.equal(requests[0].options.cache, 'no-store')
            assert.equal(requests[0].options.redirect, 'manual')
            assert.equal(requests[0].options.headers['User-Agent'], 'ldc-shop-update-check')
            assert.ok(requests[0].options.signal instanceof AbortSignal)
            assert.equal(result.error, undefined)
        })
    }

    test(`${entry}: missing manifest returns an error without using inherited tags or releases`, async () => {
        let calls = 0
        const checker = loadChecker(async () => { calls++; return new Response(null, { status: 404 }) })
        const result = await invoke(checker, packageJson.version)
        assert.equal(calls, 2)
        assert.equal(result.hasUpdate, false)
        assert.equal(result.latestVersion, null)
        assert.equal(result.releaseUrl, null)
        assert.equal(result.error, 'update.sourceUnavailable')
    })

    test(`${entry}: malformed manifests cannot masquerade as an up-to-date version`, async () => {
        for (const manifest of [null, [], {}, { version: 'invalid' }, { version: '01.4.3' }, { version: 143 }]) {
            const checker = loadChecker(async () => Response.json(manifest))
            const result = await invoke(checker, packageJson.version)
            assert.equal(result.hasUpdate, false)
            assert.equal(result.latestVersion, null)
            assert.ok(result.error)
        }
        const invalidJson = loadChecker(async () => new Response('{'))
        assert.ok((await invoke(invalidJson, packageJson.version)).error)
    })

    test(`${entry}: network failures preserve the installed version and report an error`, async () => {
        const checker = loadChecker(async () => { throw new Error('network failed') })
        const result = await invoke(checker, packageJson.version)
        assert.equal(result.currentVersion, packageJson.version)
        assert.equal(result.latestVersion, null)
        assert.equal(result.error, 'update.networkFailed')
    })

    test(`${entry}: raw-domain failures fall back to the same main manifest through GitHub API`, async () => {
        const calls = []
        const checker = loadChecker(async (url, options) => {
            calls.push(url)
            if (url.includes('raw.githubusercontent.com')) throw new Error('Blocked raw domain')
            assert.equal(url, `https://api.github.com/repos/andlink01/ldc-shop/contents/${directory}/package.json?ref=main`)
            assert.equal(options.headers.Accept, 'application/vnd.github.raw+json')
            return Response.json({ version: '9.0.0' })
        })
        const result = await invoke(checker, packageJson.version)
        assert.equal(calls.length, 2)
        assert.equal(result.latestVersion, '9.0.0')
        assert.equal(result.hasUpdate, true)
        assert.equal(result.error, undefined)
    })

    test(`${entry}: HTTP errors, redirects, invalid responses and timeouts are readable failures`, async () => {
        for (const [fetcher, error] of [
            [async () => new Response(null, { status: 429 }), 'update.rateLimited'],
            [async () => new Response(null, { status: 403 }), 'update.rateLimited'],
            [async () => new Response(null, { status: 302, headers: { Location: 'https://example.com' } }), 'update.sourceUnavailable'],
            [async () => Response.json({ content: 'not a raw manifest' }), 'update.invalidManifest'],
            [async () => { throw new DOMException('Timeout', 'TimeoutError') }, 'update.timedOut'],
        ]) {
            const result = await invoke(loadChecker(fetcher), packageJson.version)
            assert.equal(result.error, error)
            assert.equal(result.latestVersion, null)
            assert.equal(result.hasUpdate, false)
        }
    })
}

test('the browser uses the administrator Server Action and preserves the displayed version if the session fails', async () => {
    const checker = loadChecker(() => assert.fail('Unauthorized callers must not fetch'), packageJson.version, false)
    await assert.rejects(checker.server.checkForUpdates(), /Unauthorized/)
    const result = await checker.client.checkForUpdatesClient('1.5.4')
    assert.equal(result.currentVersion, '1.5.4')
    assert.equal(result.error, 'update.requestFailed')
    assert.equal(result.latestVersion, null)
})

test('server reports the installed version without contacting GitHub', async () => {
    const checker = loadChecker(() => assert.fail('Local version must not fetch'))
    assert.equal(await checker.server.getCurrentVersion(), packageJson.version)
})
