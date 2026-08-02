export class Token {
    constructor(type, value, source, start, end, line, column) {
        this.type = type;
        this.value = value;
        this.source = source;
        this.start = start;
        this.end = end;
        this.line = line;
        this.column = column;
    }
}
