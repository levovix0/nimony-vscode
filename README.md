# nimony support for vscode

Very simple extension for Nim programming language support with nimony as a compiler.

Supports:
- Syntax highlihting (copy-pasted from nimsaem/Nim extension)
- Error diagnostics
- Autocomplete (currently scans for all compiled modules and includes all private symbols, also description and symbol type is wrong)

This extension invokes `nimony` in the workspace folder each time file is saved to get error diagnostics. This means each time a .nim file is saved it is automatically compiled. Compilation in nimony is incremental, so i hope that it is acceptable.

Disable any other Nim extension in order for this extension to work correctly. It is recomended to do this per-workspace (enable regular Nim for regular Nim projects, enable this extension for Nimony projects)

