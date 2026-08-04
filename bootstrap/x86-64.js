import {prepareIr} from './ir-validation.js';

const argumentRegisters = ['rdi', 'rsi', 'rdx', 'rcx', 'r8', 'r9'];

export class X86_64Backend {
    generate(program, {optimizationLevel = 1} = {}) {
        if (![0, 1].includes(optimizationLevel)) throw new Error(`Unsupported optimization level '-O${optimizationLevel}'`);
        this.optimize = optimizationLevel === 1;
        prepareIr(program, {optimize: this.optimize});
        this.program = program;
        this.functionSymbols = new Map();
        this.fieldOffsets = new Map();
        this.typeSizes = new Map();
        this.stringLiterals = new Map();
        this.floatLiterals = new Map();
        this.runtimeLabel = 0;

        for (const type of program.types) {
            let offset = 16;
            let alignment = 1;
            for (const field of type.fields) {
                const size = this.sizeOf(field.type);
                const fieldAlignment = Math.min(size, 8);
                offset = this.align(offset, fieldAlignment);
                this.fieldOffsets.set(field.symbol, {offset, type: field.type, ownership: field.ownership});
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
                if (instruction.op === 'float_constant') this.internFloat(instruction.value, instruction.type);
            }
        }
        const supportedRuntimeSymbols = new Set([
            'valen_System_print',
            'valen_System_arguments',
            'valen_System_exit',
            'valen_System_write',
            'valen_System_writeError',
            'valen_System_openRead',
            'valen_System_openWrite',
            'valen_System_read',
            'valen_System_writeFile',
            'valen_System_writeBytes',
            'valen_System_sync',
            'valen_System_close',
            'valen_System_replaceFile',
            'valen_System_removeFile',
            'valen_System_makeExecutable',
            'valen_System_lastError',
            'valen_System_currentDirectory',
            'valen_System_environmentVariable',
            'valen_System_collectGarbage',
            'valen_System_enableProcessArena',
            'valen_System_enableShutdownSignals',
            'valen_System_shutdownRequested',
            'valen_System_link',
            'valen_System_memoryCopy',
            'valen_System_memoryCompare',
            'valen_System_fileDescriptor', 'valen_System_makeFileNonblocking',
            'valen_Network_listen', 'valen_Network_accept', 'valen_Network_receive',
            'valen_Network_send', 'valen_Network_sendSome', 'valen_Network_closeListener', 'valen_Network_closeConnection',
            'valen_Network_lastError',
            'valen_Network_listenerDescriptor', 'valen_Network_connectionDescriptor',
            'valen_Network_makeListenerNonblocking', 'valen_Network_makeConnectionNonblocking',
            'valen_Operations_threadAvailable', 'valen_Operations_threadStart', 'valen_Operations_threadJoin',
            'valen_Operations_mutexLock', 'valen_Operations_mutexUnlock',
            'valen_Operations_conditionWait', 'valen_Operations_conditionNotifyOne', 'valen_Operations_conditionNotifyAll',
            'valen_Operations_atomicLoad', 'valen_Operations_atomicStore', 'valen_Operations_atomicExchange',
            'valen_Operations_atomicCompareExchange', 'valen_Operations_atomicAdd',
            'valen_EventLoop_available', 'valen_EventLoop_wait', 'valen_EventLoop_monotonicMilliseconds'
        ]);
        for (const external of program.externals) {
            if (!external.foreignLibrary && !supportedRuntimeSymbols.has(external.runtimeSymbol)) {
                throw new Error(`x86_64-linux runtime does not provide ${external.runtimeSymbol}`);
            }
            this.functionSymbols.set(external.name, external.runtimeSymbol);
        }

        const runtimeSymbols = new Set(program.externals.map(external => external.runtimeSymbol));
        this.needsProcessArguments = runtimeSymbols.has('valen_System_arguments') || runtimeSymbols.has('valen_System_link') || runtimeSymbols.has('valen_System_environmentVariable');
        this.needsFilesystemState = [
            'valen_System_openRead', 'valen_System_openWrite', 'valen_System_read',
            'valen_System_writeFile', 'valen_System_writeBytes', 'valen_System_sync', 'valen_System_close',
            'valen_System_replaceFile', 'valen_System_removeFile', 'valen_System_makeExecutable', 'valen_System_lastError',
            'valen_System_currentDirectory'
        ].some(symbol => runtimeSymbols.has(symbol));

        const lines = ['.intel_syntax noprefix', '.text'];
        if (runtimeSymbols.has('valen_Operations_threadStart')) lines.push('.extern pthread_create', '.extern pthread_join');
        for (const external of program.externals) {
            if (external.foreignLibrary) lines.push(`.extern ${external.runtimeSymbol}`);
        }
        for (const fn of program.functions) lines.push(...this.generateFunction(fn));
        lines.push(...this.generateMain());
        lines.push(...this.structuralRuntime());
        lines.push(...this.gcTraceFunctions());
        lines.push(...this.gcArrayTraceFunctions());

        if (runtimeSymbols.has('valen_System_print')) lines.push(...this.printI64Runtime());
        else lines.push(...this.byteConversionRuntime());
        if (this.needsProcessArguments) lines.push(...this.argumentsRuntime());
        else lines.push(...this.arrayMutationRuntime());
        if (runtimeSymbols.has('valen_System_exit')) lines.push(...this.exitRuntime());
        if (runtimeSymbols.has('valen_System_write')) lines.push(...this.writeRuntime('valen_System_write', 1));
        if (runtimeSymbols.has('valen_System_writeError')) lines.push(...this.writeRuntime('valen_System_writeError', 2));
        if (runtimeSymbols.has('valen_System_openRead')) lines.push(...this.openRuntime('valen_System_openRead', 0));
        if (runtimeSymbols.has('valen_System_openWrite')) lines.push(...this.openRuntime('valen_System_openWrite', 577));
        if (runtimeSymbols.has('valen_System_read')) lines.push(...this.fileReadRuntime());
        if (runtimeSymbols.has('valen_System_writeFile')) lines.push(...this.fileWriteRuntime());
        if (runtimeSymbols.has('valen_System_writeBytes')) lines.push(...this.fileWriteBytesRuntime());
        if (runtimeSymbols.has('valen_System_sync')) lines.push(...this.fileSyncRuntime());
        if (runtimeSymbols.has('valen_System_close')) lines.push(...this.fileCloseRuntime());
        if (runtimeSymbols.has('valen_System_replaceFile') || runtimeSymbols.has('valen_System_removeFile') || runtimeSymbols.has('valen_System_makeExecutable')) {
            lines.push(...this.pathMutationRuntime(runtimeSymbols));
        }
        if (runtimeSymbols.has('valen_System_lastError')) lines.push(...this.lastErrorRuntime());
        if (runtimeSymbols.has('valen_System_currentDirectory')) lines.push(...this.currentDirectoryRuntime());
        if (runtimeSymbols.has('valen_System_environmentVariable')) lines.push(...this.environmentVariableRuntime());
        if (runtimeSymbols.has('valen_System_collectGarbage')) lines.push('.globl valen_System_collectGarbage', 'valen_System_collectGarbage:', '    jmp valen_gc_collect', '');
        if (runtimeSymbols.has('valen_System_enableProcessArena')) lines.push('.globl valen_System_enableProcessArena', 'valen_System_enableProcessArena:', '    mov DWORD PTR [rip+valen_arena_enabled], 1', '    ret', '');
        if (runtimeSymbols.has('valen_System_enableShutdownSignals') || runtimeSymbols.has('valen_System_shutdownRequested')) lines.push(...this.shutdownSignalRuntime());
        if (runtimeSymbols.has('valen_System_link')) lines.push(...this.linkRuntime());
        if (runtimeSymbols.has('valen_System_memoryCopy')) lines.push(...this.memoryCopyRuntime());
        if (runtimeSymbols.has('valen_System_memoryCompare')) lines.push(...this.memoryCompareRuntime());
        if (runtimeSymbols.has('valen_System_fileDescriptor')) lines.push(...this.descriptorRuntime('valen_System_fileDescriptor'));
        if (runtimeSymbols.has('valen_System_makeFileNonblocking')) lines.push(...this.nonblockingRuntime('valen_System_makeFileNonblocking'));
        if ([...runtimeSymbols].some(symbol => symbol.startsWith('valen_Network_'))) lines.push(...this.networkRuntime());
        if ([...runtimeSymbols].some(symbol => symbol.startsWith('valen_EventLoop_'))) lines.push(...this.eventLoopRuntime(runtimeSymbols));
        if ([...runtimeSymbols].some(symbol => symbol.startsWith('valen_Operations_'))) lines.push(...this.operationsRuntime(runtimeSymbols));
        lines.push(...this.runtimeErrorRuntime());
        lines.push(...this.allocationRuntime());
        lines.push(...this.garbageCollectorRuntime());
        lines.push(...this.gcArrayRuntime());
        lines.push(...this.arrayRuntime());
        lines.push(...this.stringRuntime());
        lines.push(...this.builderRuntime());
        lines.push(...this.stringData());
        lines.push(...this.floatData());
        lines.push(...this.floatConversionData());
        lines.push(...this.typeData());
        lines.push(...this.gcData());
        if (program.functions.some(fn => fn.name === '$valen.test.run')) {
            lines.push('.section .rodata', 'valen_test_failure_message:', '    .ascii "test failed\\n"',
                '.bss', '.align 8', 'valen_test_failures:', '    .zero 8', '.text');
        }
        if (this.needsProcessArguments) lines.push(...this.processData());
        if (this.needsFilesystemState) lines.push(...this.filesystemData());
        if (runtimeSymbols.has('valen_System_enableShutdownSignals') || runtimeSymbols.has('valen_System_shutdownRequested')) lines.push('.bss', '.align 8', 'valen_shutdown_requested:', '    .zero 8', '.text');
        if ([...runtimeSymbols].some(symbol => symbol.startsWith('valen_Network_'))) lines.push('.bss', '.align 8', 'valen_network_error:', '    .zero 8', '.text');
        lines.push('.section .note.GNU-stack,"",@progbits');
        return `${lines.join('\n')}\n`;
    }

    networkRuntime() {
        const close = name => ['.globl '+name, name+':', '    jmp valen_gc_native_handle_finalize', ''];
        return [
            '.globl valen_Network_listen', 'valen_Network_listen:',
            '    push rbx', '    push r12', '    push r13', '    mov r12d, edi', '    mov ebx, esi',
            '    mov eax, 41', '    mov edi, 2', '    mov esi, 1', '    xor edx, edx', '    syscall',
            '    test rax, rax', '    js .Lnetwork_error_pop2', '    mov r10, rax',
            '    sub rsp, 16', '    mov DWORD PTR [rsp], 1', '    mov eax, 54', '    mov rdi, r10',
            '    mov esi, 1', '    mov edx, 2', '    mov r10, rsp', '    mov r8d, 4', '    syscall',
            '    mov r10, rdi', '    add rsp, 16', '    test rax, rax', '    js .Lnetwork_close_error_pop2',
            '    sub rsp, 16', '    mov WORD PTR [rsp], 2', '    mov eax, r12d', '    rol ax, 8',
            '    mov WORD PTR [rsp+2], ax', '    mov DWORD PTR [rsp+4], 0', '    mov QWORD PTR [rsp+8], 0',
            '    mov eax, 49', '    mov rdi, r10', '    mov rsi, rsp', '    mov edx, 16', '    syscall', '    add rsp, 16',
            '    test rax, rax', '    js .Lnetwork_close_error_pop2',
            '    mov eax, 50', '    mov rdi, r10', '    mov esi, ebx', '    syscall',
            '    test rax, rax', '    js .Lnetwork_close_error_pop2', '    mov r12, r10',
            '    mov edi, 24', '    xor esi, esi', '    xor edx, edx', '    lea rcx, [rip+valen_gc_native_handle_finalize]', '    call valen_gc_alloc', '    mov QWORD PTR [rax+8], 1', '    mov QWORD PTR [rax+16], r12',
            '    mov QWORD PTR [rip+valen_network_error], 0', '    pop r13', '    pop r12', '    pop rbx', '    ret',
            '.Lnetwork_close_error_pop2:', '    mov r12, rax', '    mov eax, 3', '    mov rdi, r10', '    syscall', '    mov rax, r12',
            '.Lnetwork_error_pop2:', '    neg rax', '    mov QWORD PTR [rip+valen_network_error], rax', '    xor eax, eax', '    pop r13', '    pop r12', '    pop rbx', '    ret', '',
            '.globl valen_Network_accept', 'valen_Network_accept:',
            '    mov rdi, QWORD PTR [rdi+16]', '    mov eax, 43', '    xor esi, esi', '    xor edx, edx', '    syscall',
            '    test rax, rax', '    js .Lnetwork_error', '    push rbx', '    mov rbx, rax', '    mov edi, 24', '    xor esi, esi', '    xor edx, edx', '    lea rcx, [rip+valen_gc_native_handle_finalize]', '    call valen_gc_alloc',
            '    mov QWORD PTR [rax+8], 1', '    mov QWORD PTR [rax+16], rbx', '    pop rbx', '    mov QWORD PTR [rip+valen_network_error], 0', '    ret',
            '.globl valen_Network_receive', 'valen_Network_receive:',
            '    test rsi, rsi', '    js .Lnetwork_invalid', '    push rbx', '    push r12', '    push r13',
            '    mov r12, QWORD PTR [rdi+16]', '    mov r13, rsi', '    mov rdi, r13', '    call valen_string_new', '    mov rbx, rax',
            '    xor eax, eax', '    mov rdi, r12', '    mov rsi, QWORD PTR [rbx]', '    mov rdx, r13', '    syscall',
            '    test rax, rax', '    js .Lnetwork_error_pop3', '    mov QWORD PTR [rbx+8], rax', '    mov rax, rbx', '    mov QWORD PTR [rip+valen_network_error], 0',
            '    pop r13', '    pop r12', '    pop rbx', '    ret',
            '.Lnetwork_error_pop3:', '    neg rax', '    mov QWORD PTR [rip+valen_network_error], rax', '    xor eax, eax', '    pop r13', '    pop r12', '    pop rbx', '    ret',
            '.Lnetwork_invalid:', '    mov QWORD PTR [rip+valen_network_error], 22', '    xor eax, eax', '    ret',
            '.globl valen_Network_send', 'valen_Network_send:',
            '    mov r8, QWORD PTR [rdi+16]', '    mov rdx, QWORD PTR [rsi+8]', '    mov rsi, QWORD PTR [rsi]', '    xor r9d, r9d',
            '.Lnetwork_send_next:', '    test rdx, rdx', '    je .Lnetwork_send_done', '    mov eax, 1', '    mov rdi, r8', '    syscall',
            '    cmp rax, -4', '    je .Lnetwork_send_next', '    test rax, rax', '    js .Lnetwork_send_error',
            '    add r9, rax', '    add rsi, rax', '    sub rdx, rax', '    jmp .Lnetwork_send_next',
            '.Lnetwork_send_done:', '    mov QWORD PTR [rip+valen_network_error], 0', '    mov rax, r9', '    ret',
            '.Lnetwork_send_error:', '    mov r10, rax', '    neg r10', '    mov QWORD PTR [rip+valen_network_error], r10', '    test r9, r9', '    cmovnz rax, r9', '    ret', '',
            '.globl valen_Network_sendSome', 'valen_Network_sendSome:',
            '    test rdx, rdx', '    js .Lnetwork_send_some_invalid', '    test rcx, rcx', '    js .Lnetwork_send_some_invalid',
            '    mov r8, QWORD PTR [rsi+8]', '    cmp rdx, r8', '    ja .Lnetwork_send_some_invalid', '    sub r8, rdx',
            '    cmp rcx, r8', '    ja .Lnetwork_send_some_invalid', '    mov rdi, QWORD PTR [rdi+16]', '    add rdx, QWORD PTR [rsi]',
            '    mov rsi, rdx', '    mov rdx, rcx', '.Lnetwork_send_some_retry:', '    mov eax, 1', '    syscall',
            '    cmp rax, -4', '    je .Lnetwork_send_some_retry', '    test rax, rax', '    js .Lnetwork_send_some_error',
            '    mov QWORD PTR [rip+valen_network_error], 0', '    ret',
            '.Lnetwork_send_some_invalid:', '    mov QWORD PTR [rip+valen_network_error], 22', '    mov rax, -1', '    ret',
            '.Lnetwork_send_some_error:', '    mov r10, rax', '    neg r10', '    mov QWORD PTR [rip+valen_network_error], r10', '    mov rax, -1', '    ret', '',
            ...close('valen_Network_closeListener'), ...close('valen_Network_closeConnection'),
            ...this.descriptorRuntime('valen_Network_listenerDescriptor', 16),
            ...this.descriptorRuntime('valen_Network_connectionDescriptor', 16),
            ...this.nonblockingRuntime('valen_Network_makeListenerNonblocking', 16),
            ...this.nonblockingRuntime('valen_Network_makeConnectionNonblocking', 16),
            '.globl valen_Network_lastError', 'valen_Network_lastError:', '    mov rax, QWORD PTR [rip+valen_network_error]', '    ret', '',
            '.Lnetwork_error:', '    neg rax', '    mov QWORD PTR [rip+valen_network_error], rax', '    xor eax, eax', '    ret', ''
        ];
    }

    descriptorRuntime(name, offset = 0) {
        return ['.globl '+name, name+':', `    mov rax, QWORD PTR [rdi+${offset}]`, '    ret', ''];
    }

    nonblockingRuntime(name, offset = 0) {
        const error = `.L${name}_error`, done = `.L${name}_done`;
        return ['.globl '+name, name+':', '    push rbx', `    mov rbx, QWORD PTR [rdi+${offset}]`,
            '    mov eax, 72', '    mov rdi, rbx', '    mov esi, 3', '    syscall', '    test rax, rax', `    js ${error}`,
            '    or eax, 2048', '    mov edx, eax', '    mov eax, 72', '    mov rdi, rbx', '    mov esi, 4', '    syscall',
            '    test rax, rax', `    js ${error}`, '    mov eax, 1', `    jmp ${done}`, `${error}:`, '    xor eax, eax', `${done}:`, '    pop rbx', '    ret', ''];
    }

    eventLoopRuntime(symbols) {
        const lines = [];
        if (symbols.has('valen_EventLoop_available')) lines.push('.globl valen_EventLoop_available', 'valen_EventLoop_available:', '    mov eax, 1', '    ret', '');
        if (symbols.has('valen_EventLoop_wait')) lines.push(
            '.globl valen_EventLoop_wait', 'valen_EventLoop_wait:',
            '    push rbx', '    push r12', '    push r13', '    push r14', '    push r15',
            '    mov r12, QWORD PTR [rdi]', '    cmp r12, QWORD PTR [rsi]', '    jne .Lio_wait_early',
            '    test r12, r12', '    je .Lio_wait_early', '    mov r13, QWORD PTR [rdi+16]',
            '    mov r14, QWORD PTR [rsi+16]', '    mov r15, rdx', '    lea rdi, [r12*8]', '    call valen_alloc',
            '    mov rbx, rax', '    xor ecx, ecx', '.Lio_wait_fill:', '    cmp rcx, r12', '    jae .Lio_wait_poll',
            '    mov rax, QWORD PTR [r13+rcx*8]', '    mov DWORD PTR [rbx+rcx*8], eax',
            '    mov rax, QWORD PTR [r14+rcx*8]', '    mov WORD PTR [rbx+rcx*8+4], ax',
            '    mov WORD PTR [rbx+rcx*8+6], 0', '    inc rcx', '    jmp .Lio_wait_fill',
            '.Lio_wait_poll:', '    mov eax, 7', '    mov rdi, rbx', '    mov rsi, r12', '    mov rdx, r15', '    syscall',
            '    test rax, rax', '    jle .Lio_wait_none', '    xor ecx, ecx',
            '.Lio_wait_scan:', '    cmp rcx, r12', '    jae .Lio_wait_none', '    cmp WORD PTR [rbx+rcx*8+6], 0',
            '    jne .Lio_wait_ready', '    inc rcx', '    jmp .Lio_wait_scan',
            '.Lio_wait_ready:', '    mov rax, rcx', '    jmp .Lio_wait_cleanup',
            '.Lio_wait_none:', '    mov rax, -1', '.Lio_wait_cleanup:', '    mov r13, rax',
            '    mov rdi, rbx', '    lea rsi, [r12*8]', '    mov eax, 11', '    syscall', '    mov rax, r13',
            '    jmp .Lio_wait_done', '.Lio_wait_early:', '    mov rax, -1', '.Lio_wait_done:',
            '    pop r15', '    pop r14', '    pop r13', '    pop r12', '    pop rbx', '    ret', ''
        );
        if (symbols.has('valen_EventLoop_monotonicMilliseconds')) lines.push(
            '.globl valen_EventLoop_monotonicMilliseconds', 'valen_EventLoop_monotonicMilliseconds:',
            '    sub rsp, 24', '    mov eax, 228', '    mov edi, 1', '    mov rsi, rsp', '    syscall',
            '    test rax, rax', '    js .Lmonotonic_error', '    mov r8, QWORD PTR [rsp]', '    imul r8, r8, 1000',
            '    mov rax, QWORD PTR [rsp+8]', '    cqo', '    mov rcx, 1000000', '    idiv rcx', '    add rax, r8',
            '    add rsp, 24', '    ret', '.Lmonotonic_error:', '    mov rax, -1', '    add rsp, 24', '    ret', ''
        );
        return lines;
    }

    operationsRuntime(symbols) {
        const offset = suffix => {
            for (const [name, field] of this.fieldOffsets) if (name.endsWith(`::Operations.${suffix}`)) return field.offset;
            throw new Error(`Operations runtime requires field ${suffix}`);
        };
        const mutex = offset('Mutex.state'), condition = offset('Condition.sequence'), atomic = offset('Atomic.value');
        const handle = offset('ThreadOperation.handle');
        const worker = this.program.functions.find(fn => fn.displayName === 'Operations.ThreadOperation.runWorker');
        const lines = [];
        const has = name => symbols.has(`valen_Operations_${name}`);
        if (has('threadAvailable')) lines.push('.globl valen_Operations_threadAvailable', 'valen_Operations_threadAvailable:', '    mov eax, 1', '    ret', '');
        if (has('threadStart')) lines.push(
            '.globl valen_Operations_threadStart', 'valen_Operations_threadStart:', '    push rbx', '    mov rbx, rdi',
            `    lea rdi, [rbx+${handle}]`, '    xor esi, esi', '    lea rdx, [rip+valen_thread_worker]', '    mov rcx, rbx',
            '    call pthread_create', '    test eax, eax', '    sete al', '    movzx eax, al', '    pop rbx', '    ret', '',
            'valen_thread_worker:', '    push rbx', '    mov rbx, rdi', '    mov rdi, rbx',
            `    call ${this.functionSymbols.get(worker?.name)}`, '    xor eax, eax', '    pop rbx', '    ret', '');
        if (has('threadJoin')) lines.push('.globl valen_Operations_threadJoin', 'valen_Operations_threadJoin:', '    push rax',
            `    mov rdi, QWORD PTR [rdi+${handle}]`, '    xor esi, esi', '    call pthread_join', '    pop rcx', '    ret', '');
        if (has('mutexLock')) lines.push('.globl valen_Operations_mutexLock', 'valen_Operations_mutexLock:', '    push r12',
            `    lea r12, [rdi+${mutex}]`, '.Lvalen_mutex_retry:', '    xor eax, eax', '    mov ecx, 1',
            '    lock cmpxchg DWORD PTR [r12], ecx', '    je .Lvalen_mutex_locked', '    mov eax, 202', '    mov rdi, r12',
            '    xor esi, esi', '    mov edx, 1', '    xor r10d, r10d', '    xor r8d, r8d', '    xor r9d, r9d', '    syscall',
            '    jmp .Lvalen_mutex_retry', '.Lvalen_mutex_locked:', '    pop r12', '    ret', '');
        if (has('mutexUnlock')) lines.push('.globl valen_Operations_mutexUnlock', 'valen_Operations_mutexUnlock:',
            `    lea rdi, [rdi+${mutex}]`, '    mov DWORD PTR [rdi], 0', '    mov eax, 202', '    mov esi, 1', '    mov edx, 1',
            '    xor r10d, r10d', '    xor r8d, r8d', '    xor r9d, r9d', '    syscall', '    ret', '');
        if (has('conditionWait')) lines.push('.globl valen_Operations_conditionWait', 'valen_Operations_conditionWait:',
            '    push r12', '    push r13', '    push r14', '    mov r12, rdi', '    mov r13, rsi', `    mov r14d, DWORD PTR [r12+${condition}]`,
            '    mov rdi, r13', '    call valen_Operations_mutexUnlock', '    mov eax, 202', `    lea rdi, [r12+${condition}]`,
            '    xor esi, esi', '    mov edx, r14d', '    xor r10d, r10d', '    xor r8d, r8d', '    xor r9d, r9d', '    syscall',
            '    mov rdi, r13', '    call valen_Operations_mutexLock', '    pop r14', '    pop r13', '    pop r12', '    ret', '');
        const notify = (name, count) => lines.push(`.globl valen_Operations_${name}`, `valen_Operations_${name}:`,
            `    lea rdi, [rdi+${condition}]`, '    lock add DWORD PTR [rdi], 1', '    mov eax, 202', '    mov esi, 1', `    mov edx, ${count}`,
            '    xor r10d, r10d', '    xor r8d, r8d', '    xor r9d, r9d', '    syscall', '    ret', '');
        if (has('conditionNotifyOne')) notify('conditionNotifyOne', 1);
        if (has('conditionNotifyAll')) notify('conditionNotifyAll', 2147483647);
        if (has('atomicLoad')) lines.push('.globl valen_Operations_atomicLoad', 'valen_Operations_atomicLoad:', `    mov rax, QWORD PTR [rdi+${atomic}]`, '    ret', '');
        if (has('atomicStore')) lines.push('.globl valen_Operations_atomicStore', 'valen_Operations_atomicStore:', `    xchg QWORD PTR [rdi+${atomic}], rsi`, '    ret', '');
        if (has('atomicExchange')) lines.push('.globl valen_Operations_atomicExchange', 'valen_Operations_atomicExchange:', '    mov rax, rsi', `    xchg QWORD PTR [rdi+${atomic}], rax`, '    ret', '');
        if (has('atomicCompareExchange')) lines.push('.globl valen_Operations_atomicCompareExchange', 'valen_Operations_atomicCompareExchange:', '    mov rax, rsi', `    lock cmpxchg QWORD PTR [rdi+${atomic}], rdx`, '    sete al', '    movzx eax, al', '    ret', '');
        if (has('atomicAdd')) lines.push('.globl valen_Operations_atomicAdd', 'valen_Operations_atomicAdd:', '    mov rax, rsi', `    lock xadd QWORD PTR [rdi+${atomic}], rax`, '    add rax, rsi', '    ret', '');
        return lines;
    }

    generateFunction(fn) {
        this.fn = fn;
        this.slots = new Map();
        this.immediates = this.optimize ? this.selectImmediateConstants(fn) : new Map();
        this.registers = this.optimize ? this.allocateRegisters(fn) : new Map();
        const slotTypes = new Map();
        let slotCount = 0;
        const reserve = (key, type = null) => {
            if (!this.slots.has(key)) this.slots.set(key, ++slotCount * 8);
            if (type) slotTypes.set(key, type);
        };

        for (const parameter of fn.parameters) reserve(`name:${parameter.name}`, parameter.type);
        for (const instruction of fn.blocks.flatMap(block => block.instructions)) {
            if (instruction.result && !this.registers.has(instruction.result) && !this.immediates.has(instruction.result)) reserve(`temp:${instruction.result}`, instruction.type);
            if (instruction.op === 'declare_local' || instruction.op === 'store_local') {
                reserve(`name:${instruction.name}`, instruction.type ?? instruction.value?.type);
            }
        }
        for (const register of new Set(this.registers.values())) reserve(`save:${register}`);

        const roots = [...slotTypes].filter(([, type]) => this.isManagedReferenceType(type));
        const rootRecordSize = 24;
        const frameSize = Math.ceil((slotCount * 8 + rootRecordSize) / 16) * 16;
        const rootRecordOffset = slotCount * 8 + rootRecordSize;
        const symbol = this.functionSymbols.get(fn.name);
        const endLabel = `${symbol}__return`;
        const lines = [
            `.globl ${symbol}`,
            `${symbol}:`,
            '    push rbp',
            '    mov rbp, rsp'
        ];
        if (frameSize) lines.push(`    sub rsp, ${frameSize}`);
        for (let offset = 8; offset <= frameSize; offset += 8) {
            lines.push(`    mov QWORD PTR [rbp-${offset}], 0`);
        }
        for (const register of new Set(this.registers.values())) lines.push(`    mov ${this.slot(`save:${register}`)}, ${register}`);
        const rootTraceLabel = `${symbol}__gc_roots`;
        lines.push('    mov rax, QWORD PTR [rip+valen_gc_roots]', `    mov QWORD PTR [rbp-${rootRecordOffset}], rax`,
            `    lea rax, [rip+${rootTraceLabel}]`, `    mov QWORD PTR [rbp-${rootRecordOffset - 8}], rax`,
            `    mov QWORD PTR [rbp-${rootRecordOffset - 16}], rbp`);
        lines.push(`    lea rax, [rbp-${rootRecordOffset}]`, '    mov QWORD PTR [rip+valen_gc_roots], rax');

        for (const location of this.argumentLocations(fn.parameters)) {
            const slot = this.slot(`name:${location.value.name}`);
            if (location.kind === 'gp') lines.push(`    mov ${slot}, ${location.register}`);
            else if (location.kind === 'xmm') lines.push(location.value.type === 'f32' ? `    movd eax, ${location.register}` : `    movq rax, ${location.register}`, `    mov ${slot}, rax`);
            else lines.push(`    mov rax, QWORD PTR [rbp+${16 + location.stackIndex * 8}]`, `    mov ${slot}, rax`);
        }

        for (const block of fn.blocks) {
            if (block.label !== 'entry') lines.push(`${this.blockLabel(block.label)}:`);
            for (const instruction of block.instructions) {
                lines.push(...this.generateInstruction(instruction, endLabel));
            }
        }

        lines.push(`${endLabel}:`, `    mov rcx, QWORD PTR [rbp-${rootRecordOffset}]`, '    mov QWORD PTR [rip+valen_gc_roots], rcx');
        for (const register of new Set(this.registers.values())) lines.push(`    mov ${register}, ${this.slot(`save:${register}`)}`);
        lines.push('    leave', '    ret',
            `${rootTraceLabel}:`, '    push rbx', '    mov rbx, rdi');
        for (const [key] of roots) lines.push(`    mov rdi, QWORD PTR [rbx-${this.slots.get(key)}]`, '    call valen_gc_mark');
        lines.push('    pop rbx', '    ret', '');
        return this.optimize ? this.peephole(lines) : lines;
    }

    selectImmediateConstants(fn) {
        const constants = new Map();
        const uses = new Map();
        const supported = new Set(['+', '-', '*', '&', '|', '^', '<<', '>>', '==', '!=', '===', '!==', '<', '<=', '>', '>=']);
        for (const instruction of fn.blocks.flatMap(block => block.instructions)) {
            if (instruction.op === 'constant' && instruction.result && !this.isFloat(instruction.type)) {
                const value = BigInt(instruction.value);
                if (value >= -2147483648n && value <= 2147483647n) constants.set(instruction.result, instruction.value.toString());
            }
            const record = (value, eligible) => {
                if (value?.kind !== 'temporary') return;
                const status = uses.get(value.name) ?? {count: 0, eligible: true};
                status.count++;
                status.eligible = status.eligible && eligible;
                uses.set(value.name, status);
            };
            record(instruction.right, instruction.op === 'binary' && supported.has(instruction.operator));
            const visit = value => {
                if (!value || typeof value !== 'object') return;
                if (value.kind === 'temporary') { record(value, false); return; }
                if (Array.isArray(value)) for (const item of value) visit(item);
                else for (const item of Object.values(value)) visit(item);
            };
            for (const [key, value] of Object.entries(instruction)) if (!['result', 'right'].includes(key)) visit(value);
        }
        return new Map([...constants].filter(([name]) => uses.get(name)?.eligible));
    }

    peephole(lines) {
        return lines.filter(line => {
            const sameMove = line.match(/^    mov (r(?:ax|bx|cx|dx|si|di|bp|sp|8|9|1[0-5])), \1$/);
            if (sameMove) return false;
            if (/^    (?:add|sub|shl|shr|sar) r(?:ax|cx|dx|8|9|1[0-5]), 0$/.test(line)) return false;
            if (/^    imul r(?:ax|cx|dx|8|9|1[0-5]), 1$/.test(line)) return false;
            return true;
        });
    }

    allocateRegisters(fn) {
        const instructions = fn.blocks.flatMap(block => block.instructions);
        const definitions = new Map();
        const lastUses = new Map();
        for (let index = 0; index < instructions.length; index++) {
            const instruction = instructions[index];
            if (instruction.result && !this.immediates.has(instruction.result) && !this.isManagedReferenceType(instruction.type)) {
                definitions.set(instruction.result, {name: instruction.result, type: instruction.type, start: index, end: index});
            }
            const visit = value => {
                if (!value || typeof value !== 'object') return;
                if (value.kind === 'temporary') {
                    lastUses.set(value.name, index);
                    return;
                }
                if (Array.isArray(value)) for (const item of value) visit(item);
                else for (const [key, item] of Object.entries(value)) if (key !== 'result') visit(item);
            };
            for (const [key, value] of Object.entries(instruction)) if (key !== 'result') visit(value);
        }
        const intervals = [...definitions.values()]
            .filter(interval => lastUses.has(interval.name))
            .map(interval => ({...interval, end: lastUses.get(interval.name)}))
            .sort((left, right) => left.start - right.start || left.end - right.end);
        const available = ['r12', 'r13', 'r14', 'r15'];
        const active = [];
        const allocation = new Map();
        for (const interval of intervals) {
            for (let index = active.length - 1; index >= 0; index--) {
                if (active[index].end <= interval.start) {
                    available.push(active[index].register);
                    active.splice(index, 1);
                }
            }
            if (available.length === 0) continue;
            const register = available.pop();
            allocation.set(interval.name, register);
            active.push({...interval, register});
            active.sort((left, right) => left.end - right.end);
        }
        return allocation;
    }

    isManagedReferenceType(type) {
        if (!type) return false;
        if (this.isPrimitiveOptional(type)) return true;
        const base = type.endsWith('?') ? type.slice(0, -1) : type;
        return base === 'string' || base === 'StringBuilder' || base.startsWith('Array<') || this.typeSizes.has(base);
    }

    isPrimitiveOptional(type) {
        return type?.endsWith('?') && ['bool', 'u8', 'i8', 'u16', 'i16', 'u32', 'i32', 'u64', 'i64', 'f32', 'f64'].includes(type.slice(0, -1));
    }

    generateInstruction(instruction, endLabel) {
        const lines = [];
        switch (instruction.op) {
            case 'constant':
                if (this.immediates.has(instruction.result)) break;
                lines.push(`    mov rax, ${instruction.value}`, ...this.normalize('rax', instruction.type));
                lines.push(`    mov ${this.temp(instruction.result)}, rax`);
                break;
            case 'float_constant': {
                const literal = this.internFloat(instruction.value, instruction.type);
                if (instruction.type === 'f32') lines.push(`    movss xmm0, DWORD PTR [rip+${literal.label}]`, '    movd eax, xmm0');
                else lines.push(`    movsd xmm0, QWORD PTR [rip+${literal.label}]`, '    movq rax, xmm0');
                lines.push(`    mov ${this.temp(instruction.result)}, rax`);
                break;
            }
            case 'string_constant':
                lines.push(`    lea rax, [rip+${this.stringLiterals.get(instruction.value).descriptor}]`);
                lines.push(`    mov ${this.temp(instruction.result)}, rax`);
                break;
            case 'declare_local':
                if (instruction.value) {
                    lines.push(...this.load(instruction.value, 'rax'));
                    lines.push(`    mov ${this.named(instruction.name)}, rax`);
                } else lines.push(`    mov ${this.named(instruction.name)}, 0`);
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
                if (field.ownership === 'member-weak') {
                    const live = `.Lweak_live_${this.runtimeLabel++}`;
                    const done = `.Lweak_done_${this.runtimeLabel++}`;
                    lines.push('    test rax, rax', `    jz ${done}`, '    cmp QWORD PTR [rax+8], 0', `    jne ${live}`,
                        '    xor eax, eax', `    jmp ${done}`, `${live}:`, `${done}:`);
                }
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
                if (instruction.operator === '-' && this.isFloat(instruction.type)) {
                    lines.push(`    ${instruction.type === 'f32' ? 'xor eax, 0x80000000' : 'mov rcx, 0x8000000000000000'}`);
                    if (instruction.type === 'f64') lines.push('    xor rax, rcx');
                } else if (instruction.operator === '-') lines.push('    neg rax');
                else if (instruction.operator === '!') lines.push('    test rax, rax', '    sete al', '    movzx rax, al');
                else throw new Error(`Unsupported unary operator ${instruction.operator}`);
                lines.push(...this.normalize('rax', instruction.type));
                lines.push(`    mov ${this.temp(instruction.result)}, rax`);
                break;
            case 'binary':
                lines.push(...this.binary(instruction));
                break;
            case 'allocate':
                lines.push(`    mov rdi, ${this.typeSizes.get(instruction.objectType) ?? 8}`,
                    `    lea rsi, [rip+${this.gcTraceLabel(instruction.objectType)}]`, `    lea rdx, [rip+${this.gcWeakLabel(instruction.objectType)}]`, '    xor ecx, ecx', '    call valen_gc_alloc');
                lines.push(`    lea rcx, [rip+${this.typeLabel(instruction.objectType)}]`, '    mov QWORD PTR [rax], rcx');
                lines.push('    mov QWORD PTR [rax+8], 1');
                lines.push(`    mov ${this.temp(instruction.result)}, rax`);
                break;
            case 'destroy_object':
                {
                    const done = `.Ldestroy_null_${this.runtimeLabel++}`;
                    lines.push(...this.load(instruction.value, 'rax'), '    test rax, rax', `    je ${done}`, '    mov QWORD PTR [rax+8], 0', `${done}:`);
                }
                break;
            case 'destroy_array':
                lines.push(...this.load(instruction.value, 'rdi'), `    call ${this.arrayDestroyLabel(instruction.arrayType)}`);
                break;
            case 'array_new':
                lines.push(`    mov rdi, ${this.sizeOf(instruction.elementType)}`);
                lines.push(...this.load(instruction.length, 'rsi'));
                lines.push(`    lea rdx, [rip+${this.gcArrayTraceLabel(instruction.type)}]`, `    lea rcx, [rip+${this.gcArrayWeakLabel(instruction.type)}]`,
                    '    call valen_gc_array_new', `    mov ${this.temp(instruction.result)}, rax`);
                break;
            case 'array_length':
                lines.push(...this.load(instruction.array, 'rax'));
                lines.push('    mov rax, QWORD PTR [rax]', `    mov ${this.temp(instruction.result)}, rax`);
                break;
            case 'array_load':
                lines.push(...this.load(instruction.array, 'rdi'));
                lines.push(...this.load(instruction.index, 'rsi'));
                lines.push(`    mov rdx, ${this.sizeOf(instruction.elementType)}`, '    call valen_array_address');
                lines.push(...this.loadMemory('[rax]', instruction.elementType, 'rax'));
                if (instruction.elementOwnership === 'weak') {
                    const live = `.Lweak_array_live_${this.runtimeLabel++}`;
                    const done = `.Lweak_array_done_${this.runtimeLabel++}`;
                    lines.push('    test rax, rax', `    je ${done}`, '    cmp QWORD PTR [rax+8], 0', `    jne ${live}`, '    xor eax, eax', `    jmp ${done}`, `${live}:`, `${done}:`);
                }
                lines.push(`    mov ${this.temp(instruction.result)}, rax`);
                break;
            case 'array_store':
                lines.push(...this.load(instruction.array, 'rdi'));
                lines.push(...this.load(instruction.index, 'rsi'));
                lines.push(`    mov rdx, ${this.sizeOf(instruction.elementType)}`, '    call valen_array_address');
                const storedBaseType = instruction.elementType?.endsWith('?') ? instruction.elementType.slice(0, -1) : instruction.elementType;
                if (instruction.elementOwnership === 'owned' && this.typeSizes.has(storedBaseType)) {
                    const empty = `.Larray_replace_empty_${this.runtimeLabel++}`;
                    lines.push('    mov rdx, QWORD PTR [rax]', '    test rdx, rdx', `    je ${empty}`, '    mov QWORD PTR [rdx+8], 0', `${empty}:`);
                }
                lines.push(...this.load(instruction.value, 'rcx'));
                lines.push(`    mov ${this.memorySize(instruction.elementType)} PTR [rax], ${this.registerForSize('rcx', instruction.elementType)}`);
                break;
            case 'array_append':
                lines.push(...this.load(instruction.array, 'rdi'));
                lines.push(...this.load(instruction.value, 'rsi'));
                lines.push(`    mov rdx, ${this.sizeOf(instruction.elementType)}`, '    call valen_array_append');
                break;
            case 'array_insert':
                lines.push(...this.load(instruction.array, 'rdi'));
                lines.push(...this.load(instruction.index, 'rsi'));
                lines.push(...this.load(instruction.value, 'rdx'));
                lines.push(`    mov rcx, ${this.sizeOf(instruction.elementType)}`, '    call valen_array_insert');
                break;
            case 'array_remove':
                lines.push(...this.load(instruction.array, 'rdi'));
                lines.push(...this.load(instruction.index, 'rsi'));
                lines.push(`    mov rdx, ${this.sizeOf(instruction.elementType)}`, '    call valen_array_remove', ...this.normalize('rax', instruction.type));
                lines.push(`    mov ${this.temp(instruction.result)}, rax`);
                break;
            case 'string_length':
                lines.push(...this.load(instruction.string, 'rax'));
                lines.push('    mov rax, QWORD PTR [rax+8]', `    mov ${this.temp(instruction.result)}, rax`);
                break;
            case 'string_load':
                lines.push(...this.load(instruction.array, 'rdi'));
                lines.push(...this.load(instruction.index, 'rsi'));
                lines.push('    call valen_string_address', '    movzx eax, BYTE PTR [rax]');
                lines.push(`    mov ${this.temp(instruction.result)}, rax`);
                break;
            case 'string_concat':
                lines.push(...this.load(instruction.left, 'rdi'), ...this.load(instruction.right, 'rsi'));
                lines.push('    call valen_string_concat', `    mov ${this.temp(instruction.result)}, rax`);
                break;
            case 'string_equal':
                lines.push(...this.load(instruction.left, 'rdi'), ...this.load(instruction.right, 'rsi'));
                lines.push('    call valen_string_equal');
                if (instruction.negate) lines.push('    xor eax, 1');
                lines.push(`    mov ${this.temp(instruction.result)}, rax`);
                break;
            case 'structural_equal':
                lines.push(...this.load(instruction.left, 'rdi'), ...this.load(instruction.right, 'rsi'), '    xor edx, edx');
                lines.push(`    call ${this.equalityFunction(instruction.valueType)}`);
                if (instruction.negate) lines.push('    xor eax, 1');
                lines.push(`    mov ${this.temp(instruction.result)}, rax`);
                break;
            case 'structural_hash':
                lines.push(...this.load(instruction.value, 'rdi'), '    xor esi, esi', `    call ${this.hashFunction(instruction.valueType)}`,
                    `    mov ${this.temp(instruction.result)}, rax`);
                break;
            case 'structural_copy':
                lines.push(...this.load(instruction.value, 'rdi'), '    xor esi, esi', `    call ${this.copyFunction(instruction.valueType)}`,
                    `    mov ${this.temp(instruction.result)}, rax`);
                break;
            case 'string_slice':
                lines.push(...this.load(instruction.string, 'rdi'));
                lines.push(...this.load(instruction.start, 'rsi'));
                lines.push(...this.load(instruction.length, 'rdx'));
                lines.push('    call valen_string_slice', `    mov ${this.temp(instruction.result)}, rax`);
                break;
            case 'string_to_bytes':
                lines.push(...this.load(instruction.value, 'rdi'), '    call valen_string_to_bytes', `    mov ${this.temp(instruction.result)}, rax`);
                break;
            case 'bytes_to_string':
                lines.push(...this.load(instruction.value, 'rdi'), '    call valen_bytes_to_string', `    mov ${this.temp(instruction.result)}, rax`);
                break;
            case 'integer_to_string':
                lines.push(...this.load(instruction.value, 'rdi'));
                lines.push(`    mov esi, ${this.isUnsigned(instruction.integerType) ? 0 : 1}`);
                lines.push('    call valen_integer_to_string', `    mov ${this.temp(instruction.result)}, rax`);
                break;
            case 'builder_new':
                lines.push('    mov edi, 1', '    xor esi, esi', '    call valen_array_new');
                lines.push(`    mov ${this.temp(instruction.result)}, rax`);
                break;
            case 'builder_length':
                lines.push(...this.load(instruction.builder, 'rax'));
                lines.push('    mov rax, QWORD PTR [rax]', `    mov ${this.temp(instruction.result)}, rax`);
                break;
            case 'builder_append_string':
                lines.push(...this.load(instruction.builder, 'rdi'), ...this.load(instruction.value, 'rsi'));
                lines.push('    call valen_builder_append_string');
                break;
            case 'builder_append_bytes':
                lines.push(...this.load(instruction.builder, 'rdi'), ...this.load(instruction.value, 'rsi'));
                lines.push('    call valen_builder_append_bytes');
                break;
            case 'builder_append_byte':
                lines.push(...this.load(instruction.builder, 'rdi'), ...this.load(instruction.value, 'rsi'));
                lines.push('    mov edx, 1', '    call valen_array_append');
                break;
            case 'builder_build':
                lines.push(...this.load(instruction.builder, 'rdi'));
                lines.push('    call valen_builder_build', `    mov ${this.temp(instruction.result)}, rax`);
                break;
            case 'call':
                lines.push(...this.call(instruction));
                break;
            case 'virtual_call':
                lines.push(...this.call(instruction, true));
                break;
            case 'contract_call':
                lines.push(...this.contractCall(instruction));
                break;
            case 'test_expect':
                lines.push(...this.load(instruction.condition, 'rax'), '    test rax, rax', '    jnz 1f',
                    '    inc QWORD PTR [rip+valen_test_failures]', '    mov eax, 1', '    mov edi, 2',
                    '    lea rsi, [rip+valen_test_failure_message]', '    mov edx, 12', '    syscall', '1:');
                break;
            case 'test_failures':
                lines.push('    mov rax, QWORD PTR [rip+valen_test_failures]', `    mov ${this.temp(instruction.result)}, rax`);
                break;
            case 'type_test':
            case 'checked_cast': {
                const id = this.runtimeLabel++;
                const loop = `.Ltype_test_${id}`;
                const match = `.Ltype_match_${id}`;
                const done = `.Ltype_done_${id}`;
                const scan = `.Ltype_contract_${id}`;
                const next = `.Ltype_next_${id}`;
                lines.push(...this.load(instruction.value, 'rcx'), '    xor eax, eax', '    test rcx, rcx', `    jz ${done}`,
                    '    mov rdx, QWORD PTR [rcx]', `    lea r8, [rip+${this.typeLabel(instruction.targetType)}]`, `${loop}:`,
                    '    test rdx, rdx', `    jz ${done}`, '    cmp rdx, r8', `    je ${match}`,
                    '    mov r9, QWORD PTR [rdx+8]', '    mov r10, QWORD PTR [r9]', '    add r9, 8', `${scan}:`,
                    '    test r10, r10', `    jz ${next}`, '    cmp QWORD PTR [r9], r8', `    je ${match}`, '    add r9, 16', '    dec r10', `    jmp ${scan}`,
                    `${next}:`, '    mov rdx, QWORD PTR [rdx]', `    jmp ${loop}`,
                    `${match}:`, instruction.op === 'type_test' ? '    mov eax, 1' : '    mov rax, rcx', `${done}:`,
                    `    mov ${this.temp(instruction.result)}, rax`);
                break;
            }
            case 'convert':
                lines.push(...this.load(instruction.value, 'rax'));
                lines.push(...this.convertNumber(instruction.value.type, instruction.type));
                lines.push(`    mov ${this.temp(instruction.result)}, rax`);
                break;
            case 'optional_box':
                lines.push('    mov edi, 24', '    xor esi, esi', '    xor edx, edx', '    xor ecx, ecx', '    call valen_gc_alloc',
                    '    mov QWORD PTR [rax], 0', '    mov QWORD PTR [rax+8], 1', '    push rax',
                    ...this.load(instruction.value, 'rcx'), '    pop rax', '    mov QWORD PTR [rax+16], rcx',
                    `    mov ${this.temp(instruction.result)}, rax`);
                break;
            case 'unwrap':
                lines.push(...this.load(instruction.value, 'rax'));
                lines.push('    test rax, rax', '    jz .Loptional_unwrap_error');
                if (instruction.optionalType && this.isPrimitiveOptional(instruction.optionalType)) lines.push('    mov rax, QWORD PTR [rax+16]', ...this.normalize('rax', instruction.type));
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
                if (instruction.value) {
                    lines.push(...this.load(instruction.value, 'rax'));
                    if (this.isFloat(instruction.value.type)) lines.push(instruction.value.type === 'f32' ? '    movd xmm0, eax' : '    movq xmm0, rax');
                }
                else lines.push('    xor eax, eax');
                lines.push(`    jmp ${endLabel}`);
                break;
            default:
                throw new Error(`Unsupported IR instruction ${instruction.op}`);
        }
        return lines;
    }

    binary(instruction) {
        if (this.isFloat(instruction.left.type)) return this.floatBinary(instruction);
        const immediate = instruction.right.kind === 'temporary' ? this.immediates.get(instruction.right.name) : undefined;
        const operand = immediate === undefined ? 'rcx' : immediate;
        const lines = [...this.load(instruction.left, 'rax')];
        if (immediate === undefined) lines.push(...this.load(instruction.right, 'rcx'));
        const simple = {'+': 'add rax, rcx', '-': 'sub rax, rcx', '*': 'imul rax, rcx', '&&': 'and rax, rcx', '||': 'or rax, rcx', '&': 'and rax, rcx', '|': 'or rax, rcx', '^': 'xor rax, rcx', '<<': 'shl rax, cl', '>>': this.isUnsigned(instruction.left.type) ? 'shr rax, cl' : 'sar rax, cl'};
        const condition = {'==': 'sete', '!=': 'setne', '===': 'sete', '!==': 'setne', '<': 'setl', '<=': 'setle', '>': 'setg', '>=': 'setge'};
        if (simple[instruction.operator]) {
            if (immediate !== undefined) {
                const mnemonic = simple[instruction.operator].split(' ')[0];
                const value = instruction.operator === '<<' || instruction.operator === '>>'
                    ? (BigInt(immediate) & 63n).toString()
                    : operand;
                lines.push(`    ${mnemonic} rax, ${value}`);
            } else lines.push(`    ${simple[instruction.operator]}`);
        }
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
            lines.push(`    cmp rax, ${operand}`, `    ${opcode} al`, '    movzx rax, al');
        } else throw new Error(`Unsupported binary operator ${instruction.operator}`);
        lines.push(...this.normalize('rax', instruction.type));
        lines.push(`    mov ${this.temp(instruction.result)}, rax`);
        return lines;
    }

    floatBinary(instruction) {
        const type = instruction.left.type;
        const suffix = type === 'f32' ? 'ss' : 'sd';
        const lines = [...this.load(instruction.left, 'rax'), ...this.load(instruction.right, 'rcx'),
            type === 'f32' ? '    movd xmm0, eax' : '    movq xmm0, rax',
            type === 'f32' ? '    movd xmm1, ecx' : '    movq xmm1, rcx'];
        const arithmetic = {'+': `add${suffix}`, '-': `sub${suffix}`, '*': `mul${suffix}`, '/': `div${suffix}`};
        if (arithmetic[instruction.operator]) {
            lines.push(`    ${arithmetic[instruction.operator]} xmm0, xmm1`, type === 'f32' ? '    movd eax, xmm0' : '    movq rax, xmm0');
        } else {
            lines.push(`    ucomi${suffix} xmm0, xmm1`);
            const ordered = {'==': 'sete', '<': 'setb', '<=': 'setbe'};
            const direct = {'>': 'seta', '>=': 'setae'};
            if (instruction.operator === '!=') lines.push('    setne al', '    setp dl', '    or al, dl');
            else if (ordered[instruction.operator]) lines.push(`    ${ordered[instruction.operator]} al`, '    setnp dl', '    and al, dl');
            else if (direct[instruction.operator]) lines.push(`    ${direct[instruction.operator]} al`);
            else throw new Error(`Unsupported floating operator ${instruction.operator}`);
            lines.push('    movzx rax, al');
        }
        lines.push(`    mov ${this.temp(instruction.result)}, rax`);
        return lines;
    }

    convertNumber(from, to) {
        if (from === to) return this.normalize('rax', to);
        if (this.isFloat(from) && this.isFloat(to)) {
            return from === 'f32'
                ? ['    movd xmm0, eax', '    cvtss2sd xmm0, xmm0', '    movq rax, xmm0']
                : ['    movq xmm0, rax', '    cvtsd2ss xmm0, xmm0', '    movd eax, xmm0'];
        }
        if (!this.isFloat(from) && this.isFloat(to)) {
            const suffix = to === 'f32' ? 'ss' : 'sd';
            if (from === 'u64') {
                const id = this.runtimeLabel++;
                return ['    test rax, rax', `    jns .Luint_float_${id}`, '    mov rcx, rax', '    and eax, 1', '    shr rcx, 1', '    or rcx, rax',
                    `    cvtsi2${suffix} xmm0, rcx`, `    add${suffix} xmm0, xmm0`, `    jmp .Luint_float_done_${id}`,
                    `.Luint_float_${id}:`, `    cvtsi2${suffix} xmm0, rax`, `.Luint_float_done_${id}:`, to === 'f32' ? '    movd eax, xmm0' : '    movq rax, xmm0'];
            }
            return [`    cvtsi2${suffix} xmm0, rax`, to === 'f32' ? '    movd eax, xmm0' : '    movq rax, xmm0'];
        }
        if (this.isFloat(from)) {
            const lines = [from === 'f32' ? '    movd xmm0, eax' : '    movq xmm0, rax'];
            if (from === 'f32') lines.push('    cvtss2sd xmm0, xmm0');
            lines.push('    ucomisd xmm0, xmm0', '    jp .Lfloat_conversion_error');
            const bits = Number(to.slice(1));
            if (to.startsWith('u')) {
                lines.push('    ucomisd xmm0, QWORD PTR [rip+.Lfloat_zero]', '    jb .Lfloat_conversion_error',
                    `    ucomisd xmm0, QWORD PTR [rip+.Lfloat_u${bits}_limit]`, '    jae .Lfloat_conversion_error');
                if (to === 'u64') lines.push('    ucomisd xmm0, QWORD PTR [rip+.Lfloat_i64_limit]', '    jb 1f',
                    '    subsd xmm0, QWORD PTR [rip+.Lfloat_i64_limit]', '    cvttsd2si rax, xmm0', '    mov rcx, 0x8000000000000000', '    add rax, rcx', '    jmp 2f',
                    '1:', '    cvttsd2si rax, xmm0', '2:');
                else lines.push('    cvttsd2si rax, xmm0', ...this.normalize('rax', to));
            } else lines.push(`    ucomisd xmm0, QWORD PTR [rip+.Lfloat_i${bits}_minimum]`, '    jb .Lfloat_conversion_error',
                `    ucomisd xmm0, QWORD PTR [rip+.Lfloat_i${bits}_limit]`, '    jae .Lfloat_conversion_error',
                '    cvttsd2si rax, xmm0', ...this.normalize('rax', to));
            return lines;
        }
        return this.normalize('rax', to);
    }

    call(instruction, dynamic = false) {
        const lines = [];
        const locations = this.argumentLocations(instruction.arguments);
        for (const location of locations.filter(item => item.kind !== 'stack')) lines.push(...this.loadArgument(location.value, location));
        const stackArguments = locations.filter(item => item.kind === 'stack').map(item => item.value);
        const padding = stackArguments.length % 2 === 1 ? 8 : 0;
        if (padding) lines.push('    sub rsp, 8');
        for (let index = stackArguments.length - 1; index >= 0; index--) {
            lines.push(...this.load(stackArguments[index], 'rax'), '    push rax');
        }
        if (dynamic) {
            lines.push('    mov rax, QWORD PTR [rdi]', `    call QWORD PTR [rax+${40 + instruction.slot * 8}]`);
        } else {
            const target = this.functionSymbols.get(instruction.target);
            if (!target) throw new Error(`No function symbol for ${instruction.target}`);
            lines.push(`    call ${target}`);
        }
        const stackBytes = stackArguments.length * 8 + padding;
        if (stackBytes) lines.push(`    add rsp, ${stackBytes}`);
        if (instruction.result) {
            if (this.isFloat(instruction.type)) lines.push(instruction.type === 'f32' ? '    movd eax, xmm0' : '    movq rax, xmm0');
            lines.push(...this.normalize('rax', instruction.type), `    mov ${this.temp(instruction.result)}, rax`);
        }
        return lines;
    }

    contractCall(instruction) {
        const lines = [];
        lines.push(...this.load(instruction.arguments[0], 'rdi'));
        const id = this.runtimeLabel++;
        const loop = `.Lcontract_call_${id}`;
        const found = `.Lcontract_found_${id}`;
        lines.push('    mov rax, QWORD PTR [rdi]', '    mov rdx, QWORD PTR [rax+8]', '    mov rcx, QWORD PTR [rdx]', '    add rdx, 8',
            `    lea r8, [rip+${this.typeLabel(instruction.contractType)}]`, `${loop}:`, '    test rcx, rcx', `    jz .Lcontract_dispatch_error`,
            '    cmp QWORD PTR [rdx], r8', `    je ${found}`, '    add rdx, 16', '    dec rcx', `    jmp ${loop}`, `${found}:`,
            '    mov rax, QWORD PTR [rdx+8]', `    mov r11, QWORD PTR [rax+${instruction.slot * 8}]`);
        const locations = this.argumentLocations(instruction.arguments);
        for (const location of locations.filter(item => item.kind !== 'stack')) lines.push(...this.loadArgument(location.value, location));
        const stackArguments = locations.filter(item => item.kind === 'stack').map(item => item.value);
        const padding = stackArguments.length % 2 === 1 ? 8 : 0;
        if (padding) lines.push('    sub rsp, 8');
        for (let index = stackArguments.length - 1; index >= 0; index--) {
            lines.push(...this.load(stackArguments[index], 'rax'), '    push rax');
        }
        lines.push('    call r11');
        const stackBytes = stackArguments.length * 8 + padding;
        if (stackBytes) lines.push(`    add rsp, ${stackBytes}`);
        if (instruction.result) {
            if (this.isFloat(instruction.type)) lines.push(instruction.type === 'f32' ? '    movd eax, xmm0' : '    movq rax, xmm0');
            lines.push(...this.normalize('rax', instruction.type), `    mov ${this.temp(instruction.result)}, rax`);
        }
        return lines;
    }

    argumentLocations(values) {
        let gp = 0;
        let xmm = 0;
        let stack = 0;
        return values.map(value => {
            if (this.isFloat(value.type) && xmm < 8) return {kind: 'xmm', register: `xmm${xmm++}`, value};
            if (!this.isFloat(value.type) && gp < argumentRegisters.length) return {kind: 'gp', register: argumentRegisters[gp++], value};
            return {kind: 'stack', stackIndex: stack++, value};
        });
    }

    loadArgument(value, location) {
        if (location.kind === 'gp') return this.load(value, location.register);
        return [...this.load(value, 'rax'), value.type === 'f32' ? `    movd ${location.register}, eax` : `    movq ${location.register}, rax`];
    }

    generateMain() {
        const entry = this.program.functions.find(fn => fn.name === this.program.entry);
        if (!entry) throw new Error('Program has no entry.__ method');
        const entryType = entry.owner;
        const entrySymbol = this.functionSymbols.get(entry.name);
        const initializer = this.program.types.find(type => type.name === entryType)?.initializer;
        return [
            '.globl _start',
            '_start:',
            '    xor ebp, ebp',
            '    mov rdi, QWORD PTR [rsp]',
            '    lea rsi, [rsp+8]',
            '    and rsp, -16',
            '    call main',
            '    mov edi, eax',
            '    mov eax, 60',
            '    syscall',
            '    ud2',
            '',
            '.globl main',
            'main:',
            '    push rbp',
            '    mov rbp, rsp',
            ...(this.needsProcessArguments ? [
                '    mov QWORD PTR [rip+valen_process_argc], rdi',
                '    mov QWORD PTR [rip+valen_process_argv], rsi',
                '    lea rax, [rsi+rdi*8+8]',
                '    mov QWORD PTR [rip+valen_process_envp], rax'
            ] : []),
            '    sub rsp, 32',
            '    mov QWORD PTR [rbp-8], 0',
            '    mov rax, QWORD PTR [rip+valen_gc_roots]',
            '    mov QWORD PTR [rbp-32], rax',
            '    lea rax, [rip+main__gc_roots]',
            '    mov QWORD PTR [rbp-24], rax',
            '    mov QWORD PTR [rbp-16], rbp',
            '    lea rax, [rbp-32]',
            '    mov QWORD PTR [rip+valen_gc_roots], rax',
            `    mov rdi, ${this.typeSizes.get(entryType) ?? 8}`,
            `    lea rsi, [rip+${this.gcTraceLabel(entryType)}]`,
            `    lea rdx, [rip+${this.gcWeakLabel(entryType)}]`,
            '    xor ecx, ecx',
            '    call valen_gc_alloc',
            `    lea rcx, [rip+${this.typeLabel(entryType)}]`,
            '    mov QWORD PTR [rax], rcx',
            '    mov QWORD PTR [rax+8], 1',
            '    mov QWORD PTR [rbp-8], rax',
            ...(initializer ? [
                '    mov rdi, rax',
                `    call ${this.functionSymbols.get(initializer)}`
            ] : []),
            '    mov rdi, QWORD PTR [rbp-8]',
            `    call ${entrySymbol}`,
            ...(entry.returnType === 'void' ? ['    xor eax, eax'] : []),
            '    mov rcx, QWORD PTR [rbp-32]',
            '    mov QWORD PTR [rip+valen_gc_roots], rcx',
            '    leave',
            '    ret',
            'main__gc_roots:',
            '    mov rdi, QWORD PTR [rdi-8]',
            '    jmp valen_gc_mark',
            ''
        ];
    }

    typeLabel(typeName) {
        return `.Lvalen_type_${this.mangle(typeName)}`;
    }

    objectEqualityLabel(typeName) { return `${this.typeLabel(typeName)}_equal`; }
    objectHashLabel(typeName) { return `${this.typeLabel(typeName)}_hash`; }
    objectCopyLabel(typeName) { return `${this.typeLabel(typeName)}_copy`; }
    arrayEqualityLabel(typeName) { return `.Lvalen_array_equal_${this.mangle(typeName)}`; }
    arrayHashLabel(typeName) { return `.Lvalen_array_hash_${this.mangle(typeName)}`; }
    arrayCopyLabel(typeName) { return `.Lvalen_array_copy_${this.mangle(typeName)}`; }
    arrayDestroyLabel(typeName) { return `.Lvalen_array_destroy_${this.mangle(typeName)}`; }

    equalityFunction(typeName) {
        const type = typeName?.endsWith('?') ? typeName.slice(0, -1) : typeName;
        if (type === 'string') return 'valen_string_equal_context';
        if (type?.startsWith('Array<')) return this.arrayEqualityLabel(type);
        return 'valen_object_equal';
    }

    hashFunction(typeName) {
        const type = typeName?.endsWith('?') ? typeName.slice(0, -1) : typeName;
        if (type === 'string') return 'valen_string_hash_context';
        if (type?.startsWith('Array<')) return this.arrayHashLabel(type);
        return 'valen_object_hash';
    }

    copyFunction(typeName) {
        const type = typeName?.endsWith('?') ? typeName.slice(0, -1) : typeName;
        if (type === 'string') return 'valen_string_copy_context';
        if (type?.startsWith('Array<')) return this.arrayCopyLabel(type);
        return 'valen_object_copy';
    }

    structuralRuntime() {
        const lines = [...this.structuralCoreRuntime()];
        for (const type of this.program.types) {
            lines.push(...this.objectEqualityFunction(type), ...this.objectHashFunction(type), ...this.objectCopyFunction(type));
        }
        for (const type of this.structuralArrayTypes()) {
            lines.push(...this.arrayEqualityFunction(type), ...this.arrayHashFunction(type), ...this.arrayCopyFunction(type));
        }
        return lines;
    }

    structuralArrayTypes() {
        const types = new Set();
        const add = type => {
            const base = type?.endsWith('?') ? type.slice(0, -1) : type;
            if (!base?.startsWith('Array<')) return;
            if (types.has(base)) return;
            types.add(base);
            add(base.slice(6, -1));
        };
        for (const type of this.program.types) for (const field of type.fields) add(field.type);
        for (const fn of this.program.functions) for (const block of fn.blocks) for (const instruction of block.instructions) {
            add(instruction.type);
            add(instruction.valueType);
            add(instruction.arrayType);
            add(instruction.objectType);
        }
        return types;
    }

    structuralCoreRuntime() {
        return [
            '.globl valen_object_equal', 'valen_object_equal:',
            '    cmp rdi, rsi', '    je .Lobject_equal_true', '    test rdi, rdi', '    jz .Lobject_equal_false',
            '    test rsi, rsi', '    jz .Lobject_equal_false', '    mov rax, QWORD PTR [rdi]',
            '    cmp rax, QWORD PTR [rsi]', '    jne .Lobject_equal_false', '    mov rcx, rdx',
            '.Lobject_equal_scan:', '    test rcx, rcx', '    jz .Lobject_equal_enter',
            '    cmp QWORD PTR [rcx], rdi', '    jne .Lobject_equal_next', '    cmp QWORD PTR [rcx+8], rsi',
            '    je .Lobject_equal_true', '.Lobject_equal_next:', '    mov rcx, QWORD PTR [rcx+16]', '    jmp .Lobject_equal_scan',
            '.Lobject_equal_enter:', '    push rbp', '    mov rbp, rsp', '    sub rsp, 32',
            '    mov QWORD PTR [rsp], rdi', '    mov QWORD PTR [rsp+8], rsi', '    mov QWORD PTR [rsp+16], rdx',
            '    mov rdx, rsp', '    call QWORD PTR [rax+16]', '    leave', '    ret',
            '.Lobject_equal_true:', '    mov eax, 1', '    ret', '.Lobject_equal_false:', '    xor eax, eax', '    ret', '',
            '.globl valen_object_hash', 'valen_object_hash:',
            '    test rdi, rdi', '    jz .Lobject_hash_null', '    mov rcx, rsi',
            '.Lobject_hash_scan:', '    test rcx, rcx', '    jz .Lobject_hash_enter', '    cmp QWORD PTR [rcx], rdi',
            '    je .Lobject_hash_cycle', '    mov rcx, QWORD PTR [rcx+8]', '    jmp .Lobject_hash_scan',
            '.Lobject_hash_enter:', '    push rbp', '    mov rbp, rsp', '    sub rsp, 16',
            '    mov QWORD PTR [rsp], rdi', '    mov QWORD PTR [rsp+8], rsi', '    mov rsi, rsp',
            '    mov rax, QWORD PTR [rdi]', '    call QWORD PTR [rax+24]', '    leave', '    ret',
            '.Lobject_hash_null:', '    xor eax, eax', '    ret', '.Lobject_hash_cycle:',
            '    mov rax, -7046029254386353131', '    ret', '',
            '.globl valen_object_copy', 'valen_object_copy:', '    test rdi, rdi', '    jz .Lobject_copy_null', '    test rsi, rsi',
            '    jnz .Lobject_copy_scan_start', '    push rdi', '    mov edi, 8', '    call valen_alloc', '    mov QWORD PTR [rax], 0',
            '    mov rsi, rax', '    pop rdi', '.Lobject_copy_scan_start:', '    mov rcx, QWORD PTR [rsi]',
            '.Lobject_copy_scan:', '    test rcx, rcx', '    jz .Lobject_copy_enter', '    cmp QWORD PTR [rcx], rdi',
            '    je .Lobject_copy_found', '    mov rcx, QWORD PTR [rcx+16]', '    jmp .Lobject_copy_scan',
            '.Lobject_copy_found:', '    mov rax, QWORD PTR [rcx+8]', '    ret', '.Lobject_copy_enter:',
            '    mov rax, QWORD PTR [rdi]', '    jmp QWORD PTR [rax+32]', '.Lobject_copy_null:', '    xor eax, eax', '    ret', '',
            'valen_string_equal_context:', '    cmp rdi, rsi', '    je .Lstring_context_true', '    test rdi, rdi',
            '    jz .Lstring_context_false', '    test rsi, rsi', '    jz .Lstring_context_false',
            '    jmp valen_string_equal', '.Lstring_context_true:', '    mov eax, 1', '    ret',
            '.Lstring_context_false:', '    xor eax, eax', '    ret', '',
            'valen_string_hash_context:', '    test rdi, rdi', '    jz .Lstring_hash_null',
            '    mov rsi, QWORD PTR [rdi]', '    mov rcx, QWORD PTR [rdi+8]', '    mov rax, 1469598103934665603',
            '.Lstring_hash_next:', '    test rcx, rcx', '    jz .Lstring_hash_done', '    movzx rdx, BYTE PTR [rsi]',
            '    xor rax, rdx', '    mov r8, 1099511628211', '    imul rax, r8', '    inc rsi', '    dec rcx',
            '    jmp .Lstring_hash_next', '.Lstring_hash_done:', '    ret', '.Lstring_hash_null:', '    xor eax, eax', '    ret', '',
            'valen_string_copy_context:', '    test rdi, rdi', '    jz .Lstring_copy_null', '    test rsi, rsi',
            '    jnz .Lstring_copy_scan_start', '    push rdi', '    mov edi, 8', '    call valen_alloc', '    mov QWORD PTR [rax], 0',
            '    mov rsi, rax', '    pop rdi', '.Lstring_copy_scan_start:', '    mov rcx, QWORD PTR [rsi]', '.Lstring_copy_scan:',
            '    test rcx, rcx', '    jz .Lstring_copy_enter', '    cmp QWORD PTR [rcx], rdi', '    je .Lstring_copy_found',
            '    mov rcx, QWORD PTR [rcx+16]', '    jmp .Lstring_copy_scan', '.Lstring_copy_found:', '    mov rax, QWORD PTR [rcx+8]',
            '    ret', '.Lstring_copy_enter:', '    push rbp', '    mov rbp, rsp', '    push rbx', '    push r12', '    push r13',
            '    push r14', '    mov r12, rdi', '    mov r14, rsi', '    mov r13, QWORD PTR [r12+8]', '    mov rdi, r13',
            '    call valen_string_new', '    mov rbx, rax', '    mov rdi, QWORD PTR [rbx]', '    mov rsi, QWORD PTR [r12]',
            '    mov rcx, r13', '    rep movsb', '    mov edi, 24', '    call valen_alloc', '    mov QWORD PTR [rax], r12',
            '    mov QWORD PTR [rax+8], rbx', '    mov rcx, QWORD PTR [r14]', '    mov QWORD PTR [rax+16], rcx',
            '    mov QWORD PTR [r14], rax', '    mov rax, rbx', '    pop r14', '    pop r13', '    pop r12', '    pop rbx',
            '    leave', '    ret', '.Lstring_copy_null:', '    xor eax, eax', '    ret', ''
        ];
    }

    objectEqualityFunction(type) {
        const fail = `${this.objectEqualityLabel(type.name)}_false`;
        const lines = [this.objectEqualityLabel(type.name) + ':', '    push rbp', '    mov rbp, rsp',
            '    push r12', '    push r13', '    push r14', '    push r15', '    mov r12, rdi', '    mov r13, rsi', '    mov r14, rdx'];
        for (const field of type.fields) lines.push(...this.compareAddresses(
            `r12+${this.fieldOffsets.get(field.symbol).offset}`, `r13+${this.fieldOffsets.get(field.symbol).offset}`, field.type, fail));
        lines.push('    mov eax, 1', `    jmp ${fail}_done`, `${fail}:`, '    xor eax, eax', `${fail}_done:`,
            '    pop r15', '    pop r14', '    pop r13', '    pop r12', '    leave', '    ret', '');
        return lines;
    }

    objectHashFunction(type) {
        const lines = [this.objectHashLabel(type.name) + ':', '    push rbp', '    mov rbp, rsp', '    push r12',
            '    push r13', '    push r14', '    push r15', '    mov r12, rdi', '    mov r14, rsi',
            `    mov r15, ${this.stableTypeHash(type.name)}`];
        for (const field of type.fields) {
            const offset = this.fieldOffsets.get(field.symbol).offset;
            lines.push(...this.hashAddress(`r12+${offset}`, field.type), '    xor r15, rax',
                '    mov rax, 1099511628211', '    imul r15, rax');
        }
        lines.push('    mov rax, r15', '    pop r15', '    pop r14', '    pop r13', '    pop r12', '    leave', '    ret', '');
        return lines;
    }

    objectCopyFunction(type) {
        const lines = [this.objectCopyLabel(type.name) + ':', '    push rbp', '    mov rbp, rsp', '    push r12', '    push r13',
            '    push r14', '    push r15', '    sub rsp, 16', '    mov r12, rdi', '    mov r14, rsi',
            `    mov edi, ${this.typeSizes.get(type.name) ?? 8}`, '    call valen_alloc', '    mov r13, rax',
            '    mov rax, QWORD PTR [r12]', '    mov QWORD PTR [r13], rax', '    mov QWORD PTR [r13+8], 1', '    mov edi, 24', '    call valen_alloc',
            '    mov QWORD PTR [rax], r12', '    mov QWORD PTR [rax+8], r13', '    mov rcx, QWORD PTR [r14]',
            '    mov QWORD PTR [rax+16], rcx', '    mov QWORD PTR [r14], rax'];
        for (const field of type.fields) {
            const offset = this.fieldOffsets.get(field.symbol).offset;
            lines.push(...this.copyAddress(`r12+${offset}`, field.type),
                `    mov ${this.memorySize(field.type)} PTR [r13+${offset}], ${this.registerForSize('rax', field.type)}`);
        }
        lines.push('    mov rax, r13', '    add rsp, 16', '    pop r15', '    pop r14', '    pop r13', '    pop r12', '    leave', '    ret', '');
        return lines;
    }

    compareAddresses(left, right, type, fail) {
        const base = type.endsWith('?') ? type.slice(0, -1) : type;
        if (base === 'string' || base.startsWith('Array<') || this.program.types.some(item => item.name === base)) {
            return [`    mov rdi, QWORD PTR [${left}]`, `    mov rsi, QWORD PTR [${right}]`, '    mov rdx, r14',
                `    call ${this.equalityFunction(base)}`, '    test eax, eax', `    jz ${fail}`];
        }
        const size = this.sizeOf(base);
        return [...this.loadMemory(`[${right}]`, base, 'rax'), '    mov rcx, rax',
            ...this.loadMemory(`[${left}]`, base, 'rax'), '    cmp rax, rcx', `    jne ${fail}`];
    }

    hashAddress(address, type) {
        const base = type.endsWith('?') ? type.slice(0, -1) : type;
        if (base === 'string' || base.startsWith('Array<') || this.program.types.some(item => item.name === base)) {
            return [`    mov rdi, QWORD PTR [${address}]`, '    mov rsi, r14', `    call ${this.hashFunction(base)}`];
        }
        return this.loadMemory(`[${address}]`, base, 'rax');
    }

    copyAddress(address, type) {
        const base = type.endsWith('?') ? type.slice(0, -1) : type;
        if (base === 'string' || base.startsWith('Array<') || this.program.types.some(item => item.name === base)) {
            return [`    mov rdi, QWORD PTR [${address}]`, '    mov rsi, r14', `    call ${this.copyFunction(base)}`];
        }
        return this.loadMemory(`[${address}]`, base, 'rax');
    }

    arrayEqualityFunction(type) {
        const element = type.slice(6, -1), label = this.arrayEqualityLabel(type), fail = `${label}_false`, loop = `${label}_loop`, done = `${label}_done`;
        const size = this.sizeOf(element);
        const lines = [label + ':', '    cmp rdi, rsi', `    je ${done}_true`, '    test rdi, rdi', `    jz ${fail}`,
            '    test rsi, rsi', `    jz ${fail}`, '    mov rax, QWORD PTR [rdi]', '    cmp rax, QWORD PTR [rsi]', `    jne ${fail}`,
            '    mov rcx, rdx', `${label}_scan:`, '    test rcx, rcx', `    jz ${label}_enter`,
            '    cmp QWORD PTR [rcx], rdi', `    jne ${label}_next`, '    cmp QWORD PTR [rcx+8], rsi', `    je ${done}_true`,
            `${label}_next:`, '    mov rcx, QWORD PTR [rcx+16]', `    jmp ${label}_scan`, `${label}_enter:`,
            '    push rbp', '    mov rbp, rsp', '    push r12', '    push r13', '    push r14', '    push r15', '    sub rsp, 32',
            '    mov r12, rdi', '    mov r13, rsi', '    mov r14, rdx', '    mov QWORD PTR [rsp], rdi',
            '    mov QWORD PTR [rsp+8], rsi', '    mov QWORD PTR [rsp+16], rdx', '    mov r14, rsp', '    xor r15d, r15d', `${loop}:`,
            '    cmp r15, QWORD PTR [r12]', `    jae ${done}`, `    imul rax, r15, ${size}`, '    add rax, QWORD PTR [r12+16]',
            `    imul rcx, r15, ${size}`, '    add rcx, QWORD PTR [r13+16]'];
        lines.push(...this.compareAddresses('rax', 'rcx', element, fail + '_frame'), '    inc r15', `    jmp ${loop}`, `${done}:`,
            '    mov eax, 1', `    jmp ${done}_frame`, `${fail}_frame:`, '    xor eax, eax', `${done}_frame:`, '    add rsp, 32',
            '    pop r15', '    pop r14', '    pop r13', '    pop r12', '    leave', '    ret', `${done}_true:`, '    mov eax, 1', '    ret',
            `${fail}:`, '    xor eax, eax', '    ret', '');
        return lines;
    }

    arrayHashFunction(type) {
        const element = type.slice(6, -1), label = this.arrayHashLabel(type), loop = `${label}_loop`, done = `${label}_done`;
        const size = this.sizeOf(element);
        const lines = [label + ':', '    test rdi, rdi', `    jz ${done}_null`, '    mov rcx, rsi', `${label}_scan:`,
            '    test rcx, rcx', `    jz ${label}_enter`, '    cmp QWORD PTR [rcx], rdi', `    je ${done}_cycle`,
            '    mov rcx, QWORD PTR [rcx+8]', `    jmp ${label}_scan`, `${label}_enter:`, '    push rbp', '    mov rbp, rsp',
            '    push r12', '    push r13', '    push r14', '    push r15', '    sub rsp, 16', '    mov r12, rdi', '    mov r14, rsi',
            '    mov QWORD PTR [rsp], rdi', '    mov QWORD PTR [rsp+8], rsi', '    mov r14, rsp', '    xor r13d, r13d',
            '    mov r15, 1469598103934665603', `${loop}:`, '    cmp r13, QWORD PTR [r12]', `    jae ${done}`,
            `    imul rax, r13, ${size}`, '    add rax, QWORD PTR [r12+16]'];
        lines.push(...this.hashAddress('rax', element), '    xor r15, rax', '    mov rax, 1099511628211', '    imul r15, rax',
            '    inc r13', `    jmp ${loop}`, `${done}:`, '    mov rax, r15', '    add rsp, 16', '    pop r15', '    pop r14',
            '    pop r13', '    pop r12', '    leave', '    ret', `${done}_null:`, '    xor eax, eax', '    ret',
            `${done}_cycle:`, '    mov rax, -7046029254386353131', '    ret', '');
        return lines;
    }

    arrayCopyFunction(type) {
        const element = type.slice(6, -1), label = this.arrayCopyLabel(type), loop = `${label}_loop`, done = `${label}_done`;
        const size = this.sizeOf(element);
        const lines = [label + ':', '    test rdi, rdi', `    jz ${done}_null`, '    test rsi, rsi', `    jnz ${label}_scan_start`,
            '    push rdi', '    mov edi, 8', '    call valen_alloc', '    mov QWORD PTR [rax], 0', '    mov rsi, rax', '    pop rdi',
            `${label}_scan_start:`, '    mov rcx, QWORD PTR [rsi]', `${label}_scan:`, '    test rcx, rcx', `    jz ${label}_enter`,
            '    cmp QWORD PTR [rcx], rdi', `    je ${label}_found`, '    mov rcx, QWORD PTR [rcx+16]', `    jmp ${label}_scan`,
            `${label}_found:`, '    mov rax, QWORD PTR [rcx+8]', '    ret', `${label}_enter:`, '    push rbp', '    mov rbp, rsp',
            '    push r12', '    push r13', '    push r14', '    push r15', '    sub rsp, 16', '    mov r12, rdi', '    mov r14, rsi',
            `    mov edi, ${size}`, '    mov rsi, QWORD PTR [r12]', '    call valen_array_new', '    mov r13, rax',
            '    mov edi, 24', '    call valen_alloc', '    mov QWORD PTR [rax], r12', '    mov QWORD PTR [rax+8], r13',
            '    mov rcx, QWORD PTR [r14]', '    mov QWORD PTR [rax+16], rcx', '    mov QWORD PTR [r14], rax', '    xor r15d, r15d',
            `${loop}:`, '    cmp r15, QWORD PTR [r12]', `    jae ${done}`, `    imul rax, r15, ${size}`,
            '    add rax, QWORD PTR [r12+16]'];
        lines.push(...this.copyAddress('rax', element), '    mov rdx, rax', `    imul rax, r15, ${size}`,
            '    add rax, QWORD PTR [r13+16]', `    mov ${this.memorySize(element)} PTR [rax], ${this.registerForSize('rdx', element)}`,
            '    inc r15', `    jmp ${loop}`, `${done}:`, '    mov rax, r13', '    add rsp, 16', '    pop r15', '    pop r14',
            '    pop r13', '    pop r12', '    leave', '    ret', `${done}_null:`, '    xor eax, eax', '    ret', '');
        return lines;
    }

    arrayDestroyFunction(type) {
        const element = type.slice(6, -1), label = this.arrayDestroyLabel(type), loop = `${label}_loop`, done = `${label}_done`;
        const size = this.sizeOf(element);
        const lines = [label + ':', '    test rdi, rdi', `    jz ${done}`, '    push r12', '    push r13', '    mov r12, rdi',
            '    xor r13d, r13d', `${loop}:`, '    cmp r13, QWORD PTR [r12]', `    jae ${done}_live`];
        if (element.startsWith('Array<')) {
            lines.push(`    imul rax, r13, ${size}`, '    add rax, QWORD PTR [r12+16]', '    mov rdi, QWORD PTR [rax]',
                `    call ${this.arrayDestroyLabel(element)}`);
        } else if (this.program.types.some(item => item.name === (element.endsWith('?') ? element.slice(0, -1) : element))) {
            lines.push(`    imul rax, r13, ${size}`, '    add rax, QWORD PTR [r12+16]', '    mov rax, QWORD PTR [rax]',
                '    test rax, rax', `    jz ${loop}_next`, '    mov QWORD PTR [rax+8], 0', `${loop}_next:`);
        }
        lines.push('    inc r13', `    jmp ${loop}`, `${done}_live:`, '    mov QWORD PTR [r12+32], 0', '    pop r13', '    pop r12', `${done}:`, '    ret', '');
        return lines;
    }

    stableTypeHash(name) {
        let hash = 1469598103934665603n;
        for (const byte of new TextEncoder().encode(name)) hash = BigInt.asIntN(64, (hash ^ BigInt(byte)) * 1099511628211n);
        return hash.toString();
    }

    typeData() {
        const lines = ['.section .data', '.align 8'];
        for (const type of this.program.types) {
            lines.push(`${this.typeLabel(type.name)}:`, type.base ? `    .quad ${this.typeLabel(type.base)}` : '    .quad 0',
                `    .quad ${this.contractListLabel(type.name)}`,
                `    .quad ${this.objectEqualityLabel(type.name)}`,
                `    .quad ${this.objectHashLabel(type.name)}`,
                `    .quad ${this.objectCopyLabel(type.name)}`);
            for (const method of type.virtualMethods ?? []) lines.push(`    .quad ${this.functionSymbols.get(method.target)}`);
        }
        for (const type of this.program.types) {
            lines.push(`${this.contractListLabel(type.name)}:`, `    .quad ${(type.contracts ?? []).length}`);
            for (const contract of type.contracts ?? []) {
                lines.push(`    .quad ${this.typeLabel(contract.name)}`, `    .quad ${this.contractTableLabel(type.name, contract.name)}`);
            }
            for (const contract of type.contracts ?? []) {
                lines.push(`${this.contractTableLabel(type.name, contract.name)}:`);
                for (const method of contract.methods) lines.push(`    .quad ${this.functionSymbols.get(method.target)}`);
            }
        }
        lines.push('.text');
        return lines;
    }

    contractListLabel(typeName) { return `${this.typeLabel(typeName)}_contracts`; }
    contractTableLabel(typeName, contractName) { return `${this.typeLabel(typeName)}_as_${this.mangle(contractName)}`; }

    printI64Runtime() {
        return [
            '.globl valen_System_print',
            'valen_System_print:',
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
            '.globl valen_string_to_bytes',
            'valen_string_to_bytes:',
            '    push rbp', '    mov rbp, rsp', '    push rbx', '    push r12', '    mov r12, rdi',
            '    mov edi, 1', '    mov rsi, QWORD PTR [r12+8]', '    call valen_array_new', '    mov rbx, rax',
            '    mov rdi, QWORD PTR [rbx+16]', '    mov rsi, QWORD PTR [r12]', '    mov rcx, QWORD PTR [r12+8]', '    rep movsb',
            '    mov rax, rbx', '    pop r12', '    pop rbx', '    leave', '    ret',
            '.globl valen_bytes_to_string',
            'valen_bytes_to_string:',
            '    push rbp', '    mov rbp, rsp', '    push rbx', '    push r12', '    mov r12, rdi',
            '    mov rdi, QWORD PTR [r12]', '    call valen_string_new', '    mov rbx, rax',
            '    mov rdi, QWORD PTR [rbx]', '    mov rsi, QWORD PTR [r12+16]', '    mov rcx, QWORD PTR [r12]', '    rep movsb',
            '    mov rax, rbx', '    pop r12', '    pop rbx', '    leave', '    ret',
            ''
        ];
    }

    byteConversionRuntime() {
        const lines = this.printI64Runtime();
        return lines.slice(lines.indexOf('.globl valen_string_to_bytes'));
    }

    argumentsRuntime() {
        return [
            '.globl valen_System_arguments',
            'valen_System_arguments:',
            '    push rbp',
            '    mov rbp, rsp',
            '    push rbx',
            '    push r12',
            '    push r13',
            '    push r14',
            '    push r15',
            '    sub rsp, 8',
            '    mov rbx, QWORD PTR [rip+valen_process_argc]',
            '    mov r12, QWORD PTR [rip+valen_process_argv]',
            '    mov edi, 8',
            '    mov rsi, rbx',
            '    call valen_array_new',
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
            '    mov rdi, QWORD PTR [r12+r14*8]',
            '    mov rsi, r15',
            '    call valen_string_borrow',
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
            '.globl valen_array_insert',
            'valen_array_insert:',
            '    test rsi, rsi', '    js .Larray_bounds_error', '    cmp rsi, QWORD PTR [rdi]', '    ja .Larray_bounds_error',
            '    push rbp', '    mov rbp, rsp', '    push rbx', '    push r12', '    push r13', '    push r14', '    push r15', '    sub rsp, 8',
            '    mov rbx, rdi', '    mov r12, rsi', '    mov r13, rdx', '    mov r14, rcx', '    mov r15, QWORD PTR [rbx]',
            '    cmp r15, QWORD PTR [rbx+8]', '    jb .Larray_insert_shift',
            '    mov rax, QWORD PTR [rbx+8]', '    shl rax, 1', '    mov QWORD PTR [rbx+8], rax', '    imul rax, r14', '    mov rdi, rax', '    call valen_alloc',
            '    mov rdi, rax', '    mov rsi, QWORD PTR [rbx+16]', '    mov rcx, r15', '    imul rcx, r14', '    rep movsb', '    mov QWORD PTR [rbx+16], rax',
            '.Larray_insert_shift:',
            '    mov rax, r15', '    sub rax, r12', '    imul rax, r14', '    mov rcx, rax',
            '    mov rsi, r12', '    imul rsi, r14', '    add rsi, QWORD PTR [rbx+16]', '    lea rdi, [rsi+r14]',
            '    test rcx, rcx', '    jz .Larray_insert_store', '    add rsi, rcx', '    add rdi, rcx',
            '.Larray_insert_move:', '    dec rsi', '    dec rdi', '    mov al, BYTE PTR [rsi]', '    mov BYTE PTR [rdi], al', '    dec rcx', '    jnz .Larray_insert_move',
            '.Larray_insert_store:',
            '    mov rax, r12', '    imul rax, r14', '    add rax, QWORD PTR [rbx+16]',
            '    cmp r14, 1', '    je .Larray_insert_store_1', '    cmp r14, 2', '    je .Larray_insert_store_2', '    cmp r14, 4', '    je .Larray_insert_store_4',
            '    mov QWORD PTR [rax], r13', '    jmp .Larray_insert_done',
            '.Larray_insert_store_1:', '    mov BYTE PTR [rax], r13b', '    jmp .Larray_insert_done',
            '.Larray_insert_store_2:', '    mov WORD PTR [rax], r13w', '    jmp .Larray_insert_done',
            '.Larray_insert_store_4:', '    mov DWORD PTR [rax], r13d',
            '.Larray_insert_done:', '    inc r15', '    mov QWORD PTR [rbx], r15',
            '    add rsp, 8', '    pop r15', '    pop r14', '    pop r13', '    pop r12', '    pop rbx', '    leave', '    ret',
            '.globl valen_array_remove',
            'valen_array_remove:',
            '    test rsi, rsi', '    js .Larray_bounds_error', '    cmp rsi, QWORD PTR [rdi]', '    jae .Larray_bounds_error',
            '    push rbx', '    push r12', '    push r13', '    mov rbx, rdi', '    mov r12, rsi', '    mov r13, rdx',
            '    mov rax, r12', '    imul rax, r13', '    add rax, QWORD PTR [rbx+16]',
            '    cmp r13, 1', '    je .Larray_remove_load_1', '    cmp r13, 2', '    je .Larray_remove_load_2', '    cmp r13, 4', '    je .Larray_remove_load_4',
            '    mov r12, QWORD PTR [rax]', '    jmp .Larray_remove_shift',
            '.Larray_remove_load_1:', '    movzx r12d, BYTE PTR [rax]', '    jmp .Larray_remove_shift',
            '.Larray_remove_load_2:', '    movzx r12d, WORD PTR [rax]', '    jmp .Larray_remove_shift',
            '.Larray_remove_load_4:', '    mov r12d, DWORD PTR [rax]',
            '.Larray_remove_shift:',
            '    mov rcx, QWORD PTR [rbx]', '    dec rcx', '    sub rcx, rsi', '    imul rcx, r13',
            '    mov rdi, rax', '    lea rsi, [rax+r13]', '    rep movsb',
            '    dec QWORD PTR [rbx]', '    mov rdi, QWORD PTR [rbx]', '    imul rdi, r13', '    add rdi, QWORD PTR [rbx+16]', '    mov rcx, r13',
            '.Larray_remove_clear:', '    mov BYTE PTR [rdi], 0', '    inc rdi', '    dec rcx', '    jnz .Larray_remove_clear',
            '    mov rax, r12', '    pop r13', '    pop r12', '    pop rbx', '    ret',
            ''
        ];
    }

    arrayMutationRuntime() {
        const lines = this.argumentsRuntime();
        return lines.slice(lines.indexOf('.globl valen_array_insert'));
    }

    environmentVariableRuntime() {
        return [
            '.globl valen_System_environmentVariable',
            'valen_System_environmentVariable:',
            '    push rbp', '    mov rbp, rsp', '    push r12', '    push r13',
            '    mov r8, QWORD PTR [rdi]', '    mov r9, QWORD PTR [rdi+8]',
            '    mov r10, QWORD PTR [rip+valen_process_envp]',
            '.Lenvironment_next:',
            '    mov rdx, QWORD PTR [r10]', '    test rdx, rdx', '    je .Lenvironment_missing',
            '    xor ecx, ecx',
            '.Lenvironment_compare:',
            '    cmp rcx, r9', '    je .Lenvironment_name_end',
            '    mov al, BYTE PTR [rdx+rcx]', '    cmp al, BYTE PTR [r8+rcx]', '    jne .Lenvironment_advance',
            '    inc rcx', '    jmp .Lenvironment_compare',
            '.Lenvironment_name_end:',
            '    cmp BYTE PTR [rdx+rcx], 61', '    jne .Lenvironment_advance',
            '    lea r12, [rdx+rcx+1]', '    xor r13d, r13d',
            '.Lenvironment_value_length:',
            '    cmp BYTE PTR [r12+r13], 0', '    je .Lenvironment_wrap', '    inc r13', '    jmp .Lenvironment_value_length',
            '.Lenvironment_wrap:',
            '    mov rdi, r12', '    mov rsi, r13', '    call valen_string_borrow',
            '    pop r13', '    pop r12', '    leave', '    ret',
            '.Lenvironment_advance:',
            '    add r10, 8', '    jmp .Lenvironment_next',
            '.Lenvironment_missing:',
            '    xor eax, eax', '    pop r13', '    pop r12', '    leave', '    ret', ''
        ];
    }

    exitRuntime() {
        return [
            '.globl valen_System_exit',
            'valen_System_exit:',
            '    mov eax, 60',
            '    syscall',
            '    ud2',
            ''
        ];
    }

    shutdownSignalRuntime() {
        return [
            '.globl valen_System_enableShutdownSignals', 'valen_System_enableShutdownSignals:',
            '    sub rsp, 32', '    lea rax, [rip+.Lshutdown_signal_handler]', '    mov QWORD PTR [rsp], rax',
            '    mov QWORD PTR [rsp+8], 67108864', '    lea rax, [rip+.Lshutdown_signal_return]', '    mov QWORD PTR [rsp+16], rax', '    mov QWORD PTR [rsp+24], 0',
            '    mov eax, 13', '    mov edi, 2', '    mov rsi, rsp', '    xor edx, edx', '    mov r10d, 8', '    syscall', '    test rax, rax', '    js .Lshutdown_signal_failed',
            '    mov eax, 13', '    mov edi, 15', '    mov rsi, rsp', '    xor edx, edx', '    mov r10d, 8', '    syscall', '    test rax, rax', '    js .Lshutdown_signal_failed',
            '    add rsp, 32', '    mov eax, 1', '    ret',
            '.Lshutdown_signal_failed:', '    add rsp, 32', '    xor eax, eax', '    ret',
            '.globl valen_System_shutdownRequested', 'valen_System_shutdownRequested:', '    mov rax, QWORD PTR [rip+valen_shutdown_requested]', '    ret',
            '.Lshutdown_signal_handler:', '    mov QWORD PTR [rip+valen_shutdown_requested], 1', '    ret',
            '.Lshutdown_signal_return:', '    mov eax, 15', '    syscall', ''
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
            '    call valen_alloc',
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
            '    mov QWORD PTR [rip+valen_filesystem_error], 0',
            '    mov r12, rax',
            '    mov edi, 8',
            '    call valen_alloc',
            '    mov QWORD PTR [rax], r12',
            `    jmp ${label}done`,
            `${label}error:`,
            '    neg rax',
            '    mov QWORD PTR [rip+valen_filesystem_error], rax',
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
            '.globl valen_System_read',
            'valen_System_read:',
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
            '    call valen_string_new',
            '    mov rbx, rax',
            '    xor eax, eax',
            '    mov rdi, r12',
            '    mov rsi, QWORD PTR [rbx]',
            '    mov rdx, r13',
            '    syscall',
            '    test rax, rax',
            '    js .Lfile_read_error_frame',
            '    mov QWORD PTR [rip+valen_filesystem_error], 0',
            '    mov QWORD PTR [rbx+8], rax',
            '    mov rax, rbx',
            '    jmp .Lfile_read_done',
            '.Lfile_read_error_frame:',
            '    neg rax',
            '    mov QWORD PTR [rip+valen_filesystem_error], rax',
            '    xor eax, eax',
            '.Lfile_read_done:',
            '    pop r14',
            '    pop r13',
            '    pop r12',
            '    pop rbx',
            '    leave',
            '    ret',
            '.Lfile_read_error:',
            '    mov QWORD PTR [rip+valen_filesystem_error], 22',
            '    xor eax, eax',
            '    ret',
            ''
        ];
    }

    fileWriteRuntime() {
        return [
            '.globl valen_System_writeFile',
            'valen_System_writeFile:',
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
            '    mov QWORD PTR [rip+valen_filesystem_error], 0',
            '    mov rax, r9',
            '    ret',
            '.Lfile_write_error:',
            '    mov r10, rax',
            '    neg r10',
            '    mov QWORD PTR [rip+valen_filesystem_error], r10',
            '    test r9, r9',
            '    cmovnz rax, r9',
            '    ret',
            ''
        ];
    }

    fileWriteBytesRuntime() {
        return [
            '.globl valen_System_writeBytes',
            'valen_System_writeBytes:',
            '    mov r8, QWORD PTR [rdi]',
            '    mov rdx, QWORD PTR [rsi]',
            '    mov rsi, QWORD PTR [rsi+16]',
            '    xor r9d, r9d',
            '.Lfile_write_bytes_next:',
            '    test rdx, rdx',
            '    je .Lfile_write_bytes_done',
            '    mov eax, 1',
            '    mov rdi, r8',
            '    syscall',
            '    test rax, rax',
            '    js .Lfile_write_error',
            '    add r9, rax',
            '    add rsi, rax',
            '    sub rdx, rax',
            '    jmp .Lfile_write_bytes_next',
            '.Lfile_write_bytes_done:',
            '    mov QWORD PTR [rip+valen_filesystem_error], 0',
            '    mov rax, r9',
            '    ret',
            ''
        ];
    }

    fileCloseRuntime() {
        return [
            '.globl valen_System_close',
            'valen_System_close:',
            '    mov rdi, QWORD PTR [rdi]',
            '    mov eax, 3',
            '    syscall',
            '    test rax, rax',
            '    js .Lfile_close_error',
            '    mov QWORD PTR [rip+valen_filesystem_error], 0',
            '    ret',
            '.Lfile_close_error:',
            '    mov r10, rax',
            '    neg r10',
            '    mov QWORD PTR [rip+valen_filesystem_error], r10',
            '    ret',
            ''
        ];
    }

    fileSyncRuntime() {
        return [
            '.globl valen_System_sync',
            'valen_System_sync:',
            '    mov rdi, QWORD PTR [rdi]',
            '    mov eax, 74',
            '    syscall',
            '    test rax, rax',
            '    js .Lfile_sync_error',
            '    mov QWORD PTR [rip+valen_filesystem_error], 0',
            '    ret',
            '.Lfile_sync_error:',
            '    mov r10, rax',
            '    neg r10',
            '    mov QWORD PTR [rip+valen_filesystem_error], r10',
            '    ret',
            ''
        ];
    }

    pathMutationRuntime(runtimeSymbols) {
        const lines = [
            '.Lvalen_path_cstring:',
            '    push rbx', '    push r12', '    push r13',
            '    mov r12, QWORD PTR [rdi]', '    mov r13, QWORD PTR [rdi+8]',
            '    lea rdi, [r13+1]', '    call valen_alloc', '    mov rbx, rax',
            '    mov rdi, rax', '    mov rsi, r12', '    mov rcx, r13', '    rep movsb',
            '    mov BYTE PTR [rbx+r13], 0', '    mov rax, rbx',
            '    pop r13', '    pop r12', '    pop rbx', '    ret', ''
        ];
        if (runtimeSymbols.has('valen_System_replaceFile')) lines.push(
            '.globl valen_System_replaceFile', 'valen_System_replaceFile:',
            '    push rbp', '    mov rbp, rsp', '    push r12', '    push r13',
            '    mov r13, rsi', '    call .Lvalen_path_cstring', '    mov r12, rax',
            '    mov rdi, r13', '    call .Lvalen_path_cstring', '    mov rsi, rax', '    mov rdi, r12',
            '    mov eax, 82', '    syscall', '    test rax, rax', '    js .Lreplace_file_error',
            '    mov QWORD PTR [rip+valen_filesystem_error], 0', '    jmp .Lreplace_file_done',
            '.Lreplace_file_error:', '    mov r10, rax', '    neg r10',
            '    mov QWORD PTR [rip+valen_filesystem_error], r10',
            '.Lreplace_file_done:', '    pop r13', '    pop r12', '    leave', '    ret', ''
        );
        if (runtimeSymbols.has('valen_System_removeFile')) lines.push(
            '.globl valen_System_removeFile', 'valen_System_removeFile:',
            '    sub rsp, 8', '    call .Lvalen_path_cstring', '    add rsp, 8',
            '    mov rdi, rax', '    mov eax, 87', '    syscall',
            '    test rax, rax', '    js .Lremove_file_error',
            '    mov QWORD PTR [rip+valen_filesystem_error], 0', '    ret',
            '.Lremove_file_error:', '    mov r10, rax', '    neg r10',
            '    mov QWORD PTR [rip+valen_filesystem_error], r10', '    ret', ''
        );
        if (runtimeSymbols.has('valen_System_makeExecutable')) lines.push(
            '.globl valen_System_makeExecutable', 'valen_System_makeExecutable:',
            '    sub rsp, 8', '    call .Lvalen_path_cstring', '    add rsp, 8',
            '    mov rdi, rax', '    mov esi, 493', '    mov eax, 90', '    syscall',
            '    test rax, rax', '    js .Lmake_executable_error',
            '    mov QWORD PTR [rip+valen_filesystem_error], 0', '    ret',
            '.Lmake_executable_error:', '    mov r10, rax', '    neg r10',
            '    mov QWORD PTR [rip+valen_filesystem_error], r10', '    ret', ''
        );
        return lines;
    }

    lastErrorRuntime() {
        return [
            '.globl valen_System_lastError',
            'valen_System_lastError:',
            '    mov rax, QWORD PTR [rip+valen_filesystem_error]',
            '    ret',
            ''
        ];
    }

    currentDirectoryRuntime() {
        return [
            '.globl valen_System_currentDirectory',
            'valen_System_currentDirectory:',
            '    push rbp',
            '    mov rbp, rsp',
            '    push rbx',
            '    push r12',
            '    mov edi, 4096',
            '    call valen_string_new',
            '    mov rbx, rax',
            '    mov rdi, QWORD PTR [rax]',
            '    mov esi, 4096',
            '    mov eax, 79',
            '    syscall',
            '    test rax, rax',
            '    js .Lcurrent_directory_error',
            '    xor r12d, r12d',
            '.Lcurrent_directory_length:',
            '    mov rax, QWORD PTR [rbx]',
            '    cmp BYTE PTR [rax+r12], 0',
            '    je .Lcurrent_directory_wrap',
            '    inc r12',
            '    jmp .Lcurrent_directory_length',
            '.Lcurrent_directory_wrap:',
            '    mov QWORD PTR [rip+valen_filesystem_error], 0',
            '    mov QWORD PTR [rbx+8], r12',
            '    mov rax, rbx',
            '    jmp .Lcurrent_directory_done',
            '.Lcurrent_directory_error:',
            '    neg rax',
            '    mov QWORD PTR [rip+valen_filesystem_error], rax',
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
            '.globl valen_System_memoryCopy',
            'valen_System_memoryCopy:',
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
            '.globl valen_System_memoryCompare',
            'valen_System_memoryCompare:',
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

    linkRuntime() {
        return [
            '.globl valen_System_link',
            'valen_System_link:',
            '    push rbp',
            '    mov rbp, rsp',
            '    push r12',
            '    push r13',
            '    push r14',
            '    push r15',
            '    sub rsp, 16',
            '    mov r12, QWORD PTR [rdi]',
            '    mov r13, QWORD PTR [rsi]',
            '    mov r14, rdx',
            '    mov eax, 57',
            '    syscall',
            '    test rax, rax',
            '    js .Llink_fork_error',
            '    jz .Llink_child',
            '    mov rdi, rax',
            '    lea rsi, [rbp-40]',
            '    xor edx, edx',
            '    xor r10d, r10d',
            '    mov eax, 61',
            '    syscall',
            '    test rax, rax',
            '    js .Llink_wait_error',
            '    mov eax, DWORD PTR [rbp-40]',
            '    mov edx, eax',
            '    and edx, 127',
            '    jnz .Llink_signaled',
            '    shr eax, 8',
            '    and eax, 255',
            '    jmp .Llink_done',
            '.Llink_signaled:',
            '    lea eax, [rdx+128]',
            '    jmp .Llink_done',
            '.Llink_fork_error:',
            '.Llink_wait_error:',
            '    mov eax, 127',
            '    jmp .Llink_done',
            '.Llink_child:',
            '    mov rcx, QWORD PTR [r14]',
            '    lea rax, [rcx+7]',
            '    shl rax, 3',
            '    add rax, 15',
            '    and rax, -16',
            '    sub rsp, rax',
            '    mov r15, rsp',
            '    lea rax, [rip+.Llink_cc]',
            '    mov QWORD PTR [r15], rax',
            '    lea rax, [rip+.Llink_no_stdlib]',
            '    mov QWORD PTR [r15+8], rax',
            '    lea rax, [rip+.Llink_no_pie]',
            '    mov QWORD PTR [r15+16], rax',
            '    mov QWORD PTR [r15+24], r12',
            '    lea rax, [rip+.Llink_output]',
            '    mov QWORD PTR [r15+32], rax',
            '    mov QWORD PTR [r15+40], r13',
            '    xor r8d, r8d',
            '.Llink_library_loop:',
            '    cmp r8, QWORD PTR [r14]',
            '    jae .Llink_library_done',
            '    mov rax, QWORD PTR [r14+16]',
            '    mov rax, QWORD PTR [rax+r8*8]',
            '    mov r10, QWORD PTR [rax+8]',
            '    lea rcx, [r10+3]',
            '    sub rsp, rcx',
            '    mov BYTE PTR [rsp], 45',
            '    mov BYTE PTR [rsp+1], 108',
            '    mov rsi, QWORD PTR [rax]',
            '    lea rdi, [rsp+2]',
            '    mov rcx, r10',
            '    rep movsb',
            '    mov BYTE PTR [rsp+r10+2], 0',
            '    mov QWORD PTR [r15+r8*8+48], rsp',
            '    inc r8',
            '    jmp .Llink_library_loop',
            '.Llink_library_done:',
            '    mov QWORD PTR [r15+r8*8+48], 0',
            '    lea rdi, [rip+.Llink_cc]',
            '    mov rsi, r15',
            '    mov rdx, QWORD PTR [rip+valen_process_envp]',
            '    mov eax, 59',
            '    syscall',
            '    mov edi, 127',
            '    mov eax, 60',
            '    syscall',
            '    ud2',
            '.Llink_done:',
            '    add rsp, 16',
            '    pop r15',
            '    pop r14',
            '    pop r13',
            '    pop r12',
            '    leave',
            '    ret',
            '.Llink_cc:',
            '    .asciz "/usr/bin/cc"',
            '.Llink_no_stdlib:',
            '    .asciz "-nostdlib"',
            '.Llink_no_pie:',
            '    .asciz "-no-pie"',
            '.Llink_output:',
            '    .asciz "-o"',
            ''
        ];
    }

    processData() {
        return [
            '.section .bss',
            '.align 8',
            'valen_process_argc:',
            '    .zero 8',
            'valen_process_argv:',
            '    .zero 8',
            'valen_process_envp:',
            '    .zero 8',
            ''
        ];
    }

    filesystemData() {
        return [
            '.section .bss',
            '.align 8',
            'valen_filesystem_error:',
            '    .zero 8',
            ''
        ];
    }

    runtimeErrorRuntime() {
        return [
            '.Ldivision_by_zero_error:',
            '    mov edi, 73',
            '    jmp .Lruntime_error',
            '.Lcontract_dispatch_error:',
            '    mov edi, 75',
            '    jmp .Lruntime_error',
            '.Lfloat_conversion_error:',
            '    mov edi, 76',
            '    jmp .Lruntime_error',
            '.Lruntime_error:',
            '    mov eax, 60',
            '    syscall',
            '    ud2',
            ''
        ];
    }

    allocationRuntime() {
        // Raw strings and buffers live for the process. Suballocate them from large
        // anonymous mappings so a tiny value does not consume an entire page.
        return [
            '.globl valen_alloc',
            'valen_alloc:',
            '    test rdi, rdi',
            '    jnz .Lalloc_size',
            '    mov edi, 1',
            '.Lalloc_size:',
            '    cmp DWORD PTR [rip+valen_arena_enabled], 0',
            '    je .Lalloc_direct',
            '    push r12',
            // Keep a zeroed sentinel after raw data. Native path/environment calls
            // consume string bytes as C strings at the runtime boundary.
            '    lea r12, [rdi+15]',
            '    and r12, -8',
            '.Lalloc_lock:',
            '    xor eax, eax',
            '    mov edx, 1',
            '    lock cmpxchg DWORD PTR [rip+valen_arena_lock], edx',
            '    je .Lalloc_locked',
            '    pause',
            '    jmp .Lalloc_lock',
            '.Lalloc_locked:',
            '    cmp QWORD PTR [rip+valen_arena_remaining], r12',
            '    jb .Lalloc_refill',
            '    mov rax, QWORD PTR [rip+valen_arena_cursor]',
            '    add QWORD PTR [rip+valen_arena_cursor], r12',
            '    sub QWORD PTR [rip+valen_arena_remaining], r12',
            '    mov DWORD PTR [rip+valen_arena_lock], 0',
            '    pop r12',
            '    ret',
            '.Lalloc_refill:',
            '    mov rsi, 1048576',
            '    cmp r12, rsi',
            '    cmova rsi, r12',
            '    xor edi, edi',
            '    mov edx, 3',
            '    mov r10d, 34',
            '    mov r8, -1',
            '    xor r9d, r9d',
            '    mov eax, 9',
            '    syscall',
            '    cmp rax, -4095',
            '    jae .Lallocation_error',
            '    lea rcx, [rax+r12]',
            '    mov QWORD PTR [rip+valen_arena_cursor], rcx',
            '    sub rsi, r12',
            '    mov QWORD PTR [rip+valen_arena_remaining], rsi',
            '    mov DWORD PTR [rip+valen_arena_lock], 0',
            '    pop r12',
            '    ret',
            '.Lalloc_direct:',
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

    garbageCollectorRuntime() {
        return [
            '.globl valen_gc_alloc', 'valen_gc_alloc:',
            '    push r12', '    push r13', '    push r14', '    push r15', '    mov r12, rdi', '    mov r13, rsi', '    mov r14, rdx', '    mov r15, rcx',
            '    sub rsp, 8', '    call valen_gc_maybe_collect', '    add rsp, 8', '    mov rdi, r12',
            '    add rdi, 48', '    cmp DWORD PTR [rip+valen_arena_enabled], 0', '    je .Lgc_alloc_direct', '    call valen_alloc', '    jmp .Lgc_alloc_ready',
            '.Lgc_alloc_direct:', '    mov rsi, rdi', '    xor edi, edi', '    mov edx, 3', '    mov r10d, 34', '    mov r8, -1', '    xor r9d, r9d', '    mov eax, 9', '    syscall', '.Lgc_alloc_ready:',
            '    cmp rax, -4095', '    jae .Lallocation_error', '    mov rcx, QWORD PTR [rip+valen_gc_heap]', '    mov QWORD PTR [rax], rcx',
            '    lea rcx, [r12+48]', '    mov QWORD PTR [rax+8], rcx', '    mov QWORD PTR [rax+16], r13', '    mov QWORD PTR [rax+24], r14',
            '    mov QWORD PTR [rax+32], 0', '    mov QWORD PTR [rax+40], r15', '    mov QWORD PTR [rip+valen_gc_heap], rax',
            '    add QWORD PTR [rip+valen_gc_bytes], rcx', '    add rax, 48', '    pop r15', '    pop r14', '    pop r13', '    pop r12', '    ret', '',
            '.globl valen_gc_maybe_collect', 'valen_gc_maybe_collect:', '    cmp DWORD PTR [rip+valen_arena_enabled], 0', '    jne .Lgc_maybe_done', '    mov rax, QWORD PTR [rip+valen_gc_bytes]', '    cmp rax, QWORD PTR [rip+valen_gc_threshold]', '    jb .Lgc_maybe_done', '    jmp valen_gc_collect', '.Lgc_maybe_done:', '    ret', '',
            '.globl valen_gc_native_handle_finalize', 'valen_gc_native_handle_finalize:', '    cmp QWORD PTR [rdi+16], 0', '    jl .Lgc_native_handle_finalized', '    mov r10, rdi', '    mov rdi, QWORD PTR [rdi+16]', '    mov eax, 3', '    syscall', '    mov QWORD PTR [r10+16], -1', '    mov QWORD PTR [r10+8], 0', '.Lgc_native_handle_finalized:', '    ret', '',
            '.globl valen_gc_mark', 'valen_gc_mark:', '    test rdi, rdi', '    je .Lgc_mark_done', '    mov rax, QWORD PTR [rip+valen_gc_heap]', '.Lgc_mark_find:', '    test rax, rax', '    je .Lgc_mark_done', '    lea rcx, [rax+48]', '    cmp rcx, rdi', '    je .Lgc_mark_found', '    mov rax, QWORD PTR [rax]', '    jmp .Lgc_mark_find', '.Lgc_mark_found:', '    push rbx', '    mov rbx, rax', '    lea rax, [rip+valen_string_finalize]', '    cmp QWORD PTR [rbx+40], rax', '    je .Lgc_mark_live', '    lea rax, [rip+valen_gc_native_handle_finalize]', '    cmp QWORD PTR [rbx+40], rax', '    jne .Lgc_mark_object', '    cmp QWORD PTR [rdi+16], 0', '    jge .Lgc_mark_live', '    jmp .Lgc_mark_pop', '.Lgc_mark_object:', '    cmp QWORD PTR [rdi+8], 0', '    je .Lgc_mark_pop', '.Lgc_mark_live:',
            '    cmp QWORD PTR [rbx+32], 0', '    jne .Lgc_mark_pop',
            '    mov QWORD PTR [rbx+32], 1', '    mov rax, QWORD PTR [rbx+16]', '    test rax, rax', '    je .Lgc_mark_pop', '    call rax',
            '.Lgc_mark_pop:', '    pop rbx', '.Lgc_mark_done:', '    ret', '',
            '.globl valen_gc_collect', 'valen_gc_collect:', '    push rbp', '    mov rbp, rsp', '    push rbx', '    push r12', '    push r13', '    push r14',
            '    mov r12, QWORD PTR [rip+valen_gc_roots]', '.Lgc_root_frame:', '    test r12, r12', '    je .Lgc_weak_start', '    mov rax, QWORD PTR [r12+8]', '    mov rdi, QWORD PTR [r12+16]', '    call rax',
            '    mov r12, QWORD PTR [r12]', '    jmp .Lgc_root_frame',
            '.Lgc_weak_start:', '    mov r12, QWORD PTR [rip+valen_gc_heap]', '.Lgc_weak_next:', '    test r12, r12', '    je .Lgc_sweep_start',
            '    cmp QWORD PTR [r12+32], 0', '    je .Lgc_weak_advance', '    mov rax, QWORD PTR [r12+24]', '    test rax, rax', '    je .Lgc_weak_advance', '    lea rdi, [r12+48]', '    call rax',
            '.Lgc_weak_advance:', '    mov r12, QWORD PTR [r12]', '    jmp .Lgc_weak_next',
            '.Lgc_sweep_start:', '    lea r12, [rip+valen_gc_heap]', '    mov QWORD PTR [rip+valen_gc_bytes], 0', '.Lgc_sweep_next:', '    mov rbx, QWORD PTR [r12]', '    test rbx, rbx', '    je .Lgc_done',
            '    cmp QWORD PTR [rbx+32], 0', '    je .Lgc_reclaim', '    mov QWORD PTR [rbx+32], 0', '    mov rax, QWORD PTR [rbx+8]', '    add QWORD PTR [rip+valen_gc_bytes], rax', '    mov r12, rbx', '    jmp .Lgc_sweep_next',
            '.Lgc_reclaim:', '    mov r14, QWORD PTR [rbx]', '    mov QWORD PTR [r12], r14', '    mov rax, QWORD PTR [rbx+40]', '    test rax, rax', '    je .Lgc_unmap', '    lea rdi, [rbx+48]', '    call rax',
            '.Lgc_unmap:', '    mov rsi, QWORD PTR [rbx+8]', '    mov rdi, rbx', '    mov eax, 11', '    syscall', '    jmp .Lgc_sweep_next',
            '.Lgc_done:', '    mov rax, QWORD PTR [rip+valen_gc_bytes]', '    shl rax, 1', '    cmp rax, 1048576', '    jae .Lgc_threshold_store', '    mov eax, 1048576', '.Lgc_threshold_store:', '    mov QWORD PTR [rip+valen_gc_threshold], rax', '    pop r14', '    pop r13', '    pop r12', '    pop rbx', '    leave', '    ret', ''
        ];
    }

    gcArrayRuntime() {
        return [
            '.globl valen_gc_array_new', 'valen_gc_array_new:', '    push rbp', '    mov rbp, rsp', '    push rbx', '    push r12', '    push r13', '    push r14', '    push r15', '    sub rsp, 8',
            '    mov r12, rdi', '    mov r13, rsi', '    mov r14, rdx', '    mov r15, rcx', '    test r13, r13', '    js .Larray_bounds_error',
            '    mov edi, 40', '    mov rsi, r14', '    mov rdx, r15', '    lea rcx, [rip+valen_gc_array_finalize]', '    call valen_gc_alloc', '    mov rbx, rax',
            '    mov rax, r13', '    cmp rax, 4', '    jae .Lgc_array_capacity', '    mov eax, 4', '.Lgc_array_capacity:',
            '    mov QWORD PTR [rbx], r13', '    mov QWORD PTR [rbx+8], rax', '    mov QWORD PTR [rbx+24], r12', '    mov QWORD PTR [rbx+32], 1', '    imul rax, r12', '    mov rdi, rax', '    call valen_alloc', '    mov QWORD PTR [rbx+16], rax', '    mov rax, rbx',
            '    add rsp, 8', '    pop r15', '    pop r14', '    pop r13', '    pop r12', '    pop rbx', '    leave', '    ret', '',
            'valen_gc_array_finalize:', '    cmp DWORD PTR [rip+valen_arena_enabled], 0', '    jne .Lgc_array_finalize_done',
            '    mov rsi, QWORD PTR [rdi+8]', '    imul rsi, QWORD PTR [rdi+24]', '    test rsi, rsi', '    jne .Lgc_array_finalize_size', '    mov esi, 1',
            '.Lgc_array_finalize_size:', '    mov rdi, QWORD PTR [rdi+16]', '    mov eax, 11', '    syscall', '.Lgc_array_finalize_done:', '    ret', ''
        ];
    }

    gcTraceFunctions() {
        const lines = [];
        for (const type of this.program.types) {
            lines.push(`${this.gcTraceLabel(type.name)}:`, '    push rbx', '    mov rbx, rdi');
            for (const field of type.fields) {
                if (field.ownership === 'member-weak' || !this.isManagedReferenceType(field.type)) continue;
                const layout = this.fieldOffsets.get(field.symbol);
                lines.push(`    mov rdi, QWORD PTR [rbx+${layout.offset}]`, '    call valen_gc_mark');
            }
            lines.push('    pop rbx', '    ret', `${this.gcWeakLabel(type.name)}:`, '    push rbx', '    mov rbx, rdi');
            for (const field of type.fields) {
                if (field.ownership !== 'member-weak') continue;
                const layout = this.fieldOffsets.get(field.symbol);
                const keep = `.Lgc_weak_keep_${this.runtimeLabel++}`;
                lines.push(`    mov rax, QWORD PTR [rbx+${layout.offset}]`, '    test rax, rax', `    je ${keep}`, '    sub rax, 48',
                    '    cmp QWORD PTR [rax+32], 0', `    jne ${keep}`, `    mov QWORD PTR [rbx+${layout.offset}], 0`, `${keep}:`);
            }
            lines.push('    pop rbx', '    ret', '');
        }
        return lines;
    }

    gcArrayTraceFunctions() {
        const lines = [];
        for (const type of this.structuralArrayTypes()) {
            const spec = type.slice(6, -1);
            const ownership = spec.startsWith('ref ') ? 'ref' : spec.startsWith('weak ') ? 'weak' : 'owned';
            const element = ownership === 'ref' ? spec.slice(4) : ownership === 'weak' ? spec.slice(5) : spec;
            const size = this.sizeOf(element);
            const managed = this.isManagedReferenceType(element);
            const traceLoop = `${this.gcArrayTraceLabel(type)}_loop`, traceDone = `${this.gcArrayTraceLabel(type)}_done`;
            lines.push(`${this.gcArrayTraceLabel(type)}:`, '    push rbx', '    push r12', '    xor ebx, ebx', '    mov r12, rdi');
            if (managed && ownership !== 'weak') {
                lines.push(`${traceLoop}:`, '    cmp rbx, QWORD PTR [r12]', `    jae ${traceDone}`, `    imul rax, rbx, ${size}`,
                    '    add rax, QWORD PTR [r12+16]', '    mov rdi, QWORD PTR [rax]', '    call valen_gc_mark', '    inc rbx', `    jmp ${traceLoop}`);
            }
            lines.push(`${traceDone}:`, '    pop r12', '    pop rbx', '    ret', `${this.gcArrayWeakLabel(type)}:`, '    push rbx', '    push r12', '    xor ebx, ebx', '    mov r12, rdi');
            if (managed && ownership === 'weak') {
                const weakLoop = `${this.gcArrayWeakLabel(type)}_loop`, weakNext = `${this.gcArrayWeakLabel(type)}_next`, weakDone = `${this.gcArrayWeakLabel(type)}_done`;
                lines.push(`${weakLoop}:`, '    cmp rbx, QWORD PTR [r12]', `    jae ${weakDone}`, `    imul rax, rbx, ${size}`,
                    '    add rax, QWORD PTR [r12+16]', '    mov rcx, QWORD PTR [rax]', '    test rcx, rcx', `    je ${weakNext}`,
                    '    sub rcx, 48', '    cmp QWORD PTR [rcx+32], 0', `    jne ${weakNext}`, '    mov QWORD PTR [rax], 0',
                    `${weakNext}:`, '    inc rbx', `    jmp ${weakLoop}`, `${weakDone}:`);
            }
            lines.push('    pop r12', '    pop rbx', '    ret', '');
        }
        return lines;
    }

    gcData() {
        return ['.section .bss', '.align 8', 'valen_gc_roots:', '    .zero 8', 'valen_gc_heap:', '    .zero 8', 'valen_gc_bytes:', '    .zero 8',
            'valen_arena_cursor:', '    .zero 8', 'valen_arena_remaining:', '    .zero 8', 'valen_arena_lock:', '    .zero 4', 'valen_arena_enabled:', '    .zero 4',
            '.section .data', '.align 8', 'valen_gc_threshold:', '    .quad 1048576', '.text'];
    }

    gcTraceLabel(typeName) { return `${this.typeLabel(typeName)}_gc_trace`; }
    gcWeakLabel(typeName) { return `${this.typeLabel(typeName)}_gc_weak`; }
    gcArrayTraceLabel(typeName) { return `.Lvalen_gc_array_trace_${this.mangle(typeName)}`; }
    gcArrayWeakLabel(typeName) { return `.Lvalen_gc_array_weak_${this.mangle(typeName)}`; }

    arrayRuntime() {
        return [
            '.globl valen_array_new',
            'valen_array_new:',
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
            '    mov edi, 40', '    xor esi, esi', '    xor edx, edx', '    lea rcx, [rip+valen_gc_array_finalize]', '    call valen_gc_alloc',
            '    mov r13, rax',
            '    mov rax, rbx',
            '    cmp rax, 4',
            '    jae .Larray_new_capacity',
            '    mov eax, 4',
            '.Larray_new_capacity:',
            '    mov QWORD PTR [r13], rbx',
            '    mov QWORD PTR [r13+8], rax',
            '    mov QWORD PTR [r13+24], r12',
            '    mov QWORD PTR [r13+32], 1',
            '    imul rax, r12',
            '    mov rdi, rax',
            '    call valen_alloc',
            '    mov QWORD PTR [r13+16], rax',
            '    mov rax, r13',
            '    add rsp, 8',
            '    pop r13',
            '    pop r12',
            '    pop rbx',
            '    leave',
            '    ret',
            '',
            '.globl valen_array_address',
            'valen_array_address:',
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
            '.globl valen_array_append',
            'valen_array_append:',
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
            '    call valen_alloc',
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
            '.globl valen_string_address',
            'valen_string_address:',
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
            '.globl valen_string_new',
            'valen_string_new:',
            '    push rbp', '    mov rbp, rsp', '    push rbx', '    push r12', '    mov r12, rdi',
            '    mov edi, 24', '    xor esi, esi', '    xor edx, edx', '    lea rcx, [rip+valen_string_finalize]', '    call valen_gc_alloc', '    mov rbx, rax',
            '    mov QWORD PTR [rbx+8], r12', '    mov rdi, r12', '    test rdi, rdi', '    jnz .Lstring_new_size', '    mov edi, 1', '.Lstring_new_size:',
            '    mov QWORD PTR [rbx+16], rdi', '    call valen_alloc', '    mov QWORD PTR [rbx], rax', '    mov rcx, QWORD PTR [rbx+16]', '    add QWORD PTR [rip+valen_gc_bytes], rcx', '    mov rax, rbx', '    pop r12', '    pop rbx', '    leave', '    ret',
            'valen_string_finalize:', '    cmp DWORD PTR [rip+valen_arena_enabled], 0', '    jne .Lstring_finalize_done', '    mov rsi, QWORD PTR [rdi+16]', '    test rsi, rsi', '    je .Lstring_finalize_done', '    mov rdi, QWORD PTR [rdi]', '    mov eax, 11', '    syscall', '.Lstring_finalize_done:', '    ret',
            'valen_string_borrow:', '    push rbp', '    mov rbp, rsp', '    push rbx', '    push r12', '    mov rbx, rdi', '    mov r12, rsi', '    mov edi, 24', '    xor esi, esi', '    xor edx, edx', '    xor ecx, ecx', '    call valen_gc_alloc', '    mov QWORD PTR [rax], rbx', '    mov QWORD PTR [rax+8], r12', '    mov QWORD PTR [rax+16], 0', '    pop r12', '    pop rbx', '    leave', '    ret',
            '',
            '.globl valen_string_equal',
            'valen_string_equal:',
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
            '.globl valen_string_concat',
            'valen_string_concat:',
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
            '    mov rdi, r13',
            '    call valen_string_new',
            '    mov rbx, rax',
            '    mov rdi, QWORD PTR [rbx]',
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
            '.globl valen_string_slice',
            'valen_string_slice:',
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
            '    mov rdi, r13',
            '    call valen_string_new',
            '    mov rbx, rax',
            '    mov rdi, QWORD PTR [rbx]',
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
            '.globl valen_integer_to_string',
            'valen_integer_to_string:',
            '    push rbp',
            '    mov rbp, rsp',
            '    push rbx',
            '    push r12',
            '    push r13',
            '    push r14',
            '    mov r12, rdi',
            '    mov r14, rsi',
            '    mov edi, 21',
            '    call valen_string_new',
            '    mov rbx, rax',
            '    mov r13, QWORD PTR [rax]',
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
            '    mov QWORD PTR [rbx+8], rdi',
            '    mov rcx, rdi',
            '    mov rdi, r13',
            '    rep movsb',
            '    mov rax, rbx',
            '    pop r14',
            '    pop r13',
            '    pop r12',
            '    pop rbx',
            '    leave',
            '    ret',
            '',
            '.globl valen_builder_append_string',
            'valen_builder_append_string:',
            '    mov rdx, QWORD PTR [rsi+8]',
            '    mov rsi, QWORD PTR [rsi]',
            '    jmp valen_builder_append_raw',
            '.globl valen_builder_append_bytes',
            'valen_builder_append_bytes:',
            '    mov rdx, QWORD PTR [rsi]',
            '    mov rsi, QWORD PTR [rsi+16]',
            '    jmp valen_builder_append_raw',
            'valen_builder_append_raw:',
            '    push rbp', '    mov rbp, rsp', '    push rbx', '    push r12', '    push r13', '    push r14', '    push r15', '    sub rsp, 8',
            '    mov rbx, rdi', '    mov r12, rsi', '    mov r13, rdx', '    mov r14, QWORD PTR [rbx]', '    lea r15, [r14+r13]',
            '    cmp r15, QWORD PTR [rbx+8]', '    jbe .Lbuilder_bulk_copy',
            '    mov rax, QWORD PTR [rbx+8]',
            '.Lbuilder_bulk_grow:', '    shl rax, 1', '    cmp rax, r15', '    jb .Lbuilder_bulk_grow',
            '    mov QWORD PTR [rbx+8], rax', '    mov rdi, rax', '    call valen_alloc',
            '    mov rdi, rax', '    mov rsi, QWORD PTR [rbx+16]', '    mov rcx, r14', '    rep movsb', '    mov QWORD PTR [rbx+16], rax',
            '.Lbuilder_bulk_copy:',
            '    mov rdi, QWORD PTR [rbx+16]', '    add rdi, r14', '    mov rsi, r12', '    mov rcx, r13', '    rep movsb', '    mov QWORD PTR [rbx], r15',
            '    add rsp, 8', '    pop r15', '    pop r14', '    pop r13', '    pop r12', '    pop rbx', '    leave', '    ret',
            '',
            '.globl valen_builder_build',
            'valen_builder_build:',
            '    push rbp',
            '    mov rbp, rsp',
            '    push rbx',
            '    push r12',
            '    push r13',
            '    sub rsp, 8',
            '    mov r12, rdi',
            '    mov r13, QWORD PTR [r12]',
            '    mov rdi, r13',
            '    call valen_string_new',
            '    mov rbx, rax',
            '    mov rdi, QWORD PTR [rbx]',
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
            descriptor: `.Lvalen_string_${index}`,
            data: `.Lvalen_string_${index}_data`,
            bytes: [...new TextEncoder().encode(value)]
        };
        this.stringLiterals.set(value, literal);
        return literal;
    }

    internFloat(value, type) {
        const key = `${type}:${value}`;
        if (this.floatLiterals.has(key)) return this.floatLiterals.get(key);
        const literal = {label: `.Lvalen_float_${this.floatLiterals.size}`, value, type};
        this.floatLiterals.set(key, literal);
        return literal;
    }

    floatData() {
        if (this.floatLiterals.size === 0) return [];
        const lines = ['.section .rodata'];
        for (const literal of this.floatLiterals.values()) {
            lines.push(literal.type === 'f32' ? '.align 4' : '.align 8', `${literal.label}:`, `    ${literal.type === 'f32' ? '.float' : '.double'} ${literal.value}`);
        }
        return [...lines, '.text'];
    }

    floatConversionData() {
        return ['.section .rodata', '.align 8', '.Lfloat_zero:', '    .double 0.0',
            '.Lfloat_u8_limit:', '    .double 256.0', '.Lfloat_u16_limit:', '    .double 65536.0',
            '.Lfloat_u32_limit:', '    .double 4294967296.0', '.Lfloat_u64_limit:', '    .double 18446744073709551616.0',
            '.Lfloat_i8_minimum:', '    .double -128.0', '.Lfloat_i8_limit:', '    .double 128.0',
            '.Lfloat_i16_minimum:', '    .double -32768.0', '.Lfloat_i16_limit:', '    .double 32768.0',
            '.Lfloat_i32_minimum:', '    .double -2147483648.0', '.Lfloat_i32_limit:', '    .double 2147483648.0',
            '.Lfloat_i64_minimum:', '    .double -9223372036854775808.0', '.Lfloat_i64_limit:', '    .double 9223372036854775808.0', '.text'];
    }

    stringData() {
        if (this.stringLiterals.size === 0) return [];
        const lines = ['.section .data', '.align 8'];
        for (const literal of this.stringLiterals.values()) {
            lines.push('    .quad 0', '    .quad 0', '    .quad 0', '    .quad 0', '    .quad 0', '    .quad 0', `${literal.descriptor}:`, `    .quad ${literal.data}`, `    .quad ${literal.bytes.length}`, '    .quad 0');
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
        if (this.registers?.has(name)) return this.registers.get(name);
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
        if (type === 'f32') return 4;
        return 8;
    }

    align(value, alignment) {
        return Math.ceil(value / alignment) * alignment;
    }

    isUnsigned(type) {
        return type?.startsWith('u') || type === 'bool';
    }

    isFloat(type) {
        return type === 'f32' || type === 'f64';
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
        return {u8: 'BYTE', i8: 'BYTE', bool: 'BYTE', u16: 'WORD', i16: 'WORD', u32: 'DWORD', i32: 'DWORD', f32: 'DWORD'}[type] ?? 'QWORD';
    }

    registerForSize(register, type) {
        const registers = {
            rax: {1: 'al', 2: 'ax', 4: 'eax', 8: 'rax'},
            rcx: {1: 'cl', 2: 'cx', 4: 'ecx', 8: 'rcx'},
            rdx: {1: 'dl', 2: 'dx', 4: 'edx', 8: 'rdx'}
        };
        return registers[register][this.sizeOf(type)];
    }

    loadMemory(address, type, register) {
        if (register !== 'rax') throw new Error('Primitive memory loads currently require rax');
        if (type === 'u8' || type === 'bool') return [`    movzx eax, BYTE PTR ${address}`];
        if (type === 'i8') return [`    movsx rax, BYTE PTR ${address}`];
        if (type === 'u16') return [`    movzx eax, WORD PTR ${address}`];
        if (type === 'i16') return [`    movsx rax, WORD PTR ${address}`];
        if (type === 'f32') return [`    mov eax, DWORD PTR ${address}`];
        if (type === 'u32') return [`    mov eax, DWORD PTR ${address}`];
        if (type === 'i32') return [`    movsxd rax, DWORD PTR ${address}`];
        return [`    mov rax, QWORD PTR ${address}`];
    }

    blockLabel(label) {
        return `${this.functionSymbols.get(this.fn.name)}__${label}`;
    }

    mangle(name) {
        let result = '__valen_';
        for (const character of name) {
            result += /[A-Za-z0-9]/.test(character)
                ? character
                : `_${character.codePointAt(0).toString(16)}_`;
        }
        return result;
    }
}
