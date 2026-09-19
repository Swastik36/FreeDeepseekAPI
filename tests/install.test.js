const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const { execFileSync } = require('node:child_process');

const INSTALL_SH = path.join(__dirname, '..', 'scripts', 'install.sh');

function cleanEnv(extra = {}) {
    const base = {};
    for (const [k, v] of Object.entries(process.env)) {
        if (!k.startsWith('FREEDSEEK_')) base[k] = v;
    }
    return { ...base, ...extra };
}

test('installer: --help prints usage and exits 0', () => {
    const out = execFileSync('sh', [INSTALL_SH, '--help'], { env: cleanEnv() }).toString();
    assert.match(out, /usage: install\.sh/);
    assert.match(out, /--ref/);
});

test('installer: unknown flag exits 2 with a message', () => {
    try {
        execFileSync('sh', [INSTALL_SH, '--bogus'], { env: cleanEnv(), stdio: 'pipe' });
        assert.fail('expected non-zero exit');
    } catch (e) {
        assert.equal(e.status, 2);
        assert.match(String(e.stderr), /unknown flag/);
    }
});

test('installer: rejects node < 18 with a clear message', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'freedseek-install-'));
    try {
        const bin = path.join(dir, 'bin');
        fs.mkdirSync(bin);
        const fake = path.join(bin, 'node');
        fs.writeFileSync(fake, '#!/bin/sh\ncase "$1" in -p) echo 17;; -v) echo v17.0.0;; esac\n');
        fs.chmodSync(fake, 0o755);
        try {
            execFileSync('sh', [INSTALL_SH, '--no-service', '--no-auth'], {
                env: cleanEnv({ PATH: bin + ':' + process.env.PATH }),
                stdio: 'pipe',
            });
            assert.fail('expected version gate to fail');
        } catch (e) {
            assert.match(String(e.stderr), /node >= 18 required/);
        }
    } finally {
        fs.rmSync(dir, { recursive: true, force: true });
    }
});

test('installer: existing install hands off to update.sh and preserves exit code', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'freedseek-install-'));
    try {
        const target = path.join(dir, 'install');
        fs.mkdirSync(path.join(target, 'scripts'), { recursive: true });
        execFileSync('git', ['init', '-q', target]);
        execFileSync('git', ['-C', target, 'config', 'user.email', 't@t']);
        execFileSync('git', ['-C', target, 'config', 'user.name', 't']);
        fs.writeFileSync(path.join(target, 'marker.txt'), 'x');
        execFileSync('git', ['-C', target, 'add', '-A']);
        execFileSync('git', ['-C', target, 'commit', '-qm', 'seed']);
        fs.writeFileSync(path.join(target, 'scripts', 'update.sh'), '#!/bin/sh\nexit 7\n');
        try {
            execFileSync('sh', [INSTALL_SH, '--no-service', '--no-auth'], {
                env: cleanEnv({ FREEDSEEK_DIR: target }),
                stdio: 'pipe',
            });
            assert.fail('expected exit 7');
        } catch (e) {
            assert.equal(e.status, 7);
        }
    } finally {
        fs.rmSync(dir, { recursive: true, force: true });
    }
});

test('installer: systemd unit quotes paths and uses an absolute node', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'freedseek-install-'));
    try {
        const remote = path.join(dir, 'remote.git');
        execFileSync('git', ['init', '--bare', '-b', 'main', '-q', remote]);
        const seed = path.join(dir, 'seed');
        execFileSync('git', ['clone', '-q', remote, seed]);
        execFileSync('git', ['-C', seed, 'config', 'user.email', 't@t']);
        execFileSync('git', ['-C', seed, 'config', 'user.name', 't']);
        fs.writeFileSync(path.join(seed, 'server.js'), '// stub\n');
        execFileSync('git', ['-C', seed, 'add', '-A']);
        execFileSync('git', ['-C', seed, 'commit', '-qm', 'seed']);
        execFileSync('git', ['-C', seed, 'push', '-q', 'origin', 'main:main']);

        const target = path.join(dir, 'my install');
        const unitDir = path.join(dir, 'unit');
        const bin = path.join(dir, 'bin');
        fs.mkdirSync(bin);
        const sysctl = path.join(bin, 'systemctl');
        fs.writeFileSync(sysctl, '#!/bin/sh\nexit 0\n');
        fs.chmodSync(sysctl, 0o755);

        execFileSync('sh', [INSTALL_SH, '--no-auth'], {
            env: cleanEnv({
                FREEDSEEK_REPO_URL: remote,
                FREEDSEEK_REF: 'main',
                FREEDSEEK_DIR: target,
                FREEDSEEK_UNIT_DIR: unitDir,
                PATH: bin + ':' + process.env.PATH,
            }),
            stdio: 'pipe',
        });

        const unitPath = path.join(unitDir, 'freedeepseek.service');
        const unit = fs.readFileSync(unitPath, 'utf8');
        const nodeBin = execFileSync('sh', ['-c', 'command -v node']).toString().trim();
        // systemd path directives take the rest of the line literally; a leading
        // double-quote makes the path non-absolute and the unit refuses to load.
        assert.ok(unit.includes('WorkingDirectory=' + target + '\n'), 'WorkingDirectory must be unquoted:\n' + unit);
        assert.ok(!unit.includes('WorkingDirectory="'), 'WorkingDirectory must not be quoted:\n' + unit);
        // ExecStart DOES use command-line quoting, so both argv words stay quoted.
        assert.ok(unit.includes('ExecStart="' + nodeBin + '" "' + target + '/server.js"'), 'ExecStart must be quoted node-direct:\n' + unit);
        assert.ok(!unit.includes('/usr/bin/npm'), 'unit must not hardcode /usr/bin/npm:\n' + unit);
        // Real parser check when systemd-analyze is available: string matching
        // alone is what missed the quoted-path bug in the first place.
        try {
            execFileSync('systemd-analyze', ['--user', 'verify', unitPath], { stdio: 'pipe' });
        } catch (e) {
            if (e.code === 'ENOENT') return;
            assert.fail('systemd-analyze verify rejected the unit:\n' + String(e.stdout) + String(e.stderr));
        }
    } finally {
        fs.rmSync(dir, { recursive: true, force: true });
    }
});
