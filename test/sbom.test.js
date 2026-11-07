'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { normalizeCycloneDxSbom } = require('../scripts/generateSbom');

function fixture() {
    return {
        bomFormat: 'CycloneDX',
        metadata: {
            component: {
                'bom-ref': 'aiterminal@1.3.0',
                type: 'library',
                name: 'AITerminal-build',
                version: '1.3.0',
                purl: 'pkg:npm/aiterminal@1.3.0'
            }
        }
    };
}

test('normalizes SBOM root metadata independently of the checkout directory', () => {
    const sbom = normalizeCycloneDxSbom(fixture(), { name: 'aiterminal', version: '1.3.0' });
    assert.equal(sbom.metadata.component.name, 'aiterminal');
    assert.equal(sbom.metadata.component.type, 'application');
    assert.equal(sbom.metadata.component.purl, 'pkg:npm/aiterminal@1.3.0');
});

test('rejects an SBOM generated for a different package identity', () => {
    assert.throws(
        () => normalizeCycloneDxSbom(fixture(), { name: 'other-package', version: '1.3.0' }),
        /root identity does not match/
    );
});
