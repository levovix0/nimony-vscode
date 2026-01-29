import * as vscode from 'vscode';
import { exec, ExecOptionsWithStringEncoding, spawn } from 'child_process';
import path, { relative, resolve } from 'path';


type Diagnostic = {
	kind: string,
	lineInfo: string,
	location: vscode.Location,
	mainMessage: string,
} & vscode.Diagnostic;


function toLocation(file: string, lineNum: string, colNum: string): vscode.Location {
	let lineIdx = parseInt(lineNum) - 1;
	let colIdx = parseInt(colNum) - 1;
	let range = new vscode.Range(lineIdx, colIdx, lineIdx, colIdx + 1)
	let documentUri = vscode.Uri.file(resolve(vscode.workspace.workspaceFolders?.at(0)?.uri.fsPath || path.resolve("."), file))
	return new vscode.Location(documentUri, range);
}


function addLineToDiagnostics(line: string, diagnostic: { message: string, relatedInformation?: vscode.DiagnosticRelatedInformation[] }) {
	let match;
	if (match = line.match(/^(.*)\(.+\sin\s(.*?)\((\d+),\s*(\d+)\)\)$/)) {
		console.log(match)
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
	let args = ["c", document.fileName]
	
	let options: ExecOptionsWithStringEncoding = {}
	if (vscode.workspace.workspaceFolders && vscode.workspace.workspaceFolders[0]) {
		options.cwd = vscode.workspace.workspaceFolders[0].uri.fsPath;

		args = ["c", vscode.workspace.asRelativePath(document.uri)];
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
}


export function deactivate() {

}
