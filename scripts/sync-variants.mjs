import { readFileSync, readdirSync, mkdirSync, copyFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const workers = path.join(root, '_workers_next');
const docker = path.join(root, '_docker');
// Database drivers are the only platform-specific modules in src.
const platformFiles = new Set(['src/lib/db/index.ts']);
function files(dir, prefix = '') {
    return readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
        const relative = prefix ? `${prefix}/${entry.name}` : entry.name;
        return entry.isDirectory() ? files(path.join(dir, entry.name), relative) : [relative];
    });
}
const normalize = (file) => readFileSync(file, 'utf8').replace(/\r\n/g, '\n');
const write = process.argv.includes('--write');
const differences = [];
const sharedFiles = ['src', 'tests'].flatMap((dir) => files(path.join(workers, dir)).map((file) => `${dir}/${file}`));
sharedFiles.push('eslint.config.mjs');
for (const file of sharedFiles) {
    if (platformFiles.has(file)) continue;
    const source = path.join(workers, file), target = path.join(docker, file);
    let matches = false;
    try { matches = normalize(source) === normalize(target); } catch { /* missing target */ }
    if (matches) continue;
    differences.push(file);
    if (write) {
        mkdirSync(path.dirname(target), { recursive: true });
        copyFileSync(source, target);
    }
}
for (const file of files(path.join(docker, 'src')).map((file) => `src/${file}`)) {
    if (platformFiles.has(file)) continue;
    try { readFileSync(path.join(workers, file)); } catch {
        console.error(`Docker-only business module requires review: ${file}`);
        process.exitCode = 1;
    }
}
if (differences.length) {
    console.log(`${write ? 'Synced' : 'Different'} ${differences.length} business/test files:\n${differences.join('\n')}`);
    if (!write) process.exitCode = 1;
} else console.log('Workers and Docker business code and tests match (database drivers excluded).');

if (!write) {
    const w = JSON.parse(readFileSync(path.join(workers, 'package.json'), 'utf8'));
    const d = JSON.parse(readFileSync(path.join(docker, 'package.json'), 'utf8'));
    const wl = JSON.parse(readFileSync(path.join(workers, 'package-lock.json'), 'utf8'));
    const dl = JSON.parse(readFileSync(path.join(docker, 'package-lock.json'), 'utf8'));
    const mismatch = (name) => { console.error(`Version mismatch: ${name}`); process.exitCode = 1; };
    if (w.version !== d.version) mismatch('package version');
    if (w.version !== wl.version || w.version !== wl.packages['']?.version) mismatch('Workers lockfile root');
    if (d.version !== dl.version || d.version !== dl.packages['']?.version) mismatch('Docker lockfile root');
    for (const group of ['dependencies', 'devDependencies']) {
        for (const [name, version] of Object.entries(w[group] || {})) {
            if (!d[group]?.[name]) continue;
            if (d[group][name] !== version || wl.packages[`node_modules/${name}`]?.version !== dl.packages[`node_modules/${name}`]?.version) mismatch(name);
        }
    }
}
