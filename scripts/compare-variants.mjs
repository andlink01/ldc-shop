import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const tracked = execFileSync('git', ['ls-files', '--cached', '--others', '--exclude-standard', '-z', '--', '_workers_next', '_docker'], {
    cwd: root, encoding: 'utf8',
}).split('\0').filter(Boolean);
const read = (file) => readFileSync(path.join(root, file), 'utf8').replace(/\r\n/g, '\n');
const workers = new Map(tracked.filter((file) => file.startsWith('_workers_next/'))
    .map((file) => [file.slice('_workers_next/'.length), read(file)]));
const docker = new Map(tracked.filter((file) => file.startsWith('_docker/'))
    .map((file) => [file.slice('_docker/'.length), read(file)]));

function compare(left, right) {
    const same = [], different = [], workersOnly = [], dockerOnly = [];
    for (const key of [...new Set([...left.keys(), ...right.keys()])].sort()) {
        if (!left.has(key)) dockerOnly.push(key);
        else if (!right.has(key)) workersOnly.push(key);
        else if (left.get(key) === right.get(key)) same.push(key);
        else different.push(key);
    }
    return {
        counts: {
            workers: left.size, docker: right.size, shared: same.length + different.length,
            identical: same.length, different: different.length,
            workersOnly: workersOnly.length, dockerOnly: dockerOnly.length,
        },
        different, workersOnly, dockerOnly,
    };
}

function subset(files, prefix) {
    return new Map([...files].filter(([file]) => file.startsWith(prefix)));
}

function flatten(value, prefix = '', entries = []) {
    for (const [key, item] of Object.entries(value)) {
        const name = prefix ? `${prefix}.${key}` : key;
        if (item && typeof item === 'object' && !Array.isArray(item)) flatten(item, name, entries);
        else entries.push([name, JSON.stringify(item)]);
    }
    return new Map(entries);
}

function exportedFunctions(files) {
    const names = new Map();
    for (const [file, source] of files) {
        for (const match of source.matchAll(/export\s+(?:async\s+)?function\s+(\w+)/g)) {
            names.set(`${file}:${match[1]}`, 'function');
        }
    }
    return names;
}

const workersPackage = JSON.parse(workers.get('package.json'));
const dockerPackage = JSON.parse(docker.get('package.json'));
const schemaVersion = (files) => Number(files.get('src/lib/db/queries.ts')
    .match(/const CURRENT_SCHEMA_VERSION = (\d+)/)[1]);
const tableNames = (files) => new Map([...files.get('src/lib/db/schema.ts')
    .matchAll(/sqliteTable\('([^']+)'/g)].map((match) => [match[1], 'table']));
const report = {
    sourceCommit: execFileSync('git', ['rev-parse', 'HEAD'], { cwd: root, encoding: 'utf8' }).trim(),
    method: 'Compare tracked and non-ignored untracked files by relative path after normalizing CRLF to LF; no other whitespace is ignored. Function and table inventories compare names only, not implementations.',
    versions: {
        workers: { package: workersPackage.version, schema: schemaVersion(workers) },
        docker: { package: dockerPackage.version, schema: schemaVersion(docker) },
    },
    allFiles: compare(workers, docker),
    sourceFiles: compare(subset(workers, 'src/'), subset(docker, 'src/')),
    dependencies: Object.fromEntries(['dependencies', 'devDependencies'].map((section) => [section,
        compare(new Map(Object.entries(workersPackage[section])), new Map(Object.entries(dockerPackage[section]))),
    ])),
    changedDependencyVersions: Object.fromEntries(['dependencies', 'devDependencies'].map((section) => [section,
        Object.fromEntries(Object.keys(workersPackage[section]).filter((name) =>
            dockerPackage[section][name] && workersPackage[section][name] !== dockerPackage[section][name])
            .map((name) => [name, { workers: workersPackage[section][name], docker: dockerPackage[section][name] }])),
    ])),
    actionFunctionNames: compare(exportedFunctions(subset(workers, 'src/actions/')), exportedFunctions(subset(docker, 'src/actions/'))),
    tableNames: compare(tableNames(workers), tableNames(docker)),
    locales: Object.fromEntries(['zh', 'en'].map((locale) => [locale,
        compare(flatten(JSON.parse(workers.get(`src/locales/${locale}.json`))),
            flatten(JSON.parse(docker.get(`src/locales/${locale}.json`)))),
    ])),
};
if (process.argv.includes('--summary')) {
    for (const key of ['allFiles', 'sourceFiles', 'actionFunctionNames', 'tableNames']) {
        report[key] = { counts: report[key].counts, workersOnly: report[key].workersOnly, dockerOnly: report[key].dockerOnly };
    }
    report.locales = Object.fromEntries(Object.entries(report.locales).map(([locale, comparison]) => [locale, comparison.counts]));
}
process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
