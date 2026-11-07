'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { rendererResultStatus } = require('../scripts/rendererSecuritySmoke');

test('renderer smoke only accepts an explicit result status', () => {
    assert.equal(rendererResultStatus('<pre id="result" data-status="pass">ok</pre>'), 'pass');
    assert.equal(rendererResultStatus('<pre class="x" id="result" data-status="fail">bad</pre>'), 'fail');
    assert.equal(rendererResultStatus('<pre id="other" data-status="pass">wrong node</pre>'), null);
    assert.equal(rendererResultStatus('<pre id="result">missing status</pre>'), null);
});
