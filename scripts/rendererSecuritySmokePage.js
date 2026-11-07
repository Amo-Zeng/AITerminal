'use strict';

window.addEventListener('DOMContentLoaded', () => {
    const result = document.getElementById('result');
    try {
        const security = window.AITerminalRendererSecurity;
        const payloads = [
            '<img src=x onerror="window.__rendererSecurityPwned=1">',
            '<a href="javascript:window.__rendererSecurityPwned=2">unsafe link</a>',
            '<button data-action="execute-ai-suggested-command">fake execute</button>',
            '<form><input name="electronAPI"></form><div id="electronAPI">clobber</div>',
            '<svg><g/onload=window.__rendererSecurityPwned=3//<p>',
            '<math><mtext><table><mglyph><style><!--</style><img title="--><img src=x onerror=window.__rendererSecurityPwned=4>">'
        ];
        window.__rendererSecurityPwned = 0;

        for (const payload of payloads) {
            const host = document.createElement('div');
            host.innerHTML = security.sanitizeRenderedHtml(payload, window.DOMPurify);
            document.body.appendChild(host);
            const forbidden = host.querySelector('script,style,iframe,object,embed,form,input,textarea,select,button,[data-action],[id],[name]');
            if (forbidden) throw new Error(`forbidden node survived: ${forbidden.outerHTML}`);
            for (const element of host.querySelectorAll('*')) {
                for (const attribute of element.attributes) {
                    if (/^on/i.test(attribute.name)) throw new Error(`event attribute survived: ${attribute.name}`);
                }
            }
            for (const anchor of host.querySelectorAll('a')) {
                if (/^\s*javascript:/i.test(anchor.getAttribute('href') || '')) throw new Error('javascript URL survived');
            }
        }

        const filename = '<img src=x onerror="window.__rendererSecurityPwned=5">.txt';
        const filenameHost = document.createElement('div');
        filenameHost.innerHTML = security.escapeHtml(filename);
        if (filenameHost.textContent !== filename || filenameHost.children.length !== 0) {
            throw new Error('malicious filename was not rendered as inert text');
        }

        const internalHost = document.createElement('div');
        internalHost.innerHTML = security.sanitizeInteractiveHtml('<button data-action="mcp-expand">expand</button>', window.DOMPurify);
        if (internalHost.querySelector('button')?.dataset.action !== 'mcp-expand') {
            throw new Error('trusted delegated renderer control was removed');
        }
        if (window.__rendererSecurityPwned !== 0) throw new Error('an injected event executed');

        result.dataset.status = 'pass';
        result.textContent = 'renderer security smoke ok';
    } catch (error) {
        result.dataset.status = 'fail';
        result.textContent = error?.stack || error?.message || String(error);
    }
});
