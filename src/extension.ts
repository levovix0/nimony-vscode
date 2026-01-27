import * as vscode from 'vscode';
import { exec, ExecOptionsWithStringEncoding } from 'child_process';
import { relative } from 'path';


function runNimony(document: vscode.TextDocument, messages: vscode.DiagnosticCollection) {
	const config = vscode.workspace.getConfiguration('nimony');
	const nimonyPath = config.get<string>('path') || 'nimony';

	let command = `${nimonyPath} c "${document.fileName}"`;
	
	let options: ExecOptionsWithStringEncoding = {}
	if (vscode.workspace.workspaceFolders && vscode.workspace.workspaceFolders[0]) {
		options.cwd = vscode.workspace.workspaceFolders[0].uri.fsPath;

		command = `${nimonyPath} c "${vscode.workspace.asRelativePath(document.uri)}"`;
	}

	let nimonyProc = exec(command, options, (error, stdout, stderr) => {
		const diagnostics: vscode.Diagnostic[] = [];
		const lines: Array<string> = (stdout + stderr).split('\n');

		let currentDiagnostic: { range: vscode.Range, message: string, severity: vscode.DiagnosticSeverity } | null = null;

		let skipNext = false;

		for (const line of lines) {
			if (skipNext) {
				skipNext = false;
				continue;
			}

			if (line.startsWith("FAILURE:") && line.includes("nifmake")) { continue; }
			
			const match = line.match(/^(.*?)\((\d+),\s*(\d+)\)\s*(Error|Warning|Hint):\s*(.*)$/);
			let matchTrace;

			if (match) {
				if (currentDiagnostic) {
					diagnostics.push(new vscode.Diagnostic(currentDiagnostic.range, currentDiagnostic.message.trim(), currentDiagnostic.severity));
				}

				const [_, file, lineNum, colNum, severityStr, message] = match;
				const lineIdx = parseInt(lineNum) - 1;
				const colIdx = parseInt(colNum) - 1;

				currentDiagnostic = {
					range: new vscode.Range(lineIdx, colIdx, lineIdx, colIdx + 1),
					message: message,
					severity: severityStr === 'Error' ? vscode.DiagnosticSeverity.Error : vscode.DiagnosticSeverity.Warning
				};

				if (message.includes("Type mismatch at [position]")) { skipNext = true; }
			}
			else if (matchTrace = line.match(/^(.*?)\((\d+),\s*(\d+)\)\s*(Trace):\s*(.*)$/)) {
				// skip
			}
			else if (currentDiagnostic && line.trim().length > 0) {
				currentDiagnostic.message += "\n" + line.trimEnd();
			}
		}

		if (currentDiagnostic) {
			diagnostics.push(new vscode.Diagnostic(currentDiagnostic.range, currentDiagnostic.message.trim(), currentDiagnostic.severity));
		}

		messages.set(document.uri, diagnostics);
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
		})
	);
}


export function deactivate() {

}
