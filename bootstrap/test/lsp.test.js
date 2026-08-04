import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import {pathToFileURL, fileURLToPath} from 'node:url';

process.env.VALEN_LSP_NO_START = '1';
const {LanguageServer, MessageReader, encodeMessage} = await import('../../scripts/valen-lsp.mjs');

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const positionOf = (source, text, occurrence = 0) => {
    let offset = -1;
    for (let index = 0; index <= occurrence; index++) offset = source.indexOf(text, offset + 1);
    const before = source.slice(0, offset);
    const lines = before.split('\n');
    return {line: lines.length - 1, character: lines.at(-1).length};
};

test('language server publishes structured diagnostics and semantic navigation', () => {
    const sent = [];
    const server = new LanguageServer(message => sent.push(message));
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'valen-lsp-'));
    const filePath = path.join(directory, 'service.ar');
    const uri = pathToFileURL(filePath).href;
    const invalid = `Engine {{}}\nSink {{ retain(own value:Engine) -> void {} }}\nentry {{ __() -> void { local engine = new Engine(); local sink = new Sink(); sink.retain(engine); sink.retain(engine) } }}\n`;
    server.handle({jsonrpc: '2.0', id: 1, method: 'initialize', params: {rootUri: pathToFileURL(directory).href}});
    assert.equal(sent.at(-1).result.capabilities.hoverProvider, true);
    assert.equal(sent.at(-1).result.capabilities.documentFormattingProvider, true);
    server.handle({jsonrpc: '2.0', method: 'textDocument/didOpen', params: {textDocument: {uri, text: invalid}}});
    const published = sent.at(-1).params.diagnostics;
    assert.equal(published.length, 1);
    assert.match(published[0].message, /borrowed reference 'engine'/);
    assert.match(published[0].relatedInformation[0].message, /takes ownership/);
    assert.equal(published[0].data.fixes[0].replacement, 'copy engine');

    server.handle({jsonrpc: '2.0', id: 2, method: 'textDocument/codeAction', params: {textDocument: {uri}, range: published[0].range, context: {diagnostics: published}}});
    assert.equal(sent.at(-1).result[0].edit.changes[uri][0].newText, 'copy engine');

    const valid = `Engine {{ inspect() -> void {} }}\nentry {{ __() -> void { local engine = new Engine(); engine.inspect() } }}\n`;
    server.handle({jsonrpc: '2.0', method: 'textDocument/didChange', params: {textDocument: {uri}, contentChanges: [{text: valid}]}});
    assert.deepEqual(sent.at(-1).params.diagnostics, []);
    server.handle({jsonrpc: '2.0', id: 3, method: 'textDocument/hover', params: {textDocument: {uri}, position: positionOf(valid, 'engine.inspect')}});
    assert.match(sent.at(-1).result.contents.value, /local engine: .*Engine/);
    server.handle({jsonrpc: '2.0', id: 4, method: 'textDocument/definition', params: {textDocument: {uri}, position: positionOf(valid, 'engine.inspect')}});
    assert.equal(sent.at(-1).result.uri, uri);
    server.handle({jsonrpc: '2.0', id: 5, method: 'textDocument/documentSymbol', params: {textDocument: {uri}}});
    assert.deepEqual(sent.at(-1).result.map(symbol => symbol.name), ['Engine', 'entry']);
    fs.rmSync(directory, {recursive: true});
});

test('language server formats documents without changing condition style', () => {
    const sent = [], directory = fs.mkdtempSync(path.join(os.tmpdir(), 'valen-lsp-format-'));
    const filePath = path.join(directory, 'format.ar'), uri = pathToFileURL(filePath).href;
    const source = 'entry{{\n__()->i32{\nif(value==1){return 0}\nif value==2 {return 1}\n}\n}}';
    const server = new LanguageServer(message => sent.push(message));
    server.handle({jsonrpc: '2.0', method: 'textDocument/didOpen', params: {textDocument: {uri, text: source}}});
    server.handle({jsonrpc: '2.0', id: 9, method: 'textDocument/formatting', params: {textDocument: {uri}, options: {tabSize: 4, insertSpaces: true}}});
    assert.match(sent.at(-1).result[0].newText, /if \(value == 1\)/);
    assert.match(sent.at(-1).result[0].newText, /if value == 2/);
    fs.rmSync(directory, {recursive: true});
});

test('language server speaks Content-Length framed JSON-RPC over stdio', () => {
    const first = {jsonrpc: '2.0', id: 7, method: 'initialize', params: {rootUri: pathToFileURL(root).href}};
    const second = {jsonrpc: '2.0', id: 8, method: 'shutdown'};
    const framed = Buffer.concat([encodeMessage(first), encodeMessage(second)]);
    const reader = new MessageReader();
    assert.deepEqual(reader.feed(framed.subarray(0, 17)), []);
    assert.deepEqual(reader.feed(framed.subarray(17)), [first, second]);
});

test('language server resolves imports from unsaved document overlays', () => {
    const sent = [];
    const server = new LanguageServer(message => sent.push(message));
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'valen-lsp-overlay-'));
    const libraryPath = path.join(directory, 'math.ar'), mainPath = path.join(directory, 'main.ar');
    const libraryUri = pathToFileURL(libraryPath).href, mainUri = pathToFileURL(mainPath).href;
    const library = `library Math {{ value() -> i64 { return 42 } }}\n`;
    const main = `import Math from './math.ar'\nentry {{ __() -> i32 { local answer = Math.value(); return 0 } }}\n`;
    server.handle({jsonrpc: '2.0', id: 1, method: 'initialize', params: {rootUri: pathToFileURL(directory).href}});
    server.handle({jsonrpc: '2.0', method: 'textDocument/didOpen', params: {textDocument: {uri: libraryUri, text: library}}});
    server.handle({jsonrpc: '2.0', method: 'textDocument/didOpen', params: {textDocument: {uri: mainUri, text: main}}});
    assert.deepEqual(sent.at(-1).params.diagnostics, []);
    server.handle({jsonrpc: '2.0', id: 2, method: 'textDocument/definition', params: {textDocument: {uri: mainUri}, position: positionOf(main, 'value')}});
    assert.equal(sent.at(-1).result.uri, libraryUri);
    fs.rmSync(directory, {recursive: true});
});
