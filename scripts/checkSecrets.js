'use strict';

const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..');
const EXCLUDED_DIRS = new Set(['.git', 'node_modules', 'release', 'dist', 'out']);
const EXCLUDED_FILES = new Set(['main.jsc']);
const PATTERNS = [
    ['private key', /-----BEGIN (?:RSA |EC |OPENSSH )?PRIVATE KEY-----/],
    ['OpenAI-style key', /\bsk-[A-Za-z0-9_-]{20,}\b/],
    ['GitHub token', /\b(?:github_pat_[A-Za-z0-9_]{20,}|gh[pousr]_[A-Za-z0-9]{20,})\b/],
    ['AWS access key', /\bAKIA[0-9A-Z]{16}\b/],
    ['Google API key', /\bAIza[0-9A-Za-z_-]{30,}\b/]
];

function walk(directory, output = []) {
    for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
        if (entry.isDirectory() && EXCLUDED_DIRS.has(entry.name)) continue;
        if (entry.isFile() && EXCLUDED_FILES.has(entry.name)) continue;
        const filePath = path.join(directory, entry.name);
        if (entry.isDirectory()) walk(filePath, output);
        else if (entry.isFile()) output.push(filePath);
    }
    return output;
}

const findings = [];
for (const filePath of walk(ROOT)) {
    let text;
    try {
        const buffer = fs.readFileSync(filePath);
        if (buffer.includes(0)) continue;
        text = buffer.toString('utf8');
    } catch {
        continue;
    }
    for (const [label, pattern] of PATTERNS) {
        const match = pattern.exec(text);
        if (!match) continue;
        const line = text.slice(0, match.index).split('\n').length;
        findings.push(`${path.relative(ROOT, filePath)}:${line}: ${label}`);
    }
}

if (findings.length) {
    console.error(`secret scan failed:\n${findings.join('\n')}`);
    process.exit(1);
}
console.log('secret scan ok');
