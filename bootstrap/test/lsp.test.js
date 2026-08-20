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

test('language server finds references across modules and unsaved overlays', () => {
    const sent = [];
    const server = new LanguageServer(message => sent.push(message));
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'valen-lsp-references-'));
    const libraryPath = path.join(directory, 'math.ar'), mainPath = path.join(directory, 'main.ar'), reportPath = path.join(directory, 'report.ar');
    const libraryUri = pathToFileURL(libraryPath).href, mainUri = pathToFileURL(mainPath).href, reportUri = pathToFileURL(reportPath).href;
    const library = `library Math {{ value() -> i64 { return 42 } sum() -> i64 { return 0 } }}\n`;
    const main = `import Math from './math.ar'\nentry {{ __() -> i32 { local answer = Math.value(); return 0 } }}\n`;
    const report = `import Math from './math.ar'\nentry {{ __() -> i32 { local total = Math.value(); return 0 } }}\n`;
    server.handle({jsonrpc: '2.0', id: 1, method: 'initialize', params: {rootUri: pathToFileURL(directory).href}});
    assert.equal(sent.at(-1).result.capabilities.referencesProvider, true);
    assert.deepEqual(sent.at(-1).result.capabilities.completionProvider.triggerCharacters, ['.']);
    assert.equal(sent.at(-1).result.capabilities.semanticTokensProvider.full, true);
    server.handle({jsonrpc: '2.0', method: 'textDocument/didOpen', params: {textDocument: {uri: libraryUri, text: library}}});
    server.handle({jsonrpc: '2.0', method: 'textDocument/didOpen', params: {textDocument: {uri: mainUri, text: main}}});
    server.handle({jsonrpc: '2.0', method: 'textDocument/didOpen', params: {textDocument: {uri: reportUri, text: report}}});
    server.handle({jsonrpc: '2.0', id: 2, method: 'textDocument/references', params: {textDocument: {uri: mainUri}, position: positionOf(main, 'value'), context: {includeDeclaration: true}}});
    assert.deepEqual(sent.at(-1).result.map(location => location.uri), [libraryUri, mainUri, reportUri].sort());
    server.handle({jsonrpc: '2.0', id: 3, method: 'textDocument/references', params: {textDocument: {uri: libraryUri}, position: positionOf(library, 'value'), context: {includeDeclaration: false}}});
    assert.deepEqual(sent.at(-1).result.map(location => location.uri), [mainUri, reportUri].sort());
    server.handle({jsonrpc: '2.0', id: 4, method: 'textDocument/prepareRename', params: {textDocument: {uri: mainUri}, position: positionOf(main, 'value')}});
    assert.equal(sent.at(-1).result.placeholder, 'value');
    assert.equal(main.slice(main.indexOf('value'), main.indexOf('value') + 5), 'value');
    server.handle({jsonrpc: '2.0', id: 5, method: 'textDocument/rename', params: {textDocument: {uri: mainUri}, position: positionOf(main, 'value'), newName: 'compute'}});
    assert.deepEqual(Object.keys(sent.at(-1).result.changes).sort(), [libraryUri, mainUri, reportUri].sort());
    assert.deepEqual(Object.values(sent.at(-1).result.changes).map(edits => edits.length), [1, 1, 1]);
    server.handle({jsonrpc: '2.0', id: 6, method: 'textDocument/rename', params: {textDocument: {uri: mainUri}, position: positionOf(main, 'value'), newName: 'sum'}});
    assert.match(sent.at(-1).error.message, /conflict/);
    server.handle({jsonrpc: '2.0', id: 7, method: 'textDocument/rename', params: {textDocument: {uri: mainUri}, position: positionOf(main, 'value'), newName: 'not-valid'}});
    assert.match(sent.at(-1).error.message, /Invalid Valen identifier/);
    server.handle({jsonrpc: '2.0', id: 8, method: 'textDocument/semanticTokens/full', params: {textDocument: {uri: mainUri}}});
    const legend = sent.find(message => message.id === 1).result.capabilities.semanticTokensProvider.legend;
    const tokenTypes = sent.at(-1).result.data.filter((value, index) => index % 5 === 3).map(index => legend.tokenTypes[index]);
    assert.ok(tokenTypes.includes('namespace'), 'imported library reference was not classified');
    assert.ok(tokenTypes.includes('function'), 'imported library method was not classified');
    assert.ok(tokenTypes.includes('variable'), 'local declaration was not classified');
    server.handle({jsonrpc: '2.0', id: 9, method: 'textDocument/completion', params: {textDocument: {uri: mainUri}, position: positionOf(main, 'Math.value')}});
    assert.ok(sent.at(-1).result.some(item => item.label === 'Math' && item.kind === 9), 'import completion was not offered');
    fs.rmSync(directory, {recursive: true});
});

test('language server completes locals, parameters, types, members, and enum cases contextually', () => {
    const sent = [], directory = fs.mkdtempSync(path.join(os.tmpdir(), 'valen-lsp-completion-'));
    const filePath = path.join(directory, 'completion.ar'), uri = pathToFileURL(filePath).href;
    const source = `enum Mode {{ Ready, Waiting }}\nEngine {{ member status:Mode; inspect(limit:i64) -> void { local current = limit; self.ins } private secret() -> void {} }}\nentry {{ __() -> i32 { local engine = new Engine(); engine.ins; engine.sec; local selected = Mode.Rea; return 0 } }}\n`;
    const server = new LanguageServer(message => sent.push(message));
    server.handle({jsonrpc: '2.0', id: 1, method: 'initialize', params: {rootUri: pathToFileURL(directory).href}});
    server.handle({jsonrpc: '2.0', method: 'textDocument/didOpen', params: {textDocument: {uri, text: source}}});
    const complete = (id, text, occurrence = 0) => {
        const position = positionOf(source, text, occurrence); position.character += text.length;
        server.handle({jsonrpc: '2.0', id, method: 'textDocument/completion', params: {textDocument: {uri}, position}});
        return sent.at(-1).result;
    };
    assert.deepEqual(complete(2, 'engine.ins').map(item => item.label), ['inspect']);
    assert.deepEqual(complete(3, 'Mode.Rea').map(item => item.label), ['Ready']);
    assert.deepEqual(complete(4, 'self.ins').map(item => item.label), ['inspect']);
    assert.deepEqual(complete(6, 'engine.sec'), []);
    server.handle({jsonrpc: '2.0', id: 5, method: 'textDocument/completion', params: {textDocument: {uri}, position: positionOf(source, 'self.ins')}});
    const names = sent.at(-1).result;
    assert.ok(names.some(item => item.label === 'current'));
    assert.ok(names.some(item => item.label === 'limit'));
    assert.ok(names.some(item => item.label === 'Mode'));
    assert.ok(names.some(item => item.label === 'i64'));
    fs.rmSync(directory, {recursive: true});
});

test('language server classifies ownership and native unsafe boundaries', () => {
    const sent = [], directory = fs.mkdtempSync(path.join(os.tmpdir(), 'valen-lsp-semantic-tokens-'));
    const filePath = path.join(directory, 'native.ar'), uri = pathToFileURL(filePath).href;
    const source = `Engine {{}}\nlibrary Native {{ unsafe native take(own input:ref Engine) -> void }}\n`;
    const server = new LanguageServer(message => sent.push(message));
    server.handle({jsonrpc: '2.0', id: 1, method: 'initialize', params: {rootUri: pathToFileURL(directory).href}});
    const legend = sent.at(-1).result.capabilities.semanticTokensProvider.legend;
    server.handle({jsonrpc: '2.0', method: 'textDocument/didOpen', params: {textDocument: {uri, text: source}}});
    server.handle({jsonrpc: '2.0', id: 2, method: 'textDocument/semanticTokens/full', params: {textDocument: {uri}}});
    const records = [];
    for (let index = 0; index < sent.at(-1).result.data.length; index += 5) records.push(sent.at(-1).result.data.slice(index, index + 5));
    const ownershipBit = 1 << legend.tokenModifiers.indexOf('ownership');
    const nativeBit = 1 << legend.tokenModifiers.indexOf('native');
    const unsafeBit = 1 << legend.tokenModifiers.indexOf('unsafe');
    assert.ok(records.some(record => legend.tokenTypes[record[3]] === 'modifier' && (record[4] & ownershipBit) !== 0));
    assert.ok(records.some(record => (record[4] & nativeBit) !== 0));
    assert.ok(records.some(record => (record[4] & unsafeBit) !== 0));
    fs.rmSync(directory, {recursive: true});
});

test('language server refuses rename outside the workspace root', () => {
    const sent = [], directory = fs.mkdtempSync(path.join(os.tmpdir(), 'valen-lsp-rename-root-'));
    const workspace = path.join(directory, 'workspace'), externalPath = path.join(directory, 'external.ar');
    fs.mkdirSync(workspace);
    const externalUri = pathToFileURL(externalPath).href, source = `library External {{ value() -> i64 { return 1 } }}\n`;
    const server = new LanguageServer(message => sent.push(message));
    server.handle({jsonrpc: '2.0', id: 1, method: 'initialize', params: {rootUri: pathToFileURL(workspace).href}});
    server.handle({jsonrpc: '2.0', method: 'textDocument/didOpen', params: {textDocument: {uri: externalUri, text: source}}});
    server.handle({jsonrpc: '2.0', id: 2, method: 'textDocument/prepareRename', params: {textDocument: {uri: externalUri}, position: positionOf(source, 'value')}});
    assert.equal(sent.at(-1).result, null);
    server.handle({jsonrpc: '2.0', id: 3, method: 'textDocument/rename', params: {textDocument: {uri: externalUri}, position: positionOf(source, 'value'), newName: 'compute'}});
    assert.match(sent.at(-1).error.message, /outside the workspace root/);
    fs.rmSync(directory, {recursive: true});
});
