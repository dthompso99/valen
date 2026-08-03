# Valen documentation

If you are new to the project, read these in order:

1. [Quickstart](quickstart.md) — build the compiler and run a small program.
2. [Language guide](language-guide.md) — learn the syntax and current semantics.
3. [Project status](project-status.md) — see what works and what remains **WIP**.
4. [HTTP service friction report](service-friction/http-health-config.md) — see what the first real service taught us.

For compiler contributors:

- [Compiler developer guide](compiler-guide.md) explains the bootstrap, self-hosted pipeline, repository layout, and tests.
- [Contributor and agent guide](agent-guide.md) records the project’s working conventions.
- [Bootstrap checklist](bootstrap_checklist.md) preserves the original self-hosting plan.
- [Freestanding profile](freestanding.md) defines the capability boundary for kernels, firmware, and embedded targets.

Focused technical references remain at the repository root:

- [Operation model](../operation_model.md)
- [Generic objects](../generics.md)
- [Floating-point rules](../floating_point.md)
- [Native and C FFI](../ffi.md)
- [Unsafe boundary](../unsafe_boundary.md)
- [x86-64 ABI](../x86_64_abi.md)

The [language roadmap](../language_checklist.md) is the detailed feature inventory. Unchecked roadmap items should be treated as **WIP**, even when their intended behavior has been discussed.
