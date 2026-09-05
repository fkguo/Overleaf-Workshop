// Run against an extracted VSIX, not the source checkout, so development
// dependencies cannot hide missing files in the distributed extension.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { createRequire } = require('node:module');

exports.run = async function () {
    const vscode = require('vscode');
    const extension = vscode.extensions.getExtension('iamhyc.overleaf-workshop');
    assert.ok(extension, 'Packaged extension was not discovered');
    const expectedRoot = fs.realpathSync(process.env.OVERLEAF_TEST_EXTENSION_PATH);
    assert.equal(fs.realpathSync(extension.extensionPath), expectedRoot);

    // This is unbundled TypeScript output: every production dependency must
    // resolve inside the package, not from a parent checkout or another IDE.
    const packagedRequire = createRequire(path.join(expectedRoot, 'package.json'));
    for (const name of Object.keys(extension.packageJSON.dependencies)) {
        const resolved = fs.realpathSync(packagedRequire.resolve(name));
        assert.ok(resolved.startsWith(expectedRoot + path.sep),
            `${name} resolved outside the packaged extension: ${resolved}`);
    }

    let timer;
    try {
        await Promise.race([
            extension.activate(),
            new Promise((_, reject) => {
                timer = setTimeout(() => reject(new Error('Activation timed out')), 20000);
            }),
        ]);
    } finally {
        clearTimeout(timer);
    }
    assert.equal(extension.isActive, true);
    const commands = await vscode.commands.getCommands(true);
    assert.ok(commands.includes('overleaf-workshop.projectManager.addServer'));
    assert.ok(commands.includes('remoteFileSystem.prefetch'));
    assert.equal(vscode.workspace.fs.isWritableFileSystem('overleaf-workshop'), true,
        'Overleaf file system provider was not registered');
    console.log(`PACKAGED_ACTIVATION_OK ${vscode.env.appName} ${extension.packageJSON.version}`);
};

if (require.main === module) {
    const [extensionPath, executablePath] = process.argv.slice(2);
    if (!extensionPath || !executablePath) {
        console.error('Usage: npm run test:packaged -- <extracted-extension-dir> <IDE-executable>');
        process.exit(1);
    }
    // Never reuse the user's profile, credentials, projects or other extensions.
    const profile = fs.mkdtempSync(path.join(os.tmpdir(), 'overleaf-activation-'));
    const workspace = path.join(profile, 'workspace');
    fs.mkdirSync(workspace);
    console.log(`Isolated test profile: ${profile}`);
    require('@vscode/test-electron').runTests({
        vscodeExecutablePath: path.resolve(executablePath),
        extensionDevelopmentPath: path.resolve(extensionPath),
        extensionTestsPath: __filename,
        extensionTestsEnv: { OVERLEAF_TEST_EXTENSION_PATH: path.resolve(extensionPath) },
        launchArgs: [
            workspace,
            '--user-data-dir', path.join(profile, 'user'),
            '--extensions-dir', path.join(profile, 'extensions'),
        ],
    }).catch(error => {
        console.error(error);
        process.exitCode = 1;
    });
}
