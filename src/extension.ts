import * as vscode from 'vscode';
import { exec, ExecOptionsWithStringEncoding } from 'child_process';
import path, { relative, resolve } from 'path';


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
		type Diagnostic = {
			kind: string,
			lineInfo: string,
			location: vscode.Location,
			mainMessage: string,
		} & vscode.Diagnostic;

		const diagnostics: Record<string, { document: vscode.Uri, diagnostics: Diagnostic[] }> = {};
		const lines: Array<string> = (stdout + stderr).split('\n');

		let currentDiagnostic: Diagnostic | null = null;
		let trace: { k: string, i: number, lineInfo: string, location: vscode.Location }[] = [];

		let skipNext = false;

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
		};

		for (const line of lines) {
			if (skipNext) {
				skipNext = false;
				continue;
			}

			if (line.startsWith("FAILURE:") && line.includes("nifmake")) { continue; }
			
			const match = line.match(/^(.*?)\((\d+),\s*(\d+)\)\s*(Error|Warning|Hint|Trace):\s*(.*)$/);

			if (match) {
				pushCurrentDiagnostic();

				const [_, file, lineNum, colNum, severityStr, message] = match;
				const lineIdx = parseInt(lineNum) - 1;
				const colIdx = parseInt(colNum) - 1;
				let range = new vscode.Range(lineIdx, colIdx, lineIdx, colIdx + 1)
				let documentUri = vscode.Uri.file(resolve(vscode.workspace.workspaceFolders?.at(0)?.uri.fsPath || path.resolve("."), file))
				
				currentDiagnostic = {
					location: new vscode.Location(documentUri, range),
					range: range,
					message: message,
					mainMessage: message,
					severity: severityStr === 'Error' ? vscode.DiagnosticSeverity.Error : vscode.DiagnosticSeverity.Warning,
					kind: severityStr,
					lineInfo: `${file}(${lineNum}, ${colNum})`,
				};

				if (message.includes("Type mismatch at [position]")) { skipNext = true; }
			}
			else if (currentDiagnostic && line.trim().length > 0) {
				currentDiagnostic.message += "\n" + line.trimEnd();
			}
		}

		pushCurrentDiagnostic();

		
		for (const file of Object.values(diagnostics)) {
			messages.set(file.document, file.diagnostics);
		}
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
