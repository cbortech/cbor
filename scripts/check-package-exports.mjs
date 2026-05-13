import { existsSync, readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { strict as assert } from 'node:assert';

const require = createRequire(import.meta.url);

assert.equal(existsSync('dist/ast/index.d.ts'), true);
assert.equal(existsSync('dist/ast/CborItem.d.ts'), true);
assert.equal(existsSync('dist/ast/CborByteString.d.ts'), true);

const astTypes = readFileSync('dist/ast/index.d.ts', 'utf8');
assert.equal(astTypes.includes('AnnotatedLine'), false);

const root = await import('@cbortech/cbor');
assert.equal(typeof root.CBOR, 'function');
assert.equal('CborItem' in root, false);

const ast = await import('@cbortech/cbor/ast');
assert.equal(typeof ast.CborItem, 'function');
assert.equal(typeof ast.CborTextString, 'function');
assert.equal(typeof ast.CborEllipsis, 'undefined');
assert.equal(typeof ast.CborUnresolvedAppExt, 'undefined');
assert.equal(typeof ast.bigintToBytes, 'undefined');
assert.equal(typeof ast.bytesToBigint, 'undefined');

const astCjs = require('@cbortech/cbor/ast');
assert.equal(typeof astCjs.CborItem, 'function');
assert.equal(typeof astCjs.CborTextString, 'function');

console.log('package exports ok');
