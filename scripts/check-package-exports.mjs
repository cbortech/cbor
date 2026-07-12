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
assert.equal(typeof root.CdnSyntaxError, 'function');
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

assert.equal(existsSync('dist/cdn/index.d.ts'), true);

const cdn = await import('@cbortech/cbor/cdn');
assert.equal(typeof cdn.tokenize, 'function');
assert.equal(typeof cdn.tokenizeLenient, 'function');
assert.equal(typeof cdn.CdnSyntaxError, 'function');
assert.equal('Tokenizer' in cdn, false);

const cdnCjs = require('@cbortech/cbor/cdn');
assert.equal(typeof cdnCjs.tokenizeLenient, 'function');

assert.equal(existsSync('dist/cddl/index.d.ts'), true);

const cddl = await import('@cbortech/cbor/cddl');
assert.equal(typeof cddl.CDDL, 'function');
assert.equal(typeof cddl.CDDL.compile, 'function');
assert.equal(typeof cddl.CDDL.compile('t = uint').validate, 'function');
assert.equal(cddl.CDDL.compile('t = uint').validate('7').valid, true);
assert.equal(typeof cddl.tokenize, 'function');
assert.equal(typeof cddl.tokenizeLenient, 'function');
assert.equal(typeof cddl.CddlSyntaxError, 'function');
assert.equal(typeof cddl.CddlSemanticError, 'function');
assert.equal('CddlTokenizer' in cddl, false);

const cddlCjs = require('@cbortech/cbor/cddl');
assert.equal(typeof cddlCjs.CDDL.compile, 'function');

console.log('package exports ok');
