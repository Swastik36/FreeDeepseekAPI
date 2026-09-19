const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const { execFileSync } = require('node:child_process');

const UPDATE_SH = path.join(__dirname, '..', 'scripts', 'update.sh');

// Fixture: a bare "remote" plus a clone of it. The clone gets the real
// update.sh copied into scripts/ (the shipped layout), so these tests
// exercise the shipped script AND its $0-based repo discovery.
function makeFixture() {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'freedseek-update-'));
    const remote = path.join(dir, 'remote.git');
    const clone = path.join(dir, 'work');
    execFileSync('git', ['init', '--bare', '-b', 'main', '-q', remote]);
    execFileSync('git', ['clone', '-q', remote, clone]);
    const git = (...a) => execFileSync('git', ['-C', clone, ...a]);
    git('config', 'user.email', 't@t');
    git('config', 'user.name', 't');
    fs.mkdirSync(path.join(clone, 'scripts'), { recursive: true });
    fs.copyFileSync(UPDATE_SH, path.join(clone, 'scripts', 'update.sh'));
    fs.writeFileSync(path.join(clone, 'package.json'), JSON.stringify({ name: 'fx', version: '0.0.0', scripts: { test: 'exit 0' } }));
    git('add', '-A');
    git('commit', '-qm', 'seed');
    git('push', '-q', 'origin', 'main:main');
    return { dir, remote, clone, git };
}

function envFor(dir, extra = {}) {
    const base = {};
    for (const [k, v] of Object.entries(process.env)) {
        if (!k.startsWith('FREEDSEEK_')) base[k] = v;
    }
    return {
        ...base,
        XDG_RUNTIME_DIR: path.join(dir, 'runtime'),
        XDG_STATE_HOME: path.join(dir, 'state'),
        FREEDSEEK_NO_RESTART: '1',
        ...extra,
    };
}

function runUpdate(clone, dir, extra = {}) {
    return execFileSync('sh', [path.join(clone, 'scripts', 'update.sh')], {
        cwd: clone,
        env: envFor(dir, extra),
    }).toString();
}

function pushAhead(dir, files, testCmd) {
    const ahead = path.join(dir, 'ahead');
    execFileSync('git', ['clone', '-q', path.join(dir, 'remote.git'), ahead]);
    const agit = (...a) => execFileSync('git', ['-C', ahead, ...a]);
    agit('config', 'user.email', 't@t');
    agit('config', 'user.name', 't');
    for (const [name, content] of Object.entries(files)) {
        fs.writeFileSync(path.join(ahead, name), content);
    }
    if (testCmd) {
        fs.writeFileSync(path.join(ahead, 'package.json'), JSON.stringify({ name: 'fx', version: '0.0.0', scripts: { test: testCmd } }));
    }
    agit('add', '-A');
    agit('commit', '-qm', 'ahead');
    agit('push', '-q', 'origin', 'main:main');
}

function cleanup(dir) { fs.rmSync(dir, { recursive: true, force: true }); }

test('updater: clean tree fast-forwards to upstream via $0 discovery', () => {
    const { dir, clone } = makeFixture();
    try {
        pushAhead(dir, { 'v2.txt': 'v2' }, 'exit 0');
        const out = runUpdate(clone, dir);
        assert.match(out, /Code: [0-9a-f]{7} -> [0-9a-f]{7}/);
        assert.match(out, /Tests green/);
        assert.equal(fs.existsSync(path.join(clone, 'v2.txt')), true);
    } finally {
        cleanup(dir);
    }
});

test('updater: in-sync tree reports up to date without moving HEAD', () => {
    const { dir, clone, git } = makeFixture();
    try {
        const before = git('rev-parse', 'HEAD').toString().trim();
        const out = runUpdate(clone, dir);
        assert.match(out, /Already up to date/);
        assert.equal(git('rev-parse', 'HEAD').toString().trim(), before);
    } finally {
        cleanup(dir);
    }
});

test('updater: dirty tree refuses without touching the branch', () => {
    const { dir, clone, git } = makeFixture();
    try {
        const before = git('rev-parse', 'HEAD').toString().trim();
        fs.writeFileSync(path.join(clone, 'local-dirt.txt'), 'dirt');
        assert.throws(() => runUpdate(clone, dir), /dirty/);
        assert.equal(git('rev-parse', 'HEAD').toString().trim(), before);
    } finally {
        cleanup(dir);
    }
});

test('updater: failing tests print the tail, roll back, and write a marker', () => {
    const { dir, clone, git } = makeFixture();
    try {
        const oldSha = git('rev-parse', 'HEAD').toString().trim();
        pushAhead(dir, { 'v2.txt': 'v2' }, 'echo UPDATE_FAIL_MARKER; exit 1');
        let caught = null;
        try {
            runUpdate(clone, dir);
            assert.fail('expected rollback');
        } catch (e) {
            caught = e;
        }
        assert.match(String(caught.message), /rolled back/);
        assert.match(String(caught.stderr), /UPDATE_FAIL_MARKER/);
        assert.equal(git('rev-parse', 'HEAD').toString().trim(), oldSha);
        assert.equal(fs.existsSync(path.join(dir, 'state', 'freedeepseek', 'update-last-failed')), true);
    } finally {
        cleanup(dir);
    }
});

test('updater: diverged branch refuses and leaves HEAD alone', () => {
    const { dir, clone, git } = makeFixture();
    try {
        fs.writeFileSync(path.join(clone, 'local.txt'), 'local');
        git('add', '-A');
        git('commit', '-qm', 'local-ahead');
        const localHead = git('rev-parse', 'HEAD').toString().trim();
        pushAhead(dir, { 'remote.txt': 'remote' }, 'exit 0');
        assert.throws(() => runUpdate(clone, dir), /diverged/);
        assert.equal(git('rev-parse', 'HEAD').toString().trim(), localHead);
    } finally {
        cleanup(dir);
    }
});

test('updater: FREEDSEEK_UPSTREAM honors a renamed remote', () => {
    const { dir, clone, git } = makeFixture();
    try {
        git('remote', 'rename', 'origin', 'upstream');
        pushAhead(dir, { 'v2.txt': 'v2' }, 'exit 0');
        const out = runUpdate(clone, dir, { FREEDSEEK_UPSTREAM: 'upstream/main' });
        assert.match(out, /Code: [0-9a-f]{7} -> [0-9a-f]{7}/);
        assert.equal(fs.existsSync(path.join(clone, 'v2.txt')), true);
    } finally {
        cleanup(dir);
    }
});

test('updater: detached HEAD refuses and names the remedy', () => {
    const { dir, clone, git } = makeFixture();
    try {
        const head = git('rev-parse', 'HEAD').toString().trim();
        git('checkout', '-q', head);
        const out = (() => {
            try {
                runUpdate(clone, dir);
                assert.fail('expected refusal');
            } catch (e) {
                return String(e.message) + String(e.stderr);
            }
        })();
        assert.match(out, /pinned|detached/);
    } finally {
        cleanup(dir);
    }
});
