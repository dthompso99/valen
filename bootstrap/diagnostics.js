export const DiagnosticSeverity = Object.freeze({error: 'error', warning: 'warning', note: 'note'});

export function diagnostic(severity, message, span, {labels = [], notes = [], fixes = []} = {}) {
    return {
        severity,
        message,
        span,
        labels: [{span, message, primary: true}, ...labels.map(label => ({...label, primary: false}))],
        notes: [...notes],
        fixes: [...fixes]
    };
}

export function formatDiagnostic(item) {
    const {source, line, column} = item.span;
    const lines = [`${source}:${line}:${column}: ${item.severity}: ${item.message}`];
    for (const label of item.labels?.filter(label => !label.primary) ?? []) {
        lines.push(`  --> ${label.span.source}:${label.span.line}:${label.span.column}: ${label.message}`);
    }
    for (const note of item.notes ?? []) lines.push(`  note: ${note}`);
    for (const fix of item.fixes ?? []) {
        lines.push(`  help: ${fix.message}`);
        lines.push(`  fix: ${fix.span.source}:${fix.span.line}:${fix.span.column}: replace with '${fix.replacement}'`);
    }
    return lines.join('\n');
}
