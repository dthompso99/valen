'use strict';

const path = require('node:path');
const vscode = require('vscode');
const {LanguageClient, TransportKind} = require('vscode-languageclient/node');

let client;

function activate(context) {
    const configuration = vscode.workspace.getConfiguration('valen');
    const configuredServer = configuration.get('server.path', '').trim();
    const serverPath = configuredServer || context.asAbsolutePath(path.join('..', '..', 'scripts', 'valen-lsp.mjs'));
    const nodePath = configuration.get('server.nodePath', 'node').trim() || 'node';
    const libraryPath = configuration.get('libraryPath', '').trim();
    const options = {
        command: nodePath,
        args: [serverPath],
        transport: TransportKind.stdio,
        options: {env: {...process.env, ...(libraryPath ? {VALEN_LIBRARY_PATH: libraryPath} : {})}}
    };
    client = new LanguageClient('valen', 'Valen Language Server', options, {
        documentSelector: [{scheme: 'file', language: 'valen'}],
        synchronize: {fileEvents: vscode.workspace.createFileSystemWatcher('**/*.ar')}
    });
    context.subscriptions.push(client.start());
}

async function deactivate() {
    if (client) await client.stop();
}

module.exports = {activate, deactivate};
