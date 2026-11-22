import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { test } from 'node:test'
import vm from 'node:vm'
import ts from 'typescript'
import { basename } from 'node:path'
import { fileURLToPath } from 'node:url'

const packageJson = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8'))
const directory = basename(fileURLToPath(new URL('..', import.meta.url)))

function loadChecker(fetchMock, currentVersion = packageJson.version) {
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
            require: (name) => name === '../../package.json' ? { ...packageJson, version: currentVersion } : load(name.slice(2)),
            fetch: fetchMock, Error,
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
            assert.equal(result.error, undefined)
        })
    }

    test(`${entry}: missing manifest returns an error without using inherited tags or releases`, async () => {
        let calls = 0
        const checker = loadChecker(async () => { calls++; return new Response(null, { status: 404 }) })
        const result = await invoke(checker, packageJson.version)
        assert.equal(calls, 1)
        assert.equal(result.hasUpdate, false)
        assert.equal(result.latestVersion, null)
        assert.equal(result.releaseUrl, null)
        assert.match(result.error, /404/)
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
        assert.equal(result.error, 'network failed')
    })
}

test('server reports the installed version without contacting GitHub', async () => {
    const checker = loadChecker(() => assert.fail('Local version must not fetch'))
    assert.equal(await checker.server.getCurrentVersion(), packageJson.version)
})
