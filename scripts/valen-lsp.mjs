#!/usr/bin/env node
import path from 'node:path';
import fs from 'node:fs';
import {fileURLToPath, pathToFileURL} from 'node:url';
import {SemanticAnalyzer} from '../bootstrap/semantic.js';
import {formatValen} from './valen-formatter.mjs';

const severity = {error: 1, warning: 2, note: 3};

function uriPath(uri) { return fileURLToPath(uri); }
function fileUri(filePath) { return pathToFileURL(filePath).href; }
function positionAt(source, offset) {
    const before = source.slice(0, Math.max(0, offset));
    const lines = before.split('\n');
    return {line: lines.length - 1, character: lines.at(-1).length};
}
function offsetAt(source, position) {
    let offset = 0;
    const lines = source.split('\n');
    for (let line = 0; line < position.line && line < lines.length; line++) offset += lines[line].length + 1;
    return offset + Math.min(position.character, lines[position.line]?.length ?? 0);
}
function spanRange(span, source) {
    return {start: positionAt(source, span.start), end: positionAt(source, Math.max(span.start + 1, span.end))};
}
function walk(node, visit, seen = new Set()) {
    if (!node || typeof node !== 'object' || seen.has(node)) return;
    seen.add(node);
    if (node.kind && node.span) visit(node);
    for (const [key, value] of Object.entries(node)) {
        if (key === 'span' || key === 'inferredType') continue;
        if (Array.isArray(value)) for (const item of value) walk(item, visit, seen);
        else walk(value, visit, seen);
    }
}
function nodeAt(program, offset) {
    let found = null;
    walk(program, node => {
        if (node.span.start <= offset && offset <= node.span.end && (!found || node.span.end - node.span.start <= found.span.end - found.span.start)) found = node;
    });
    return found;
}
function symbolDescription(symbol, node) {
    if (!symbol) return node.inferredType ? `${node.kind}: ${node.inferredType}` : node.kind;
    const ownership = symbol.owning ? 'own ' : symbol.ownership === 'borrowed' || symbol.ownership === 'ref' ? 'ref ' : '';
    if (symbol.parameters) return `${symbol.kind.toLowerCase()} ${symbol.name}(${symbol.parameters.map(item => `${item.owning ? 'own ' : ''}${item.name}:${item.type}`).join(', ')}) -> ${symbol.returnType}`;
    return `${symbol.kind.toLowerCase()} ${symbol.name}${symbol.type ? `: ${ownership}${symbol.type}` : ''}`;
}

export class LanguageServer {
    constructor(send) {
        this.send = send;
        this.documents = new Map();
        this.results = new Map();
        this.rootPath = process.cwd();
    }

    respond(id, result) { this.send({jsonrpc: '2.0', id, result}); }
    notify(method, params) { this.send({jsonrpc: '2.0', method, params}); }
    sourceFor(filePath, fallback = '') { try { return this.documents.get(filePath) ?? fs.readFileSync(filePath, 'utf8'); } catch { return fallback; } }

    handle(message) {
        const {id, method, params = {}} = message;
        if (method === 'initialize') {
            const root = params.rootUri ? uriPath(params.rootUri) : params.rootPath;
            if (root) this.rootPath = root;
            this.respond(id, {capabilities: {textDocumentSync: 1, hoverProvider: true, definitionProvider: true, documentSymbolProvider: true, codeActionProvider: true, documentFormattingProvider: true}});
        } else if (method === 'shutdown') this.respond(id, null);
        else if (method === 'exit') process.exit(0);
        else if (method === 'textDocument/didOpen') {
            this.documents.set(uriPath(params.textDocument.uri), params.textDocument.text); this.analyze(params.textDocument.uri);
        } else if (method === 'textDocument/didChange') {
            this.documents.set(uriPath(params.textDocument.uri), params.contentChanges.at(-1).text); this.analyze(params.textDocument.uri);
        } else if (method === 'textDocument/didClose') {
            const uri = params.textDocument.uri; this.documents.delete(uriPath(uri)); this.results.delete(uri); this.notify('textDocument/publishDiagnostics', {uri, diagnostics: []});
        } else if (method === 'textDocument/hover') this.respond(id, this.hover(params));
        else if (method === 'textDocument/definition') this.respond(id, this.definition(params));
        else if (method === 'textDocument/documentSymbol') this.respond(id, this.documentSymbols(params));
        else if (method === 'textDocument/codeAction') this.respond(id, this.codeActions(params));
        else if (method === 'textDocument/formatting') this.respond(id, this.formatDocument(params));
        else if (id !== undefined) this.respond(id, null);
    }

    analyze(uri) {
        const filePath = uriPath(uri);
        const source = this.documents.get(filePath) ?? '';
        try {
            const analysis = new SemanticAnalyzer().analyzeFile(filePath, {sourceRoot: this.rootPath, documents: this.documents});
            const module = analysis.modules.get(filePath);
            const diagnostics = analysis.diagnostics.filter(item => item.span.source === filePath).map(item => this.lspDiagnostic(item, source));
            this.results.set(uri, {analysis, program: module?.program, diagnostics, source});
            this.notify('textDocument/publishDiagnostics', {uri, diagnostics});
        } catch (error) {
            const match = String(error.message).match(/^(.*):(\d+):(\d+): (.*)$/s);
            const line = Math.max(0, Number(match?.[2] ?? 1) - 1), character = Math.max(0, Number(match?.[3] ?? 1) - 1);
            const diagnostics = [{range: {start: {line, character}, end: {line, character: character + 1}}, severity: 1, source: 'valen', message: match?.[4] ?? error.message}];
            this.results.set(uri, {analysis: null, program: null, diagnostics, source});
            this.notify('textDocument/publishDiagnostics', {uri, diagnostics});
        }
    }

    lspDiagnostic(item, source) {
        return {
            range: spanRange(item.span, source), severity: severity[item.severity] ?? 1, source: 'valen', message: item.message,
            relatedInformation: (item.labels ?? []).filter(label => !label.primary).map(label => ({location: {uri: fileUri(label.span.source), range: spanRange(label.span, this.sourceFor(label.span.source))}, message: label.message})),
            data: {notes: item.notes ?? [], fixes: item.fixes ?? []}
        };
    }

    context(params) {
        const uri = params.textDocument.uri, result = this.results.get(uri);
        if (!result?.program) return null;
        return {uri, result, node: nodeAt(result.program, offsetAt(result.source, params.position))};
    }

    hover(params) {
        const context = this.context(params);
        if (!context?.node) return null;
        return {contents: {kind: 'markdown', value: `\`\`\`valen\n${symbolDescription(context.node.semanticSymbol, context.node)}\n\`\`\``}, range: spanRange(context.node.span, context.result.source)};
    }

    definition(params) {
        const context = this.context(params), span = context?.node?.semanticSymbol?.declaration?.span;
        if (!span) return null;
        return {uri: fileUri(span.source), range: spanRange(span, this.sourceFor(span.source))};
    }

    documentSymbols(params) {
        const result = this.results.get(params.textDocument.uri);
        if (!result?.program) return [];
        return [...result.program.objects, ...result.program.libraries].map(object => ({
            name: object.name, kind: object.kind === 'LibraryDeclaration' ? 3 : 5, range: spanRange(object.span, result.source), selectionRange: spanRange(object.span, result.source),
            children: object.members.map(member => ({name: member.name, kind: member.kind === 'MethodDeclaration' ? 6 : 8, range: spanRange(member.span, result.source), selectionRange: spanRange(member.span, result.source)}))
        }));
    }

    codeActions(params) {
        const result = this.results.get(params.textDocument.uri);
        if (!result) return [];
        return result.diagnostics.flatMap(item => (item.data?.fixes ?? []).map(fix => ({
            title: fix.message, kind: 'quickfix', edit: {changes: {[fileUri(fix.span.source)]: [{range: spanRange(fix.span, this.sourceFor(fix.span.source, result.source)), newText: fix.replacement}]}}
        })));
    }

    formatDocument(params) {
        const uri = params.textDocument.uri;
        const source = this.documents.get(uriPath(uri)) ?? this.sourceFor(uriPath(uri));
        const formatted = formatValen(source, {indent: params.options?.insertSpaces === false ? '\t' : ' '.repeat(params.options?.tabSize ?? 4)});
        if (formatted === source) return [];
        return [{range: {start: {line: 0, character: 0}, end: positionAt(source, source.length)}, newText: formatted}];
    }
}

export function encodeMessage(message) {
    const body = Buffer.from(JSON.stringify(message));
    return Buffer.concat([Buffer.from(`Content-Length: ${body.length}\r\n\r\n`), body]);
}

export class MessageReader {
    constructor() { this.input = Buffer.alloc(0); }
    feed(chunk) {
        this.input = Buffer.concat([this.input, chunk]);
        const messages = [];
        while (true) {
            const headerEnd = this.input.indexOf('\r\n\r\n');
            if (headerEnd < 0) return messages;
            const match = this.input.subarray(0, headerEnd).toString().match(/Content-Length:\s*(\d+)/i);
            if (!match) { this.input = this.input.subarray(headerEnd + 4); continue; }
            const length = Number(match[1]), bodyStart = headerEnd + 4;
            if (this.input.length < bodyStart + length) return messages;
            messages.push(JSON.parse(this.input.subarray(bodyStart, bodyStart + length)));
            this.input = this.input.subarray(bodyStart + length);
        }
    }
}

function start() {
    const reader = new MessageReader();
    const send = message => process.stdout.write(encodeMessage(message));
    const server = new LanguageServer(send);
    process.stdin.on('data', chunk => { for (const message of reader.feed(chunk)) server.handle(message); });
}

if (process.env.VALEN_LSP_NO_START !== '1') start();
