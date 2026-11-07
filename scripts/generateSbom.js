'use strict';

const fs = require('fs');
const path = require('path');
const { spawnSync } = require('child_process');

function normalizeCycloneDxSbom(sbom, packageJson) {
    const component = sbom?.metadata?.component;
    if (sbom?.bomFormat !== 'CycloneDX' || !component) {
        throw new Error('npm returned an invalid CycloneDX SBOM');
    }

    const expectedRef = `${packageJson.name}@${packageJson.version}`;
    if (component['bom-ref'] !== expectedRef || component.version !== packageJson.version) {
        throw new Error(`SBOM root identity does not match ${expectedRef}`);
    }

    // npm uses the checkout directory for component.name; releases must use
    // the stable package identity instead of a private build repository name.
    component.name = packageJson.name;
    component.type = 'application';
    return sbom;
}

function generateSbom(rootDirectory) {
    const npmExecPath = process.env.npm_execpath;
    if (!npmExecPath) {
        throw new Error('run this command through npm run sbom:release');
    }

    const result = spawnSync(process.execPath, [
        npmExecPath,
        'sbom',
        '--sbom-format',
        'cyclonedx',
        '--sbom-type',
        'application'
    ], {
        cwd: rootDirectory,
        encoding: 'utf8',
        maxBuffer: 64 * 1024 * 1024
    });
    if (result.error) throw result.error;
    if (result.status !== 0) {
        throw new Error(result.stderr.trim() || `npm sbom exited with status ${result.status}`);
    }

    let sbom;
    try {
        sbom = JSON.parse(result.stdout);
    } catch {
        throw new Error('npm returned malformed SBOM JSON');
    }
    const packageJson = JSON.parse(fs.readFileSync(path.join(rootDirectory, 'package.json'), 'utf8'));
    return normalizeCycloneDxSbom(sbom, packageJson);
}

function main() {
    const rootDirectory = path.resolve(__dirname, '..');
    const outputPath = path.resolve(process.argv[2] || path.join(rootDirectory, 'release', 'sbom.cdx.json'));
    const sbom = generateSbom(rootDirectory);
    fs.mkdirSync(path.dirname(outputPath), { recursive: true });
    fs.writeFileSync(outputPath, `${JSON.stringify(sbom, null, 2)}\n`);
    console.log(`CycloneDX SBOM written to ${outputPath}`);
}

module.exports = { normalizeCycloneDxSbom };

if (require.main === module) {
    try {
        main();
    } catch (error) {
        console.error(`SBOM generation failed: ${error.message}`);
        process.exit(1);
    }
}
