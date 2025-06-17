// The module 'vscode' contains the VS Code extensibility API
// Import the module and reference it with the alias vscode in your code below
import * as vscode from 'vscode';

import * as treesitter from 'web-tree-sitter'

import { NumberRange, RangeBinTree } from './ast-btree';

import { StringBuilder } from 'typescript-string-operations';
import ollama from 'ollama';

interface DocumentState {
	text: string,
	content: Uint8Array;
	tree: treesitter.Tree | null;
};

let parser: treesitter.Parser;

let documentStates = new Map<vscode.Uri, DocumentState>();

interface AnalysisReport {
	issue: string,
	description: string,
	location: {
		line: number,
		snippet: string
	}
};

interface DocumentAnalysis {
	done: boolean;
	results: AnalysisReport[]
};

let documentAnalysisStates = new Map<vscode.Uri, DocumentAnalysis>();

function createInspectionMessage(sourceCode: string) {
	const sb = new StringBuilder();

	let lineCounter = 1;

	sourceCode.split('\n').forEach(line =>
		sb.append(`${line} // line ${lineCounter++}\n`)
	);

	console.log(`PREPROCESSED SRC:\n${sb.toString()}`);

	return `Imagine that you're a static analyser. You have a Go code snippet. Find bugs, vulnerabilities and weaknesses in the code.
\`\`\`go
${sb.toString()}
\`\`\`
Provide only static analysis results as a JSON array. JSON-format for each bug info is
\`\`\`json
{
  "issue": textual description of the found bug,
  "description": detailed information about issue,
  "location": {
    "line": line with expression with bug was found,
    "snippet": Shortest part of the expression in the original code snippet that cause to the problem
  }
}
\`\`\`
JSON result should be enclosed with backticks.`;
}

let golangDiagnosticCollection: vscode.DiagnosticCollection;

async function inspectCode(sourceCode: string, resultsProcessor?: (arg: AnalysisReport[]) => void, finalizer?: () => void) {
	const message = createInspectionMessage(sourceCode);

	ollama.chat({
		model: 'qwen3:1.7b',
		messages: [
			{
				role: 'user',
				content: message
			}
		],
		think: false,
		stream: false
	}).then(response => {
		const analysisResponse = response.message.content;

		const jsonStartIndex1 = analysisResponse.indexOf('```json');
		const jsonStartIndex2 = analysisResponse.indexOf('```');

		const jsonStartIndex = jsonStartIndex1 >= 0 ? jsonStartIndex1 : jsonStartIndex2;
		const skipSymbols = jsonStartIndex1 >= 0 ? 7 : 3;

		console.log(`DEBUG response: ${analysisResponse}`);

		if (jsonStartIndex >= 0 && analysisResponse.length > skipSymbols) {
			let str = analysisResponse.substring(jsonStartIndex + skipSymbols).trim();
			const jsonEndIndex = str.indexOf('```');

			str = str.substring(0, jsonEndIndex);

			return JSON.parse(str);
		}

		return undefined;
	}).then(arg => {
		console.log(`DEBUG results: ${arg} ${JSON.stringify(arg)}`);

		if (arg !== undefined)
			resultsProcessor?.(arg);
	}).finally(finalizer);
}

async function checkCode() {
	const acitveDoc = vscode.window.activeTextEditor?.document;

	if (acitveDoc) {
		let docAnalysisState = documentAnalysisStates.get(acitveDoc.uri);

		const sourceCode = acitveDoc.getText();

		if (!docAnalysisState) {
			docAnalysisState = {
				results: [],
				done: true
			};

			documentAnalysisStates.set(acitveDoc.uri, docAnalysisState);
		}

		if (docAnalysisState.done) {
			docAnalysisState.done = false;

			inspectCode(sourceCode, results => {
				const documentDiagnostics: vscode.Diagnostic[] = [];

				results.forEach(result => {
					const line = result.location.line - 1;

					console.log(`DEBUG result: ${result.location.line}, ${result.location.snippet}`);

					const lineText = acitveDoc.getText(new vscode.Range(
						line, 0,
						line, Number.MAX_SAFE_INTEGER
					));

					if (lineText === undefined)
						return;

					const offset = lineText.indexOf(result.location.snippet);

					if (offset < 0)
						return;

					const diag = new vscode.Diagnostic(
						new vscode.Range(
							new vscode.Position(line, offset),
							new vscode.Position(line, offset + result.location.snippet.length)
						),
						result.description,
						vscode.DiagnosticSeverity.Warning
					);
					documentDiagnostics.push(diag);
				});

				golangDiagnosticCollection.set(
					acitveDoc.uri,
					documentDiagnostics
				);

				documentAnalysisStates.get(acitveDoc.uri)!.results = results;
			},

			() => documentAnalysisStates.get(acitveDoc.uri)!.done = true)
		}
	}
}

function convertPositionToTSPoint(position: vscode.Position): treesitter.Point {
	return {
		row: position.line,
		column: position.character
	};
}

function convertContentChangeToTSEdit(doc: vscode.TextDocument, change: vscode.TextDocumentContentChangeEvent): treesitter.Edit {
	const startPoint: treesitter.Point = convertPositionToTSPoint(change.range.start);
	const startIndex = change.rangeOffset;

	const oldEndPoint: treesitter.Point = convertPositionToTSPoint(change.range.end);
	const oldEndIndex = doc.offsetAt(change.range.end);
	
	const newEndIndex = change.rangeOffset + change.rangeLength;
	const newEndPoint: treesitter.Point = convertPositionToTSPoint(doc.positionAt(newEndIndex));

	return {
		startPosition: startPoint,
		startIndex: startIndex,

		oldEndPosition: oldEndPoint,
		oldEndIndex: oldEndIndex,

		newEndPosition: newEndPoint,
		newEndIndex: newEndIndex
	};
}

function createRangeBTreeNode(n: treesitter.Node): RangeBinTree<treesitter.Node> {
	const node = new RangeBinTree(
		new NumberRange(n.startIndex, n.endIndex),
		n
	);

	n.children.map(child => createRangeBTreeNode(child!)).forEach(t => node.addChildNode(t));

	return node;
}

let diagnosticCollection: vscode.DiagnosticCollection;

// This method is called when your extension is activated
// Your extension is activated the very first time the command is executed
export async function activate(context: vscode.ExtensionContext) {
	await treesitter.Parser.init();
	parser = new treesitter.Parser();
	
	const Golang = await treesitter.Language.load(context.extensionPath + '/parsers/go/tree-sitter-go.wasm');
	parser.setLanguage(Golang);

	const disposable = vscode.commands.registerCommand('helloworld.helloWorld', () => {
		vscode.window.showInformationMessage('Hello World from HelloWorld!');

		console.log(
			vscode.window.activeTextEditor?.document.getText(new vscode.Range(
				100, 0, 100, Number.MAX_SAFE_INTEGER
			))
		);
	});

	vscode.workspace.onDidChangeTextDocument(e => {
		if (e.contentChanges.length === 0)
			return;

		const src = e.document.getText();
		const docURI = e.document.uri;

		const docState = documentStates.get(docURI);

		if (docState) {
			const edit = convertContentChangeToTSEdit(e.document, e.contentChanges[0]);

			const oldTree = docState.tree;
			oldTree?.edit(edit);
			const newTree = parser.parse(src, oldTree);

			docState.tree = newTree;

			checkCode();
		} else {
			const tree = parser.parse(src);

			vscode.workspace.encode(src).then(
				val => documentStates.set(
					e.document.uri,
					{
						text: src,
						content: val,
						tree: tree
					}
				)
			);
		}
	})

	const defProvider = vscode.languages.registerDefinitionProvider('java', {
		provideDefinition(document, position, token) {
			const range = document.getWordRangeAtPosition(position);
			console.log(range, token);

			return range && new vscode.Location(
					vscode.Uri.parse('/Users/aaamoj/main.c'), 
					range
				) || new vscode.Location(
					vscode.Uri.file('/Users/aaamoj/main.c'), 
					position
				);
		}
	});

	context.subscriptions.push(disposable, defProvider);

	golangDiagnosticCollection = vscode.languages.createDiagnosticCollection("go");
}

// This method is called when your extension is deactivated
export function deactivate() {}
