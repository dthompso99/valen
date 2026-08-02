Argon: A low level programming language from the ground up

Targets (or wish list?):
- fully object oriented from conceputization (not a afterthought bolt on)
- eventually compiles down to ELF executables (possible to build an entire os from eventually)
- multiple elf targets (esp32, x64, arm64, etc)
- dynamic library support
- eventually, the lexer, the compiler, and the linker are all written in argon
- avoid explicit pointers, favoring object lifettime
- eventualy:  very hardware friendly


approach:
 - bootstrap:  create the prototype tokenizer, lexer, and compiler in nodejs.
 - sample.ar: an example of what some simple code may look like

Roadmaps:
 - `bootstrap_checklist.md`: bootstrap implementation and proof
 - `language_checklist.md`: post-bootstrap language, ownership, tooling, and optimization work
