import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import {fileURLToPath} from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');

test('example catalog has stable unique entries and valid local references', () => {
    const catalog = JSON.parse(fs.readFileSync(path.join(root, 'examples/catalog.json'), 'utf8'));
    assert.equal(catalog.version, 1);
    assert.ok(Array.isArray(catalog.examples));
    const slugs = new Set(), orders = new Set();
    for (const example of catalog.examples) {
        assert.match(example.slug, /^[a-z0-9]+(?:-[a-z0-9]+)*$/);
        assert.equal(slugs.has(example.slug), false, `duplicate example slug: ${example.slug}`);
        assert.equal(orders.has(example.order), false, `duplicate example order: ${example.order}`);
        slugs.add(example.slug); orders.add(example.order);
        assert.ok(example.title.length > 0);
        assert.ok(['language', 'cli', 'service', 'compute', 'runtime'].includes(example.kind));
        assert.ok(Array.isArray(example.capabilities) && example.capabilities.length > 0);
        for (const field of ['source', 'documentation']) {
            assert.equal(path.isAbsolute(example[field]), false, `${example.slug} ${field} must be relative`);
            assert.equal(fs.existsSync(path.join(root, example[field])), true, `${example.slug} ${field} does not exist`);
        }
    }
});
