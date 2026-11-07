'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { execFileSync } = require('child_process');
const { quotePosix, wrapDirectCommand } = require('../lib/shellCommand');

test('POSIX quoting preserves dollar expansions, substitution and embedded apostrophes', { skip: process.platform === 'win32' }, () => {
    const value = "space ' \" $HOME $(printf should-not-run) `echo no` \\ path";
    const output = execFileSync('/bin/sh', ['-c', `printf '%s' ${quotePosix(value)}`], { encoding: 'utf8' });
    assert.equal(output, value);
});
test('interactive command wrapper captures actual child-shell exit status and preserves script bytes', { skip: process.platform === 'win32' }, () => {
    const command = "value='child value'; printf '%s\\n' \"$value\"; printf '%s\\n' 'literal $(echo wrong)'; (exit 7)";
    const wrapped = wrapDirectCommand(command, '__BEGIN__', '__END__');
    const output = execFileSync('/bin/sh', ['-c', wrapped], { encoding: 'utf8', env: { ...process.env, value: 'outer value' } });
    assert.equal(output, '__BEGIN__\nchild value\nliteral $(echo wrong)\n__END__:7\n');
});
