'use strict';

(function exposeRendererSecurity(root, factory) {
    const api = Object.freeze(factory(root));
    if (typeof module === 'object' && module.exports) module.exports = api;
    if (root) {
        Object.defineProperty(root, 'AITerminalRendererSecurity', {
            value: api,
            configurable: false,
            enumerable: false,
            writable: false
        });
    }
})(typeof globalThis === 'object' ? globalThis : null, (root) => {
    const BASE_OPTIONS = {
        USE_PROFILES: { html: true, mathMl: true, svg: true },
        FORBID_TAGS: ['script', 'style', 'iframe', 'object', 'embed', 'form', 'input', 'textarea', 'select'],
        FORBID_ATTR: ['style', 'srcdoc', 'formaction'],
        ALLOW_UNKNOWN_PROTOCOLS: false,
        SANITIZE_DOM: true
    };

    const UNTRUSTED_CONTENT_OPTIONS = {
        ...BASE_OPTIONS,
        FORBID_TAGS: [...BASE_OPTIONS.FORBID_TAGS, 'button'],
        FORBID_ATTR: [...BASE_OPTIONS.FORBID_ATTR, 'id', 'name'],
        ALLOW_DATA_ATTR: false,
        SANITIZE_NAMED_PROPS: true
    };

    function escapeHtml(value) {
        return String(value == null ? '' : value).replace(/[&<>"']/g, (character) => ({
            '&': '&amp;',
            '<': '&lt;',
            '>': '&gt;',
            '"': '&quot;',
            "'": '&#39;'
        })[character]);
    }

    function sanitize(html, purifier, options) {
        const value = String(html == null ? '' : html);
        if (!purifier || typeof purifier.sanitize !== 'function') return escapeHtml(value);
        return purifier.sanitize(value, options);
    }

    function sanitizeRenderedHtml(html, purifier = root?.DOMPurify) {
        return sanitize(html, purifier, UNTRUSTED_CONTENT_OPTIONS);
    }

    function sanitizeInteractiveHtml(html, purifier = root?.DOMPurify) {
        return sanitize(html, purifier, BASE_OPTIONS);
    }

    return {
        escapeHtml,
        sanitizeInteractiveHtml,
        sanitizeRenderedHtml
    };
});
