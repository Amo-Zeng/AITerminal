'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const {
    escapeHtml,
    sanitizeInteractiveHtml,
    sanitizeRenderedHtml
} = require('../rendererSecurity');

test('renderer HTML escaping covers element text and quoted attributes', () => {
    assert.equal(
        escapeHtml(`<img src=x onerror="pwn()" data-x='y'>&`),
        '&lt;img src=x onerror=&quot;pwn()&quot; data-x=&#39;y&#39;&gt;&amp;'
    );
});

test('untrusted AI HTML cannot create renderer controls or named properties', () => {
    let received = null;
    const purifier = {
        sanitize(value, options) {
            received = { value, options };
            return '<p>safe</p>';
        }
    };

    assert.equal(sanitizeRenderedHtml('<button data-action="run">run</button>', purifier), '<p>safe</p>');
    assert.equal(received.value, '<button data-action="run">run</button>');
    assert.equal(received.options.ALLOW_DATA_ATTR, false);
    assert.equal(received.options.SANITIZE_DOM, true);
    assert.equal(received.options.SANITIZE_NAMED_PROPS, true);
    assert.ok(received.options.FORBID_TAGS.includes('button'));
    assert.ok(received.options.FORBID_ATTR.includes('id'));
    assert.ok(received.options.FORBID_ATTR.includes('name'));
    assert.ok(received.options.FORBID_ATTR.includes('formaction'));
});

test('trusted internal templates retain delegated controls but still use DOMPurify', () => {
    let received = null;
    const purifier = {
        sanitize(value, options) {
            received = { value, options };
            return value;
        }
    };

    const template = '<button data-action="mcp-expand">expand</button>';
    assert.equal(sanitizeInteractiveHtml(template, purifier), template);
    assert.equal(received.options.ALLOW_UNKNOWN_PROTOCOLS, false);
    assert.ok(!received.options.FORBID_TAGS.includes('button'));
    assert.ok(received.options.FORBID_ATTR.includes('srcdoc'));
});

test('missing DOMPurify fails closed by escaping the complete fragment', () => {
    assert.equal(
        sanitizeRenderedHtml('<img src=x onerror=pwn()>', null),
        '&lt;img src=x onerror=pwn()&gt;'
    );
});
