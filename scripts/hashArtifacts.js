'use strict';

const crypto = require('crypto');
const fs = require('fs');
const path = require('path');

function sha256(filePath) {
    const hash = crypto.createHash('sha256');
    hash.update(fs.readFileSync(filePath));
    return hash.digest('hex');
}

function main() {
    const directory = path.resolve(process.argv[2] || 'release');
    const files = fs.readdirSync(directory)
        .filter((name) => /\.(exe|msi|dmg|AppImage|zip)$/i.test(name))
        .sort();
    if (!files.length) throw new Error(`no release artifacts found in ${directory}`);
    const output = files.map((name) => `${sha256(path.join(directory, name))}  ${name}`).join('\n') + '\n';
    fs.writeFileSync(path.join(directory, 'SHA256SUMS.txt'), output);
    process.stdout.write(output);
}

main();
