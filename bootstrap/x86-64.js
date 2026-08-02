const argumentRegisters = ['rdi', 'rsi', 'rdx', 'rcx', 'r8', 'r9'];

export class X86_64Backend {
    generate(program) {
        this.program = program;
        this.functionSymbols = new Map();
        this.fieldOffsets = new Map();
        this.typeSizes = new Map();
        this.stringLiterals = new Map();
        this.runtimeLabel = 0;

        for (const type of program.types) {
            let offset = 8;
            let alignment = 1;
            for (const field of type.fields) {
                const size = this.sizeOf(field.type);
                const fieldAlignment = Math.min(size, 8);
                offset = this.align(offset, fieldAlignment);
                this.fieldOffsets.set(field.symbol, {offset, type: field.type});
                offset += size;
                alignment = Math.max(alignment, fieldAlignment);
            }
            this.typeSizes.set(type.name, Math.max(8, this.align(offset, alignment)));
        }
        const usedAssemblySymbols = new Map();
        for (const fn of program.functions) {
            const assemblySymbol = this.mangle(fn.name);
            const existing = usedAssemblySymbols.get(assemblySymbol);
            if (existing) throw new Error(`Assembly symbol collision between '${existing}' and '${fn.name}'`);
            usedAssemblySymbols.set(assemblySymbol, fn.name);
            this.functionSymbols.set(fn.name, assemblySymbol);
        }
        for (const fn of program.functions) {
            for (const instruction of fn.blocks.flatMap(block => block.instructions)) {
                if (instruction.op === 'string_constant') this.internString(instruction.value);
            }
        }
        const supportedRuntimeSymbols = new Set([
            'argon_System_print',
            'argon_System_arguments',
            'argon_System_exit',
            'argon_System_write',
            'argon_System_writeError',
            'argon_System_openRead',
            'argon_System_openWrite',
            'argon_System_read',
            'argon_System_writeFile',
            'argon_System_close',
            'argon_System_lastError',
            'argon_System_currentDirectory',
            'argon_System_memoryCopy',
            'argon_System_memoryCompare'
        ]);
        for (const external of program.externals) {
            if (!supportedRuntimeSymbols.has(external.runtimeSymbol)) {
                throw new Error(`x86_64-linux runtime does not provide ${external.runtimeSymbol}`);
            }
            this.functionSymbols.set(external.name, external.runtimeSymbol);
        }

        const runtimeSymbols = new Set(program.externals.map(external => external.runtimeSymbol));
        this.needsProcessArguments = runtimeSymbols.has('argon_System_arguments');
        this.needsFilesystemState = [
            'argon_System_openRead', 'argon_System_openWrite', 'argon_System_read',
            'argon_System_writeFile', 'argon_System_close', 'argon_System_lastError',
            'argon_System_currentDirectory'
        ].some(symbol => runtimeSymbols.has(symbol));

        const lines = ['.intel_syntax noprefix', '.text'];
        for (const fn of program.functions) lines.push(...this.generateFunction(fn));
        lines.push(...this.generateMain());

        if (runtimeSymbols.has('argon_System_print')) lines.push(...this.printI64Runtime());
        if (this.needsProcessArguments) lines.push(...this.argumentsRuntime());
        if (runtimeSymbols.has('argon_System_exit')) lines.push(...this.exitRuntime());
        if (runtimeSymbols.has('argon_System_write')) lines.push(...this.writeRuntime('argon_System_write', 1));
        if (runtimeSymbols.has('argon_System_writeError')) lines.push(...this.writeRuntime('argon_System_writeError', 2));
        if (runtimeSymbols.has('argon_System_openRead')) lines.push(...this.openRuntime('argon_System_openRead', 0));
        if (runtimeSymbols.has('argon_System_openWrite')) lines.push(...this.openRuntime('argon_System_openWrite', 577));
        if (runtimeSymbols.has('argon_System_read')) lines.push(...this.fileReadRuntime());
        if (runtimeSymbols.has('argon_System_writeFile')) lines.push(...this.fileWriteRuntime());
        if (runtimeSymbols.has('argon_System_close')) lines.push(...this.fileCloseRuntime());
        if (runtimeSymbols.has('argon_System_lastError')) lines.push(...this.lastErrorRuntime());
        if (runtimeSymbols.has('argon_System_currentDirectory')) lines.push(...this.currentDirectoryRuntime());
        if (runtimeSymbols.has('argon_System_memoryCopy')) lines.push(...this.memoryCopyRuntime());
        if (runtimeSymbols.has('argon_System_memoryCompare')) lines.push(...this.memoryCompareRuntime());
        lines.push(...this.runtimeErrorRuntime());
        lines.push(...this.allocationRuntime());
        lines.push(...this.arrayRuntime());
        lines.push(...this.stringRuntime());
        lines.push(...this.builderRuntime());
        lines.push(...this.stringData());
        lines.push(...this.typeData());
        if (this.needsProcessArguments) lines.push(...this.processData());
        if (this.needsFilesystemState) lines.push(...this.filesystemData());
        lines.push('.section .note.GNU-stack,"",@progbits');
        return `${lines.join('\n')}\n`;
    }

    generateFunction(fn) {
        this.fn = fn;
        this.slots = new Map();
        let slotCount = 0;
        const reserve = key => {
            if (!this.slots.has(key)) this.slots.set(key, ++slotCount * 8);
        };

        for (const parameter of fn.parameters) reserve(`name:${parameter.name}`);
        for (const instruction of fn.blocks.flatMap(block => block.instructions)) {
            if (instruction.result) reserve(`temp:${instruction.result}`);
            if (instruction.op === 'declare_local' || instruction.op === 'store_local') {
                reserve(`name:${instruction.name}`);
            }
        }

        const frameSize = Math.ceil((slotCount * 8) / 16) * 16;
        const symbol = this.functionSymbols.get(fn.name);
        const endLabel = `${symbol}__return`;
        const lines = [
            `.globl ${symbol}`,
            `${symbol}:`,
            '    push rbp',
            '    mov rbp, rsp'
        ];
        if (frameSize) lines.push(`    sub rsp, ${frameSize}`);

        fn.parameters.forEach((parameter, index) => {
            if (index < argumentRegisters.length) {
                lines.push(`    mov ${this.slot(`name:${parameter.name}`)}, ${argumentRegisters[index]}`);
            } else {
                lines.push(
                    `    mov rax, QWORD PTR [rbp+${16 + (index - argumentRegisters.length) * 8}]`,
                    `    mov ${this.slot(`name:${parameter.name}`)}, rax`
                );
            }
        });

        for (const block of fn.blocks) {
            if (block.label !== 'entry') lines.push(`${this.blockLabel(block.label)}:`);
            for (const instruction of block.instructions) {
                lines.push(...this.generateInstruction(instruction, endLabel));
            }
        }

        lines.push(`${endLabel}:`, '    leave', '    ret', '');
        return lines;
    }

    generateInstruction(instruction, endLabel) {
        const lines = [];
        switch (instruction.op) {
            case 'constant':
                lines.push(`    mov rax, ${instruction.value}`, ...this.normalize('rax', instruction.type));
                lines.push(`    mov ${this.temp(instruction.result)}, rax`);
                break;
            case 'string_constant':
                lines.push(`    lea rax, [rip+${this.stringLiterals.get(instruction.value).descriptor}]`);
                lines.push(`    mov ${this.temp(instruction.result)}, rax`);
                break;
            case 'declare_local':
                if (instruction.value) {
                    lines.push(...this.load(instruction.value, 'rax'));
                    lines.push(`    mov ${this.named(instruction.name)}, rax`);
                } else lines.push(`    mov QWORD PTR ${this.named(instruction.name)}, 0`);
                break;
            case 'load_local':
                lines.push(`    mov rax, ${this.named(instruction.name)}`, `    mov ${this.temp(instruction.result)}, rax`);
                break;
            case 'store_local':
                lines.push(...this.load(instruction.value, 'rax'));
                lines.push(`    mov ${this.named(instruction.name)}, rax`);
                break;
            case 'load_field': {
                const field = this.requireField(instruction.field);
                lines.push(...this.load(instruction.object, 'rax'));
                lines.push(...this.loadMemory('[rax+' + field.offset + ']', field.type, 'rax'));
                lines.push(`    mov ${this.temp(instruction.result)}, rax`);
                break;
            }
            case 'store_field': {
                const field = this.requireField(instruction.field);
                lines.push(...this.load(instruction.object, 'rax'));
                lines.push(...this.load(instruction.value, 'rcx'));
                lines.push(`    mov ${this.memorySize(field.type)} PTR [rax+${field.offset}], ${this.registerForSize('rcx', field.type)}`);
                break;
            }
            case 'unary':
                lines.push(...this.load(instruction.operand, 'rax'));
                if (instruction.operator === '-') lines.push('    neg rax');
                else if (instruction.operator === '!') lines.push('    test rax, rax', '    sete al', '    movzx rax, al');
                else throw new Error(`Unsupported unary operator ${instruction.operator}`);
                lines.push(...this.normalize('rax', instruction.type));
                lines.push(`    mov ${this.temp(instruction.result)}, rax`);
                break;
            case 'binary':
                lines.push(...this.binary(instruction));
                break;
            case 'allocate':
                lines.push(`    mov rdi, ${this.typeSizes.get(instruction.objectType) ?? 8}`, '    call argon_alloc');
                lines.push(`    lea rcx, [rip+${this.typeLabel(instruction.objectType)}]`, '    mov QWORD PTR [rax], rcx');
                lines.push(`    mov ${this.temp(instruction.result)}, rax`);
                break;
            case 'array_new':
                lines.push(`    mov rdi, ${this.sizeOf(instruction.elementType)}`);
                lines.push(...this.load(instruction.length, 'rsi'));
                lines.push('    call argon_array_new', `    mov ${this.temp(instruction.result)}, rax`);
                break;
            case 'array_length':
                lines.push(...this.load(instruction.array, 'rax'));
                lines.push('    mov rax, QWORD PTR [rax]', `    mov ${this.temp(instruction.result)}, rax`);
                break;
            case 'array_load':
                lines.push(...this.load(instruction.array, 'rdi'));
                lines.push(...this.load(instruction.index, 'rsi'));
                lines.push(`    mov rdx, ${this.sizeOf(instruction.elementType)}`, '    call argon_array_address');
                lines.push(...this.loadMemory('[rax]', instruction.elementType, 'rax'));
                lines.push(`    mov ${this.temp(instruction.result)}, rax`);
                break;
            case 'array_store':
                lines.push(...this.load(instruction.array, 'rdi'));
                lines.push(...this.load(instruction.index, 'rsi'));
                lines.push(`    mov rdx, ${this.sizeOf(instruction.elementType)}`, '    call argon_array_address');
                lines.push(...this.load(instruction.value, 'rcx'));
                lines.push(`    mov ${this.memorySize(instruction.elementType)} PTR [rax], ${this.registerForSize('rcx', instruction.elementType)}`);
                break;
            case 'array_append':
                lines.push(...this.load(instruction.array, 'rdi'));
                lines.push(...this.load(instruction.value, 'rsi'));
                lines.push(`    mov rdx, ${this.sizeOf(instruction.elementType)}`, '    call argon_array_append');
                break;
            case 'string_length':
                lines.push(...this.load(instruction.string, 'rax'));
                lines.push('    mov rax, QWORD PTR [rax+8]', `    mov ${this.temp(instruction.result)}, rax`);
                break;
            case 'string_load':
                lines.push(...this.load(instruction.array, 'rdi'));
                lines.push(...this.load(instruction.index, 'rsi'));
                lines.push('    call argon_string_address', '    movzx eax, BYTE PTR [rax]');
                lines.push(`    mov ${this.temp(instruction.result)}, rax`);
                break;
            case 'string_concat':
                lines.push(...this.load(instruction.left, 'rdi'), ...this.load(instruction.right, 'rsi'));
                lines.push('    call argon_string_concat', `    mov ${this.temp(instruction.result)}, rax`);
                break;
            case 'string_equal':
                lines.push(...this.load(instruction.left, 'rdi'), ...this.load(instruction.right, 'rsi'));
                lines.push('    call argon_string_equal');
                if (instruction.negate) lines.push('    xor eax, 1');
                lines.push(`    mov ${this.temp(instruction.result)}, rax`);
                break;
            case 'string_slice':
                lines.push(...this.load(instruction.string, 'rdi'));
                lines.push(...this.load(instruction.start, 'rsi'));
                lines.push(...this.load(instruction.length, 'rdx'));
                lines.push('    call argon_string_slice', `    mov ${this.temp(instruction.result)}, rax`);
                break;
            case 'integer_to_string':
                lines.push(...this.load(instruction.value, 'rdi'));
                lines.push(`    mov esi, ${this.isUnsigned(instruction.integerType) ? 0 : 1}`);
                lines.push('    call argon_integer_to_string', `    mov ${this.temp(instruction.result)}, rax`);
                break;
            case 'builder_new':
                lines.push('    mov edi, 1', '    xor esi, esi', '    call argon_array_new');
                lines.push(`    mov ${this.temp(instruction.result)}, rax`);
                break;
            case 'builder_length':
                lines.push(...this.load(instruction.builder, 'rax'));
                lines.push('    mov rax, QWORD PTR [rax]', `    mov ${this.temp(instruction.result)}, rax`);
                break;
            case 'builder_append_string':
                lines.push(...this.load(instruction.builder, 'rdi'), ...this.load(instruction.value, 'rsi'));
                lines.push('    call argon_builder_append_string');
                break;
            case 'builder_append_byte':
                lines.push(...this.load(instruction.builder, 'rdi'), ...this.load(instruction.value, 'rsi'));
                lines.push('    mov edx, 1', '    call argon_array_append');
                break;
            case 'builder_build':
                lines.push(...this.load(instruction.builder, 'rdi'));
                lines.push('    call argon_builder_build', `    mov ${this.temp(instruction.result)}, rax`);
                break;
            case 'call':
                lines.push(...this.call(instruction));
                break;
            case 'virtual_call':
                lines.push(...this.call(instruction, true));
                break;
            case 'type_test':
            case 'checked_cast': {
                const id = this.runtimeLabel++;
                const loop = `.Ltype_test_${id}`;
                const match = `.Ltype_match_${id}`;
                const done = `.Ltype_done_${id}`;
                lines.push(...this.load(instruction.value, 'rcx'), '    xor eax, eax', '    test rcx, rcx', `    jz ${done}`,
                    '    mov rdx, QWORD PTR [rcx]', `    lea r8, [rip+${this.typeLabel(instruction.targetType)}]`, `${loop}:`,
                    '    test rdx, rdx', `    jz ${done}`, '    cmp rdx, r8', `    je ${match}`, '    mov rdx, QWORD PTR [rdx]', `    jmp ${loop}`,
                    `${match}:`, instruction.op === 'type_test' ? '    mov eax, 1' : '    mov rax, rcx', `${done}:`,
                    `    mov ${this.temp(instruction.result)}, rax`);
                break;
            }
            case 'convert':
                lines.push(...this.load(instruction.value, 'rax'));
                lines.push(...this.normalize('rax', instruction.type));
                lines.push(`    mov ${this.temp(instruction.result)}, rax`);
                break;
            case 'unwrap':
                lines.push(...this.load(instruction.value, 'rax'));
                lines.push('    test rax, rax', '    jz .Loptional_unwrap_error');
                lines.push(`    mov ${this.temp(instruction.result)}, rax`);
                break;
            case 'jump':
                lines.push(`    jmp ${this.blockLabel(instruction.target)}`);
                break;
            case 'branch':
                lines.push(...this.load(instruction.condition, 'rax'));
                lines.push(
                    '    test rax, rax',
                    `    jnz ${this.blockLabel(instruction.thenTarget)}`,
                    `    jmp ${this.blockLabel(instruction.elseTarget)}`
                );
                break;
            case 'return':
                if (instruction.value) lines.push(...this.load(instruction.value, 'rax'));
                else lines.push('    xor eax, eax');
                lines.push(`    jmp ${endLabel}`);
                break;
            default:
                throw new Error(`Unsupported IR instruction ${instruction.op}`);
        }
        return lines;
    }

    binary(instruction) {
        const lines = [...this.load(instruction.left, 'rax'), ...this.load(instruction.right, 'rcx')];
        const simple = {'+': 'add rax, rcx', '-': 'sub rax, rcx', '*': 'imul rax, rcx', '&&': 'and rax, rcx', '||': 'or rax, rcx'};
        const condition = {'==': 'sete', '!=': 'setne', '===': 'sete', '!==': 'setne', '<': 'setl', '<=': 'setle', '>': 'setg', '>=': 'setge'};
        if (simple[instruction.operator]) lines.push(`    ${simple[instruction.operator]}`);
        else if (instruction.operator === '/') {
            lines.push('    test rcx, rcx', '    jz .Ldivision_by_zero_error');
            if (this.isUnsigned(instruction.left.type)) lines.push('    xor edx, edx', '    div rcx');
            else lines.push('    cqo', '    idiv rcx');
        }
        else if (condition[instruction.operator]) {
            const unsignedCondition = {'<': 'setb', '<=': 'setbe', '>': 'seta', '>=': 'setae'};
            const opcode = this.isUnsigned(instruction.left.type) && unsignedCondition[instruction.operator]
                ? unsignedCondition[instruction.operator]
                : condition[instruction.operator];
            lines.push('    cmp rax, rcx', `    ${opcode} al`, '    movzx rax, al');
        } else throw new Error(`Unsupported binary operator ${instruction.operator}`);
        lines.push(...this.normalize('rax', instruction.type));
        lines.push(`    mov ${this.temp(instruction.result)}, rax`);
        return lines;
    }

    call(instruction, dynamic = false) {
        const lines = [];
        instruction.arguments.slice(0, argumentRegisters.length)
            .forEach((argument, index) => lines.push(...this.load(argument, argumentRegisters[index])));
        const stackArguments = instruction.arguments.slice(argumentRegisters.length);
        const padding = stackArguments.length % 2 === 1 ? 8 : 0;
        if (padding) lines.push('    sub rsp, 8');
        for (let index = stackArguments.length - 1; index >= 0; index--) {
            lines.push(...this.load(stackArguments[index], 'rax'), '    push rax');
        }
        if (dynamic) {
            lines.push('    mov rax, QWORD PTR [rdi]', `    call QWORD PTR [rax+${8 + instruction.slot * 8}]`);
        } else {
            const target = this.functionSymbols.get(instruction.target);
            if (!target) throw new Error(`No function symbol for ${instruction.target}`);
            lines.push(`    call ${target}`);
        }
        const stackBytes = stackArguments.length * 8 + padding;
        if (stackBytes) lines.push(`    add rsp, ${stackBytes}`);
        if (instruction.result) lines.push(`    mov ${this.temp(instruction.result)}, rax`);
        return lines;
    }

    generateMain() {
        const entry = this.program.functions.find(fn => fn.name === this.program.entry);
        if (!entry) throw new Error('Program has no entry.__ method');
        const entryType = entry.owner;
        const entrySymbol = this.functionSymbols.get(entry.name);
        const initializer = this.program.types.find(type => type.name === entryType)?.initializer;
        return [
            '.globl main',
            'main:',
            '    push rbp',
            '    mov rbp, rsp',
            ...(this.needsProcessArguments ? [
                '    mov QWORD PTR [rip+argon_process_argc], rdi',
                '    mov QWORD PTR [rip+argon_process_argv], rsi'
            ] : []),
            '    sub rsp, 16',
            `    mov rdi, ${this.typeSizes.get(entryType) ?? 8}`,
            '    call argon_alloc',
            `    lea rcx, [rip+${this.typeLabel(entryType)}]`,
            '    mov QWORD PTR [rax], rcx',
            '    mov QWORD PTR [rbp-8], rax',
            ...(initializer ? [
                '    mov rdi, rax',
                `    call ${this.functionSymbols.get(initializer)}`
            ] : []),
            '    mov rdi, QWORD PTR [rbp-8]',
            `    call ${entrySymbol}`,
            ...(entry.returnType === 'void' ? ['    xor eax, eax'] : []),
            '    leave',
            '    ret',
            ''
        ];
    }

    typeLabel(typeName) {
        return `.Largon_type_${this.mangle(typeName)}`;
    }

    typeData() {
        const lines = ['.section .data', '.align 8'];
        for (const type of this.program.types) {
            lines.push(`${this.typeLabel(type.name)}:`, type.base ? `    .quad ${this.typeLabel(type.base)}` : '    .quad 0');
            for (const method of type.virtualMethods ?? []) lines.push(`    .quad ${this.functionSymbols.get(method.target)}`);
        }
        lines.push('.text');
        return lines;
    }

    printI64Runtime() {
        return [
            '.globl argon_System_print',
            'argon_System_print:',
            '    push rbp',
            '    mov rbp, rsp',
            '    sub rsp, 64',
            '    mov rax, rdi',
            '    xor r8d, r8d',
            '    test rax, rax',
            '    jns .Lprint_magnitude',
            '    neg rax',
            '    mov r8d, 1',
            '.Lprint_magnitude:',
            '    lea rsi, [rbp-1]',
            '    mov BYTE PTR [rsi], 10',
            '    mov r10, 10',
            '.Lprint_digits:',
            '    xor edx, edx',
            '    div r10',
            '    add dl, 48',
            '    dec rsi',
            '    mov BYTE PTR [rsi], dl',
            '    test rax, rax',
            '    jne .Lprint_digits',
            '    test r8d, r8d',
            '    jz .Lprint_write',
            '    dec rsi',
            '    mov BYTE PTR [rsi], 45',
            '.Lprint_write:',
            '    lea rdx, [rbp]',
            '    sub rdx, rsi',
            '    mov eax, 1',
            '    mov edi, 1',
            '    syscall',
            '    leave',
            '    ret',
            ''
        ];
    }

    argumentsRuntime() {
        return [
            '.globl argon_System_arguments',
            'argon_System_arguments:',
            '    push rbp',
            '    mov rbp, rsp',
            '    push rbx',
            '    push r12',
            '    push r13',
            '    push r14',
            '    push r15',
            '    sub rsp, 8',
            '    mov rbx, QWORD PTR [rip+argon_process_argc]',
            '    mov r12, QWORD PTR [rip+argon_process_argv]',
            '    mov edi, 8',
            '    mov rsi, rbx',
            '    call argon_array_new',
            '    mov r13, rax',
            '    xor r14d, r14d',
            '.Larguments_next:',
            '    cmp r14, rbx',
            '    jae .Larguments_done',
            '    mov rdx, QWORD PTR [r12+r14*8]',
            '    xor r15d, r15d',
            '.Larguments_length:',
            '    cmp BYTE PTR [rdx+r15], 0',
            '    je .Larguments_wrap',
            '    inc r15',
            '    jmp .Larguments_length',
            '.Larguments_wrap:',
            '    mov edi, 16',
            '    call argon_alloc',
            '    mov rdx, QWORD PTR [r12+r14*8]',
            '    mov QWORD PTR [rax], rdx',
            '    mov QWORD PTR [rax+8], r15',
            '    mov rdx, QWORD PTR [r13+16]',
            '    mov QWORD PTR [rdx+r14*8], rax',
            '    inc r14',
            '    jmp .Larguments_next',
            '.Larguments_done:',
            '    mov rax, r13',
            '    add rsp, 8',
            '    pop r15',
            '    pop r14',
            '    pop r13',
            '    pop r12',
            '    pop rbx',
            '    leave',
            '    ret',
            ''
        ];
    }

    exitRuntime() {
        return [
            '.globl argon_System_exit',
            'argon_System_exit:',
            '    mov eax, 60',
            '    syscall',
            '    ud2',
            ''
        ];
    }

    writeRuntime(symbol, descriptor) {
        const label = `.L${symbol}_`;
        return [
            `.globl ${symbol}`,
            `${symbol}:`,
            '    mov rsi, QWORD PTR [rdi]',
            '    mov rdx, QWORD PTR [rdi+8]',
            `${label}next:`,
            '    test rdx, rdx',
            `    je ${label}done`,
            '    mov eax, 1',
            `    mov edi, ${descriptor}`,
            '    syscall',
            '    cmp rax, -4',
            `    je ${label}next`,
            '    test rax, rax',
            `    jle ${label}done`,
            '    add rsi, rax',
            '    sub rdx, rax',
            `    jmp ${label}next`,
            `${label}done:`,
            '    ret',
            ''
        ];
    }

    openRuntime(symbol, flags) {
        const label = `.L${symbol}_`;
        return [
            `.globl ${symbol}`,
            `${symbol}:`,
            '    push rbp',
            '    mov rbp, rsp',
            '    push rbx',
            '    push r12',
            '    push r13',
            '    sub rsp, 8',
            '    mov r12, QWORD PTR [rdi]',
            '    mov r13, QWORD PTR [rdi+8]',
            '    lea rdi, [r13+1]',
            '    call argon_alloc',
            '    mov rbx, rax',
            '    mov rdi, rax',
            '    mov rsi, r12',
            '    mov rcx, r13',
            '    rep movsb',
            '    mov BYTE PTR [rbx+r13], 0',
            '    mov eax, 257',
            '    mov rdi, -100',
            '    mov rsi, rbx',
            `    mov edx, ${flags}`,
            '    mov r10d, 420',
            '    syscall',
            '    test rax, rax',
            `    js ${label}error`,
            '    mov QWORD PTR [rip+argon_filesystem_error], 0',
            '    mov r12, rax',
            '    mov edi, 8',
            '    call argon_alloc',
            '    mov QWORD PTR [rax], r12',
            `    jmp ${label}done`,
            `${label}error:`,
            '    neg rax',
            '    mov QWORD PTR [rip+argon_filesystem_error], rax',
            '    xor eax, eax',
            `${label}done:`,
            '    add rsp, 8',
            '    pop r13',
            '    pop r12',
            '    pop rbx',
            '    leave',
            '    ret',
            ''
        ];
    }

    fileReadRuntime() {
        return [
            '.globl argon_System_read',
            'argon_System_read:',
            '    test rsi, rsi',
            '    js .Lfile_read_error',
            '    push rbp',
            '    mov rbp, rsp',
            '    push rbx',
            '    push r12',
            '    push r13',
            '    push r14',
            '    mov r12, QWORD PTR [rdi]',
            '    mov r13, rsi',
            '    mov rdi, r13',
            '    call argon_alloc',
            '    mov rbx, rax',
            '    xor eax, eax',
            '    mov rdi, r12',
            '    mov rsi, rbx',
            '    mov rdx, r13',
            '    syscall',
            '    test rax, rax',
            '    js .Lfile_read_error_frame',
            '    mov QWORD PTR [rip+argon_filesystem_error], 0',
            '    mov r14, rax',
            '    mov edi, 16',
            '    call argon_alloc',
            '    mov QWORD PTR [rax], rbx',
            '    mov QWORD PTR [rax+8], r14',
            '    jmp .Lfile_read_done',
            '.Lfile_read_error_frame:',
            '    neg rax',
            '    mov QWORD PTR [rip+argon_filesystem_error], rax',
            '    xor eax, eax',
            '.Lfile_read_done:',
            '    pop r14',
            '    pop r13',
            '    pop r12',
            '    pop rbx',
            '    leave',
            '    ret',
            '.Lfile_read_error:',
            '    mov QWORD PTR [rip+argon_filesystem_error], 22',
            '    xor eax, eax',
            '    ret',
            ''
        ];
    }

    fileWriteRuntime() {
        return [
            '.globl argon_System_writeFile',
            'argon_System_writeFile:',
            '    mov r8, QWORD PTR [rdi]',
            '    mov rdx, QWORD PTR [rsi+8]',
            '    mov rsi, QWORD PTR [rsi]',
            '    xor r9d, r9d',
            '.Lfile_write_next:',
            '    test rdx, rdx',
            '    je .Lfile_write_done',
            '    mov eax, 1',
            '    mov rdi, r8',
            '    syscall',
            '    cmp rax, -4',
            '    je .Lfile_write_next',
            '    test rax, rax',
            '    js .Lfile_write_error',
            '    add r9, rax',
            '    add rsi, rax',
            '    sub rdx, rax',
            '    jmp .Lfile_write_next',
            '.Lfile_write_done:',
            '    mov QWORD PTR [rip+argon_filesystem_error], 0',
            '    mov rax, r9',
            '    ret',
            '.Lfile_write_error:',
            '    mov r10, rax',
            '    neg r10',
            '    mov QWORD PTR [rip+argon_filesystem_error], r10',
            '    test r9, r9',
            '    cmovnz rax, r9',
            '    ret',
            ''
        ];
    }

    fileCloseRuntime() {
        return [
            '.globl argon_System_close',
            'argon_System_close:',
            '    mov rdi, QWORD PTR [rdi]',
            '    mov eax, 3',
            '    syscall',
            '    test rax, rax',
            '    js .Lfile_close_error',
            '    mov QWORD PTR [rip+argon_filesystem_error], 0',
            '    ret',
            '.Lfile_close_error:',
            '    mov r10, rax',
            '    neg r10',
            '    mov QWORD PTR [rip+argon_filesystem_error], r10',
            '    ret',
            ''
        ];
    }

    lastErrorRuntime() {
        return [
            '.globl argon_System_lastError',
            'argon_System_lastError:',
            '    mov rax, QWORD PTR [rip+argon_filesystem_error]',
            '    ret',
            ''
        ];
    }

    currentDirectoryRuntime() {
        return [
            '.globl argon_System_currentDirectory',
            'argon_System_currentDirectory:',
            '    push rbp',
            '    mov rbp, rsp',
            '    push rbx',
            '    push r12',
            '    mov edi, 4096',
            '    call argon_alloc',
            '    mov rbx, rax',
            '    mov rdi, rax',
            '    mov esi, 4096',
            '    mov eax, 79',
            '    syscall',
            '    test rax, rax',
            '    js .Lcurrent_directory_error',
            '    xor r12d, r12d',
            '.Lcurrent_directory_length:',
            '    cmp BYTE PTR [rbx+r12], 0',
            '    je .Lcurrent_directory_wrap',
            '    inc r12',
            '    jmp .Lcurrent_directory_length',
            '.Lcurrent_directory_wrap:',
            '    mov QWORD PTR [rip+argon_filesystem_error], 0',
            '    mov edi, 16',
            '    call argon_alloc',
            '    mov QWORD PTR [rax], rbx',
            '    mov QWORD PTR [rax+8], r12',
            '    jmp .Lcurrent_directory_done',
            '.Lcurrent_directory_error:',
            '    neg rax',
            '    mov QWORD PTR [rip+argon_filesystem_error], rax',
            '    xor eax, eax',
            '.Lcurrent_directory_done:',
            '    pop r12',
            '    pop rbx',
            '    leave',
            '    ret',
            ''
        ];
    }

    memoryCopyRuntime() {
        return [
            '.globl argon_System_memoryCopy',
            'argon_System_memoryCopy:',
            '    test rsi, rsi',
            '    js .Larray_bounds_error',
            '    test rcx, rcx',
            '    js .Larray_bounds_error',
            '    test r8, r8',
            '    js .Larray_bounds_error',
            '    mov r9, QWORD PTR [rdi]',
            '    sub r9, rsi',
            '    jb .Larray_bounds_error',
            '    cmp r8, r9',
            '    ja .Larray_bounds_error',
            '    mov r9, QWORD PTR [rdx]',
            '    sub r9, rcx',
            '    jb .Larray_bounds_error',
            '    cmp r8, r9',
            '    ja .Larray_bounds_error',
            '    add rsi, QWORD PTR [rdi+16]',
            '    mov rdi, rsi',
            '    add rcx, QWORD PTR [rdx+16]',
            '    mov rsi, rcx',
            '    mov rcx, r8',
            '    rep movsb',
            '    mov eax, 1',
            '    ret',
            ''
        ];
    }

    memoryCompareRuntime() {
        return [
            '.globl argon_System_memoryCompare',
            'argon_System_memoryCompare:',
            '    test rsi, rsi',
            '    js .Larray_bounds_error',
            '    test rcx, rcx',
            '    js .Larray_bounds_error',
            '    test r8, r8',
            '    js .Larray_bounds_error',
            '    mov r9, QWORD PTR [rdi]',
            '    sub r9, rsi',
            '    jb .Larray_bounds_error',
            '    cmp r8, r9',
            '    ja .Larray_bounds_error',
            '    mov r9, QWORD PTR [rdx]',
            '    sub r9, rcx',
            '    jb .Larray_bounds_error',
            '    cmp r8, r9',
            '    ja .Larray_bounds_error',
            '    add rsi, QWORD PTR [rdi+16]',
            '    mov rdi, rsi',
            '    add rcx, QWORD PTR [rdx+16]',
            '    mov rsi, rcx',
            '    mov rcx, r8',
            '    repe cmpsb',
            '    je .Lmemory_compare_equal',
            '    mov eax, -1',
            '    mov r10d, 1',
            '    cmova eax, r10d',
            '    ret',
            '.Lmemory_compare_equal:',
            '    xor eax, eax',
            '    ret',
            ''
        ];
    }

    processData() {
        return [
            '.section .bss',
            '.align 8',
            'argon_process_argc:',
            '    .zero 8',
            'argon_process_argv:',
            '    .zero 8',
            ''
        ];
    }

    filesystemData() {
        return [
            '.section .bss',
            '.align 8',
            'argon_filesystem_error:',
            '    .zero 8',
            ''
        ];
    }

    runtimeErrorRuntime() {
        return [
            '.Ldivision_by_zero_error:',
            '    mov edi, 73',
            '    jmp .Lruntime_error',
            '.Lruntime_error:',
            '    mov eax, 60',
            '    syscall',
            '    ud2',
            ''
        ];
    }

    allocationRuntime() {
        // Anonymous mmap is the bootstrap allocator and guarantees zero-filled storage.
        return [
            '.globl argon_alloc',
            'argon_alloc:',
            '    test rdi, rdi',
            '    jnz .Lalloc_size',
            '    mov edi, 1',
            '.Lalloc_size:',
            '    mov rsi, rdi',
            '    xor edi, edi',
            '    mov edx, 3',
            '    mov r10d, 34',
            '    mov r8, -1',
            '    xor r9d, r9d',
            '    mov eax, 9',
            '    syscall',
            '    cmp rax, -4095',
            '    jae .Lallocation_error',
            '    ret',
            '.Lallocation_error:',
            '    mov edi, 72',
            '    jmp .Lruntime_error',
            '.Loptional_unwrap_error:',
            '    mov edi, 71',
            '    jmp .Lruntime_error',
            ''
        ];
    }

    arrayRuntime() {
        return [
            '.globl argon_array_new',
            'argon_array_new:',
            '    push rbp',
            '    mov rbp, rsp',
            '    push rbx',
            '    push r12',
            '    push r13',
            '    sub rsp, 8',
            '    mov r12, rdi',
            '    mov rbx, rsi',
            '    test rbx, rbx',
            '    js .Larray_bounds_error',
            '    mov edi, 24',
            '    call argon_alloc',
            '    mov r13, rax',
            '    mov rax, rbx',
            '    cmp rax, 4',
            '    jae .Larray_new_capacity',
            '    mov eax, 4',
            '.Larray_new_capacity:',
            '    mov QWORD PTR [r13], rbx',
            '    mov QWORD PTR [r13+8], rax',
            '    imul rax, r12',
            '    mov rdi, rax',
            '    call argon_alloc',
            '    mov QWORD PTR [r13+16], rax',
            '    mov rax, r13',
            '    add rsp, 8',
            '    pop r13',
            '    pop r12',
            '    pop rbx',
            '    leave',
            '    ret',
            '',
            '.globl argon_array_address',
            'argon_array_address:',
            '    test rsi, rsi',
            '    js .Larray_bounds_error',
            '    cmp rsi, QWORD PTR [rdi]',
            '    jae .Larray_bounds_error',
            '    imul rsi, rdx',
            '    mov rax, QWORD PTR [rdi+16]',
            '    add rax, rsi',
            '    ret',
            '.Larray_bounds_error:',
            '    mov edi, 70',
            '    jmp .Lruntime_error',
            '',
            '.globl argon_array_append',
            'argon_array_append:',
            '    push rbp',
            '    mov rbp, rsp',
            '    push rbx',
            '    push r12',
            '    push r13',
            '    push r14',
            '    mov rbx, rdi',
            '    mov r12, rsi',
            '    mov r13, rdx',
            '    mov r14, QWORD PTR [rbx]',
            '    cmp r14, QWORD PTR [rbx+8]',
            '    jb .Larray_append_store',
            '    mov rax, QWORD PTR [rbx+8]',
            '    shl rax, 1',
            '    mov QWORD PTR [rbx+8], rax',
            '    imul rax, r13',
            '    mov rdi, rax',
            '    call argon_alloc',
            '    mov rdi, rax',
            '    mov rsi, QWORD PTR [rbx+16]',
            '    mov rcx, r14',
            '    imul rcx, r13',
            '    rep movsb',
            '    mov QWORD PTR [rbx+16], rax',
            '.Larray_append_store:',
            '    mov rax, r14',
            '    imul rax, r13',
            '    add rax, QWORD PTR [rbx+16]',
            '    cmp r13, 1',
            '    je .Larray_store_1',
            '    cmp r13, 2',
            '    je .Larray_store_2',
            '    cmp r13, 4',
            '    je .Larray_store_4',
            '    mov QWORD PTR [rax], r12',
            '    jmp .Larray_append_done',
            '.Larray_store_1:',
            '    mov BYTE PTR [rax], r12b',
            '    jmp .Larray_append_done',
            '.Larray_store_2:',
            '    mov WORD PTR [rax], r12w',
            '    jmp .Larray_append_done',
            '.Larray_store_4:',
            '    mov DWORD PTR [rax], r12d',
            '.Larray_append_done:',
            '    inc r14',
            '    mov QWORD PTR [rbx], r14',
            '    pop r14',
            '    pop r13',
            '    pop r12',
            '    pop rbx',
            '    leave',
            '    ret',
            ''
        ];
    }

    stringRuntime() {
        return [
            '.globl argon_string_address',
            'argon_string_address:',
            '    test rsi, rsi',
            '    js .Lstring_bounds_error',
            '    cmp rsi, QWORD PTR [rdi+8]',
            '    jae .Lstring_bounds_error',
            '    mov rax, QWORD PTR [rdi]',
            '    add rax, rsi',
            '    ret',
            '.Lstring_bounds_error:',
            '    mov edi, 70',
            '    jmp .Lruntime_error',
            '',
            '.globl argon_string_equal',
            'argon_string_equal:',
            '    mov rcx, QWORD PTR [rdi+8]',
            '    cmp rcx, QWORD PTR [rsi+8]',
            '    jne .Lstring_not_equal',
            '    mov rdi, QWORD PTR [rdi]',
            '    mov rsi, QWORD PTR [rsi]',
            '    repe cmpsb',
            '    sete al',
            '    movzx eax, al',
            '    ret',
            '.Lstring_not_equal:',
            '    xor eax, eax',
            '    ret',
            '',
            '.globl argon_string_concat',
            'argon_string_concat:',
            '    push rbp',
            '    mov rbp, rsp',
            '    push rbx',
            '    push r12',
            '    push r13',
            '    push r14',
            '    mov r14, rdi',
            '    mov r12, rsi',
            '    mov r13, QWORD PTR [r14+8]',
            '    add r13, QWORD PTR [r12+8]',
            '    mov edi, 16',
            '    call argon_alloc',
            '    mov QWORD PTR [rax+8], r13',
            '    mov rbx, rax',
            '    mov rdi, r13',
            '    call argon_alloc',
            '    mov QWORD PTR [rbx], rax',
            '    mov rdi, rax',
            '    mov rsi, QWORD PTR [r14]',
            '    mov rcx, QWORD PTR [r14+8]',
            '    rep movsb',
            '    mov rsi, QWORD PTR [r12]',
            '    mov rcx, QWORD PTR [r12+8]',
            '    rep movsb',
            '    mov rax, rbx',
            '    pop r14',
            '    pop r13',
            '    pop r12',
            '    pop rbx',
            '    leave',
            '    ret',
            '',
            '.globl argon_string_slice',
            'argon_string_slice:',
            '    test rsi, rsi',
            '    js .Lstring_bounds_error',
            '    test rdx, rdx',
            '    js .Lstring_bounds_error',
            '    mov rax, rsi',
            '    add rax, rdx',
            '    jc .Lstring_bounds_error',
            '    cmp rax, QWORD PTR [rdi+8]',
            '    ja .Lstring_bounds_error',
            '    push rbp',
            '    mov rbp, rsp',
            '    push rbx',
            '    push r12',
            '    push r13',
            '    push r14',
            '    mov r14, rdi',
            '    mov r12, rsi',
            '    mov r13, rdx',
            '    mov edi, 16',
            '    call argon_alloc',
            '    mov QWORD PTR [rax+8], r13',
            '    mov rbx, rax',
            '    mov rdi, r13',
            '    call argon_alloc',
            '    mov QWORD PTR [rbx], rax',
            '    mov rdi, rax',
            '    mov rsi, QWORD PTR [r14]',
            '    add rsi, r12',
            '    mov rcx, r13',
            '    rep movsb',
            '    mov rax, rbx',
            '    pop r14',
            '    pop r13',
            '    pop r12',
            '    pop rbx',
            '    leave',
            '    ret',
            ''
        ];
    }

    builderRuntime() {
        return [
            '.globl argon_integer_to_string',
            'argon_integer_to_string:',
            '    push rbp',
            '    mov rbp, rsp',
            '    push rbx',
            '    push r12',
            '    push r13',
            '    push r14',
            '    mov r12, rdi',
            '    mov r14, rsi',
            '    mov edi, 16',
            '    call argon_alloc',
            '    mov rbx, rax',
            '    mov edi, 21',
            '    call argon_alloc',
            '    mov r13, rax',
            '    lea rsi, [r13+21]',
            '    mov rdi, rsi',
            '    mov rax, r12',
            '    xor r8d, r8d',
            '    test r14, r14',
            '    jz .Linteger_string_magnitude',
            '    test rax, rax',
            '    jns .Linteger_string_magnitude',
            '    neg rax',
            '    mov r8d, 1',
            '.Linteger_string_magnitude:',
            '    mov r10, 10',
            '.Linteger_string_digits:',
            '    xor edx, edx',
            '    div r10',
            '    add dl, 48',
            '    dec rsi',
            '    mov BYTE PTR [rsi], dl',
            '    test rax, rax',
            '    jne .Linteger_string_digits',
            '    test r8d, r8d',
            '    jz .Linteger_string_done',
            '    dec rsi',
            '    mov BYTE PTR [rsi], 45',
            '.Linteger_string_done:',
            '    sub rdi, rsi',
            '    mov QWORD PTR [rbx], rsi',
            '    mov QWORD PTR [rbx+8], rdi',
            '    mov rax, rbx',
            '    pop r14',
            '    pop r13',
            '    pop r12',
            '    pop rbx',
            '    leave',
            '    ret',
            '',
            '.globl argon_builder_append_string',
            'argon_builder_append_string:',
            '    push rbp',
            '    mov rbp, rsp',
            '    push rbx',
            '    push r12',
            '    push r13',
            '    sub rsp, 8',
            '    mov rbx, rdi',
            '    mov r12, rsi',
            '    xor r13d, r13d',
            '.Lbuilder_append_loop:',
            '    cmp r13, QWORD PTR [r12+8]',
            '    jae .Lbuilder_append_done',
            '    mov rax, QWORD PTR [r12]',
            '    movzx esi, BYTE PTR [rax+r13]',
            '    mov rdi, rbx',
            '    mov edx, 1',
            '    call argon_array_append',
            '    inc r13',
            '    jmp .Lbuilder_append_loop',
            '.Lbuilder_append_done:',
            '    add rsp, 8',
            '    pop r13',
            '    pop r12',
            '    pop rbx',
            '    leave',
            '    ret',
            '',
            '.globl argon_builder_build',
            'argon_builder_build:',
            '    push rbp',
            '    mov rbp, rsp',
            '    push rbx',
            '    push r12',
            '    push r13',
            '    sub rsp, 8',
            '    mov r12, rdi',
            '    mov edi, 16',
            '    call argon_alloc',
            '    mov rbx, rax',
            '    mov r13, QWORD PTR [r12]',
            '    mov QWORD PTR [rbx+8], r13',
            '    mov rdi, r13',
            '    call argon_alloc',
            '    mov QWORD PTR [rbx], rax',
            '    mov rdi, rax',
            '    mov rsi, QWORD PTR [r12+16]',
            '    mov rcx, r13',
            '    rep movsb',
            '    mov rax, rbx',
            '    add rsp, 8',
            '    pop r13',
            '    pop r12',
            '    pop rbx',
            '    leave',
            '    ret',
            ''
        ];
    }

    internString(value) {
        if (this.stringLiterals.has(value)) return this.stringLiterals.get(value);
        const index = this.stringLiterals.size;
        const literal = {
            descriptor: `.Largon_string_${index}`,
            data: `.Largon_string_${index}_data`,
            bytes: [...new TextEncoder().encode(value)]
        };
        this.stringLiterals.set(value, literal);
        return literal;
    }

    stringData() {
        if (this.stringLiterals.size === 0) return [];
        const lines = ['.section .data.rel.ro', '.align 8'];
        for (const literal of this.stringLiterals.values()) {
            lines.push(`${literal.descriptor}:`, `    .quad ${literal.data}`, `    .quad ${literal.bytes.length}`);
            lines.push(`${literal.data}:`, `    .byte ${literal.bytes.length ? literal.bytes.join(', ') : 0}`);
        }
        return [...lines, '.text'];
    }

    load(value, register) {
        if (value.kind === 'temporary') return [`    mov ${register}, ${this.temp(value.name)}`];
        if (value.kind === 'parameter') return [`    mov ${register}, ${this.named(value.name)}`];
        throw new Error(`Unsupported IR operand ${value.kind}`);
    }

    temp(name) {
        return this.slot(`temp:${name}`);
    }

    named(name) {
        return this.slot(`name:${name}`);
    }

    slot(key) {
        const offset = this.slots.get(key);
        if (!offset) throw new Error(`Missing stack slot ${key}`);
        return `QWORD PTR [rbp-${offset}]`;
    }

    requireField(symbol) {
        const field = this.fieldOffsets.get(symbol);
        if (field === undefined) throw new Error(`Unknown field ${symbol}`);
        return field;
    }

    sizeOf(type) {
        if (type === 'u8' || type === 'i8' || type === 'bool') return 1;
        if (type === 'u16' || type === 'i16') return 2;
        if (type === 'u32' || type === 'i32') return 4;
        return 8;
    }

    align(value, alignment) {
        return Math.ceil(value / alignment) * alignment;
    }

    isUnsigned(type) {
        return type?.startsWith('u') || type === 'bool';
    }

    normalize(register, type) {
        if (register !== 'rax') throw new Error('Primitive normalization currently requires rax');
        if (type === 'u8' || type === 'bool') return ['    movzx eax, al'];
        if (type === 'i8') return ['    movsx rax, al'];
        if (type === 'u16') return ['    movzx eax, ax'];
        if (type === 'i16') return ['    movsx rax, ax'];
        if (type === 'u32') return ['    mov eax, eax'];
        if (type === 'i32') return ['    movsxd rax, eax'];
        return [];
    }

    memorySize(type) {
        return {u8: 'BYTE', i8: 'BYTE', bool: 'BYTE', u16: 'WORD', i16: 'WORD', u32: 'DWORD', i32: 'DWORD'}[type] ?? 'QWORD';
    }

    registerForSize(register, type) {
        const registers = {
            rcx: {1: 'cl', 2: 'cx', 4: 'ecx', 8: 'rcx'}
        };
        return registers[register][this.sizeOf(type)];
    }

    loadMemory(address, type, register) {
        if (register !== 'rax') throw new Error('Primitive memory loads currently require rax');
        if (type === 'u8' || type === 'bool') return [`    movzx eax, BYTE PTR ${address}`];
        if (type === 'i8') return [`    movsx rax, BYTE PTR ${address}`];
        if (type === 'u16') return [`    movzx eax, WORD PTR ${address}`];
        if (type === 'i16') return [`    movsx rax, WORD PTR ${address}`];
        if (type === 'u32') return [`    mov eax, DWORD PTR ${address}`];
        if (type === 'i32') return [`    movsxd rax, DWORD PTR ${address}`];
        return [`    mov rax, QWORD PTR ${address}`];
    }

    blockLabel(label) {
        return `${this.functionSymbols.get(this.fn.name)}__${label}`;
    }

    mangle(name) {
        let result = '__argon_';
        for (const character of name) {
            result += /[A-Za-z0-9]/.test(character)
                ? character
                : `_${character.codePointAt(0).toString(16)}_`;
        }
        return result;
    }
}
