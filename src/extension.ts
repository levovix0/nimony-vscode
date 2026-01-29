import * as vscode from 'vscode';
import { exec, ExecOptionsWithStringEncoding, spawn } from 'child_process';
import path, { relative, resolve } from 'path';
import { opendirSync, readdirSync, readFileSync, statSync } from 'fs';


type Diagnostic = {
	kind: string,
	lineInfo: string,
	location: vscode.Location,
	mainMessage: string,
} & vscode.Diagnostic;

type Nif = {
	kind: string,
	pos: vscode.Location,
	str?: string,
} & Nif[];

type Symbol = {
	name: string,
	displayedName: string,
	completionItem: vscode.CompletionItem,
}

type SymbolTables = Record<string, {
	lastChanged: Date,
	symbols: Symbol[]
}>


let symtab: SymbolTables = {}


function workingDirectory(): string {
	if (vscode.workspace.workspaceFolders && vscode.workspace.workspaceFolders[0]) {
		return vscode.workspace.workspaceFolders[0].uri.fsPath;
	}
	return path.resolve(".");
}


function toLocation(file: string, lineNum: string, colNum: string): vscode.Location {
	let lineIdx = parseInt(lineNum) - 1;
	let colIdx = parseInt(colNum) - 1;
	let range = new vscode.Range(lineIdx, colIdx, lineIdx, colIdx + 1)
	let documentUri = vscode.Uri.file(resolve(workingDirectory(), file))
	return new vscode.Location(documentUri, range);
}


function parseNifNode(c: {s: string, i: number, pos: vscode.Location}): Nif {
	let res: Nif = [] as unknown as Nif;
	res.kind = "unknown";
	res.pos = c.pos;

	let specialChars = /[\s\(\)\[\]\{\}\~\#\\\"\'\:]/;

	function skipNonNode() {
		while (true) {
			if (/\s/.test(c.s[c.i])) {
				++c.i;
			}
			else if (/[0-9\,\~]/.test(c.s[c.i])) {
				// line info
				let col = "";
				if (c.s[c.i] == '~') {
					// col += '-';
					++c.i;
				}
				while (/[0-9]/.test(c.s[c.i])) {
					col += c.s[c.i];
					++c.i;
				}

				let line;
				if (c.s[c.i] == ',') {
					line = ""
					++c.i;
					if (c.s[c.i] == '~') {
						// line += '-';
						++c.i;
					}
					while (/[0-9]/.test(c.s[c.i])) {
						line += c.s[c.i];
						++c.i;
					}
				}
				else {
					line = c.pos.range.start.line.toString()
				}

				let filename;
				if (c.s[c.i] == ',') {
					filename = ""
					++c.i;
					while (c.s[c.i] && !specialChars.test(c.s[c.i])) {
						filename += c.s[c.i];
						++c.i;
					}
				}

				skipNonNode();

				if (filename) {
					c.pos = toLocation(filename, (+line + 1).toString(), (+col + 1).toString());
				}
				else {
					c.pos = new vscode.Location(c.pos.uri, new vscode.Range(+line, +col, +line, +col + 1));
				}
			}
			else {
				break;
			}
		}
	}

	skipNonNode();
	if (c.s[c.i] == '(') {
		// a node
		++c.i; skipNonNode();

		// kind
		res.kind = ""
		while (c.s[c.i] && !specialChars.test(c.s[c.i])) {
			res.kind += c.s[c.i];
			++c.i;
		}
		skipNonNode();

		while (c.s[c.i] && c.s[c.i] != ')') {
			// childs...
			res.push(parseNifNode(c))
			skipNonNode();
		}

		++c.i; skipNonNode();
	}
	else if (c.s[c.i] == '.') {
		res.kind = ""
		++c.i; skipNonNode();
	}
	else if (/[\"\']/.test(c.s[c.i])) {
		// string (or char, but it doesn't matter for us)
		res.kind = "<string>";
		res.str = "";
		let quote = c.s[c.i]
		++c.i;
		while (true) {
			if (!c.s[c.i]) { break; }
			if (c.s[c.i] == quote) { break; }
			if (c.s[c.i] == '\\') {
				res.str += String.fromCharCode(parseInt(c.s.substring(c.i + 1, c.i + 3), 16))
				c.i += 3;
			}
			else {
				res.str += c.s[c.i];
				++c.i;
			}
		}
		++c.i; skipNonNode();
	}
	else if (c.s[c.i] == ':') {
		// symbol
		res.kind = "<symbol>";
		res.str = ""
		++c.i;
		while (c.s[c.i] && !specialChars.test(c.s[c.i])) {
			res.str += c.s[c.i];
			++c.i;
		}
		skipNonNode();
	}
	else if (/[\+\-]/.test(c.s[c.i])) {
		// number
		res.kind = "<number>";
		res.str = c.s[c.i]
		++c.i;
		while (true) {
			if (/[0-9\.]/.test(c.s[c.i])) {
				res.str += c.s[c.i];
				++c.i;
			}
			else if (c.s[c.i] == 'E' && /\+\-/.test(c.s[c.i + 1])) {
				res.str += c.s[c.i];
				res.str += c.s[c.i + 1];
				c.i += 2;
			}
			else if (c.s[c.i] == 'u') {
				++c.i;
				break;
			}
			else {
				break;
			}
		}
		skipNonNode();
	}
	else if (!c.s[c.i]) {
		// EOF
		return res;
	}
	else {
		// ident
		res.kind = "<ident>"
		res.str = ""
		while (c.s[c.i]) {
			if (c.s[c.i] == '\\') {
				res.str += String.fromCharCode(parseInt(c.s.substring(c.i + 1, c.i + 3), 16))
				c.i += 3;
			}
			else if (specialChars.test(c.s[c.i])) { break; }
			else {
				res.str += c.s[c.i];
				++c.i;
			}
		}
		skipNonNode();
		if (res.str === "") {
			++c.i;
		}
	}

	return res
}


function parseNif(c: string | {s: string, i: number, pos: vscode.Location}): Nif[] {
	let nodes: Nif[] = []

	if (typeof c !== "object") {
		c = { s: c, i: 0, pos: new vscode.Location(vscode.Uri.file("???"), new vscode.Range(1, 0, 1, 0)) }
	}

	while (c.i < c.s.length) {
		if (c.s[c.i] == '(') {
			nodes.push(parseNifNode(c));
		}
		else {
			++c.i;
		}
	}

	return nodes;
}


function parseIndexNif(nif: Nif): Symbol[] {
	let res: Symbol[] = []

	for (const list of nif) {
		if (list.kind === "checksum") { continue }

		for (const entry of list) {
			if (!entry[0].str) { continue }

			// todo: lookup actual symbol definition
			
			const name = entry[0].str
			const hrname = name.slice(0, name.indexOf("."));
			
			let sym = res.find((v) => v.displayedName == hrname)
			if (!sym) {
				sym = {
					name: name,
					displayedName: hrname,
					completionItem: {
						label: hrname,
						detail: name,
						insertText: hrname,
						kind: vscode.CompletionItemKind.Variable,
					},
				}

				res.push(sym);
			}
			else {
				sym.completionItem.detail += `\n${name}`
			}
		}
	}

	return res;
}


function updateSymbolTables() {
	let nimcacheDir = resolve(workingDirectory(), "nimcache");
	for (const filename of readdirSync(nimcacheDir)) {
		if (!filename.endsWith(".idx.nif")) { continue; }

		let filepath = path.join(nimcacheDir, filename);
		let lastChanged = statSync(filepath).mtime;

		if (!symtab[filename] || symtab[filename].lastChanged < lastChanged) {
			symtab[filename] = {
				lastChanged: lastChanged,
				symbols: parseIndexNif(parseNif(readFileSync(filepath).toString())[1])
			}
		}
	}
}


class NimonySymbolProvider implements vscode.DocumentSymbolProvider, vscode.CompletionItemProvider {
	provideDocumentSymbols(document: vscode.TextDocument, token: vscode.CancellationToken) {
		const symbols: vscode.DocumentSymbol[] = [];
		
		// todo: outline
		
		return symbols;
	}

	provideCompletionItems(
		document: vscode.TextDocument,
		position: vscode.Position,
		token: vscode.CancellationToken,
		context: vscode.CompletionContext
	): vscode.CompletionItem[] {
		let res: vscode.CompletionItem[] = [];

		updateSymbolTables();

		for (const [filenam, tab] of Object.entries(symtab)) {
			for (const sym of tab.symbols) {
				res.push(sym.completionItem);
			}
		}

		return res;
	}
}


function addLineToDiagnostics(line: string, diagnostic: { message: string, relatedInformation?: vscode.DiagnosticRelatedInformation[] }) {
	let match;
	if (match = line.match(/^(.*)\(.+\sin\s(.*?)\((\d+),\s*(\d+)\)\)$/)) {
		const [_, message, file, lineNum, colNum] = match;
		if (!diagnostic.relatedInformation) { diagnostic.relatedInformation = [] }

		diagnostic.relatedInformation.push(new vscode.DiagnosticRelatedInformation(
			toLocation(file, lineNum, colNum),
			message
		))
	}
	else if (match = line.match(/^(.*?)\((\d+),\s*(\d+)\)(.*)$/)) {
		const [_, file, lineNum, colNum, message] = match;
		if (!diagnostic.relatedInformation) { diagnostic.relatedInformation = [] }

		diagnostic.relatedInformation.push(new vscode.DiagnosticRelatedInformation(
			toLocation(file, lineNum, colNum),
			message
		))
	}
	else if (match = line.match(/^(.*?)\((\d+)\)(.*)$/)) {
		const [_, file, lineNum, message] = match;
		if (!diagnostic.relatedInformation) { diagnostic.relatedInformation = [] }

		diagnostic.relatedInformation.push(new vscode.DiagnosticRelatedInformation(
			toLocation(file, lineNum, "1"),
			message
		))
	}
	else {
		diagnostic.message += `\n${line}`
	}
}


function parseNimonyOutput(lines: Array<string>, outDiagnostics: vscode.DiagnosticCollection) {
	const diagnostics: Record<string, { document: vscode.Uri, diagnostics: Diagnostic[] }> = {};
	let currentDiagnostic: Diagnostic | null = null;
	let trace: { k: string, i: number, lineInfo: string, location: vscode.Location }[] = [];
	let stacktrace: { message: string, relatedInformation?: vscode.DiagnosticRelatedInformation[] } = { message: "" }

	const pushCurrentDiagnostic = () => {
		if (currentDiagnostic) {
			if (!diagnostics[currentDiagnostic.location.uri.fsPath]) {
				diagnostics[currentDiagnostic.location.uri.fsPath] = { document: currentDiagnostic.location.uri, diagnostics: [] }
			}
			diagnostics[currentDiagnostic.location.uri.fsPath].diagnostics.push(currentDiagnostic);
		
			if (currentDiagnostic.kind === "Trace") {
				trace.push({
					k: currentDiagnostic.location.uri.fsPath,
					i: diagnostics[currentDiagnostic.location.uri.fsPath].diagnostics.length - 1,
					lineInfo: `${currentDiagnostic.lineInfo}`,
					location: new vscode.Location(currentDiagnostic.location.uri, currentDiagnostic.range),
				});
			}
			else {
				let msg = currentDiagnostic.message;
				for (let tr of trace) {
					if (!currentDiagnostic.relatedInformation) { currentDiagnostic.relatedInformation = [] }
					currentDiagnostic.relatedInformation.push(new vscode.DiagnosticRelatedInformation(
						tr.location,
						diagnostics[tr.k].diagnostics[tr.i].message
					))

					let tr_d = diagnostics[tr.k].diagnostics[tr.i];
					if (!tr_d.relatedInformation) { tr_d.relatedInformation = [] }
					tr_d.message = `${currentDiagnostic.mainMessage} (${tr_d.message})`
					tr_d.relatedInformation?.push(new vscode.DiagnosticRelatedInformation(
						currentDiagnostic.location,
						msg
					))

					tr_d.severity = currentDiagnostic.severity
				}
				trace = [];
			}
		}
		currentDiagnostic = null;
	};

	const matchErrmsg = (line: string) => {
		let match;
		if (match = line.match(/^(.*?)\((\d+),\s*(\d+)\)\s*(Error|Warning|Hint|Trace):\s*(.*)$/)) {
			const [_, file, lineNum, colNum, severityStr, message] = match;
			return [ file, lineNum, colNum, severityStr, message ]
		}
		if (match = line.match(/^\[(Bug)\]\s*(.*?)\((\d+),\s*(\d+)\)\s*(.*)$/)) {
			const [_, severityStr, file, lineNum, colNum, message] = match;
			return [ file, lineNum, colNum, severityStr, message ]
		}
	}

	for (const line of lines) {
		if (line.startsWith("FAILURE:") && line.includes("nifmake")) { continue; }
		
		let match = matchErrmsg(line)

		if (match) {
			pushCurrentDiagnostic();

			let [file, lineNum, colNum, severityStr, message] = match;
			let location = toLocation(file, lineNum, colNum);

			if (stacktrace.message) {
				message += `\n${stacktrace.message}`;
			}
			
			currentDiagnostic = {
				location: location,
				range: location.range,
				message: message,
				mainMessage: message,
				severity: (severityStr === 'Error' || severityStr === 'Bug') ? vscode.DiagnosticSeverity.Error : vscode.DiagnosticSeverity.Warning,
				kind: severityStr,
				lineInfo: `${file}(${lineNum}, ${colNum})`,
			};

			if (stacktrace.relatedInformation) {
				if (!currentDiagnostic.relatedInformation) { currentDiagnostic.relatedInformation = [] }
				currentDiagnostic.relatedInformation.push(...stacktrace.relatedInformation);
			}
			stacktrace = { message: "" };
		}
		else if (line.trim() === "Traceback (most recent call last)") {
			pushCurrentDiagnostic();
			if (stacktrace.message) { stacktrace.message += "\n"; }
			stacktrace.message += line;
		}
		else if (currentDiagnostic && line.trim().length > 0) {
			addLineToDiagnostics(line, currentDiagnostic);
		}
		else {
			addLineToDiagnostics(line, stacktrace)
		}
	}

	pushCurrentDiagnostic();

	outDiagnostics.clear();
	for (const file of Object.values(diagnostics)) {
		outDiagnostics.set(file.document, file.diagnostics);
	}
}


function runNimony(document: vscode.TextDocument, outDiagnostics: vscode.DiagnosticCollection) {
	const config = vscode.workspace.getConfiguration('nimony');
	const nimonyPath = config.get<string>('path') || 'nimony';

	let command = nimonyPath;
	let args = ["check", document.fileName]
	
	let options: ExecOptionsWithStringEncoding = {}
	if (vscode.workspace.workspaceFolders && vscode.workspace.workspaceFolders[0]) {
		options.cwd = vscode.workspace.workspaceFolders[0].uri.fsPath;

		args[1] = vscode.workspace.asRelativePath(document.uri);
	}

	let nimonyProc = spawn(command, args, options);
	let stdout = "";
	
	nimonyProc.stdout.on('data', (data) => {
		stdout += data.toString();
	});
	
	nimonyProc.stderr.on('data', (data) => {
		stdout += data.toString();
	});

	nimonyProc.on('close', (code) => {
		const lines: Array<string> = stdout.split('\n');
		parseNimonyOutput(lines, outDiagnostics);
	});
}


export function activate(context: vscode.ExtensionContext) {
	const diagnosticCollection = vscode.languages.createDiagnosticCollection('nimonyLinter');
	const config = vscode.workspace.getConfiguration('nimony');

	// todo: display errors faster via onDidChangeTextDocument and custom compiler logic
	
	context.subscriptions.push(
		vscode.workspace.onDidSaveTextDocument(document => {
			if (config.get<boolean>('diagnostics')) {
				if (document.languageId === "nim") {
					runNimony(document, diagnosticCollection);
				}
			}
			else {
				diagnosticCollection.clear();
			}
		})
	);

	context.subscriptions.push(
		vscode.languages.registerDocumentSymbolProvider({ language: 'nim' }, new NimonySymbolProvider())
	)
	context.subscriptions.push(
		vscode.languages.registerCompletionItemProvider({ language: 'nim' }, new NimonySymbolProvider())
	)
}


export function deactivate() {

}
