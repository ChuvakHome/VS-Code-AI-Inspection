// The module 'vscode' contains the VS Code extensibility API
// Import the module and reference it with the alias vscode in your code below
import * as vscode from 'vscode';

import * as treesitter from 'web-tree-sitter'

import { NumberRange, Range, RangeBinTree } from './ast-btree';

import { StringBuilder } from 'typescript-string-operations';
import ollama from 'ollama';

class VSCodeRange extends Range<vscode.Position> {
	constructor(start: vscode.Position, end: vscode.Position) {
        super(start, end, (p1, p2) => {
			return p1.line !== p2.line 
					? p1.line - p2.line
					: p1.character - p2.character;
		});
    }
}

interface DocumentState {
	text: string,
	content: Uint8Array;
	tree: treesitter.Tree | null;
	rangeTree: RangeBinTree<treesitter.Node> | null;
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

interface InpectCommandArguments {
	functions: string[]
};

interface AnalysisRequest {
	startLine: number,
	text: string
};

let documentAnalysisStates = new Map<vscode.Uri, DocumentAnalysis>();
let diagnosticsTree = new Map<vscode.Uri, RangeBinTree<vscode.Diagnostic, vscode.Position>>()

function addLineComments(sourceCode: string, startLineNumber: number = 1) {
	const sb = new StringBuilder();

	let lineCounter = startLineNumber;

	sourceCode.split('\n').forEach(line =>
		sb.append(`${line} // line ${lineCounter++}\n`)
	);

	console.log(`PREPROCESSED SRC:\n${sb.toString()}`);

	return sb.toString();
}

function createInspectionMessage(sourceCode: string) {
	return `Imagine that you're a static analyser. You have a Go code snippet. Find bugs, vulnerabilities and weaknesses in the code.
\`\`\`go
${sourceCode}
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
Comments with line numbers are virtual, do not add them to snippet field. Result JSON should be an array enclosed with backticks, array elements should be separated by a comma.`;
}

let golangDiagnosticCollection: vscode.DiagnosticCollection;

async function inspectCode(sourceCode: string, /* firstLineNumber?: number, */ resultsProcessor?: (arg: AnalysisReport[]) => void, finalizer?: () => void) {
	const conf = vscode.workspace.getConfiguration('aiInspection');

	const model = conf.get<string>('model');

	if (!model) {
		await vscode.window.showErrorMessage('Unable to perform a static analysis because the model used is not specified.');

		return;
	}

	const message = createInspectionMessage(sourceCode);

	ollama.chat({
		model: model,
		// model: 'codeqwen:7b',
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

function printNode(n: treesitter.Node | null, indent = 0) {
	if (n == null)
		return;

	const pointStringfier = (point: treesitter.Point) => {
		return `${point.row}:${point.column}`
	};

	console.log(`${' '.repeat(indent * 4)}${n.type} ${n.startIndex} ${pointStringfier(n.startPosition)} - ${pointStringfier(n.endPosition)} ${n.endIndex} # ${n.childCount === 0 ? n.text + ' :: ' : ''}${n.isError}, ${n.isExtra}, ${n.isMissing}`)
	n.children.forEach(child => printNode(child, indent + 1))
}

function findFunctionsByNames(tree: RangeBinTree<treesitter.Node>, names: string[]): treesitter.Node[] {
	const functions: treesitter.Node[] = []
	const nameSet = new Set<string>(names);

	tree.forEachChildren(n => {
		if (n.type === 'function_declaration') {
			const funcName = n.childForFieldName('name')?.text;

			if (funcName && nameSet.has(funcName))
				functions.push(n);
		}
	});

	return functions;
}

function findEnclosingBlock(tree: RangeBinTree<treesitter.Node>, range: Range, grabParentBlock: boolean = true): treesitter.Node | undefined {
	let enclosings = tree.find(range);
	let result: treesitter.Node | undefined = undefined;

	while (enclosings && enclosings.length > 0) {
		const treeNode = enclosings[0];

		if (treeNode.node.childCount == 0 || !range.inside(treeNode.range))
			break;

		if (treeNode.node.type === 'block')
			result = (grabParentBlock ? treeNode.node.parent : treeNode.node) || undefined;

		enclosings = treeNode.find(range);
	}

	return result;
}

function retrieveTextFromDocument(doc: vscode.TextDocument, range?: NumberRange, grabParentBlock: boolean = true): AnalysisRequest {
	if (!range) {
		return { 
			text: doc.getText(),
			startLine: 0
		};
	}

	const docState = documentStates.get(doc.uri);

	if (!docState) {
		return { 
			text: doc.getText(),
			startLine: 0
		};
	}

	const node = findEnclosingBlock(docState.rangeTree!, new NumberRange(
				range.start,
				range.end
			), grabParentBlock);

	if (!node) {
		return { 
			text: doc.getText(),
			startLine: 0
		};
	}

	return {
		startLine: node.startPosition.row,
		text: doc.getText(
			new vscode.Range(
				new vscode.Position(node.startPosition.row, node.startPosition.column),
				new vscode.Position(node.endPosition.row, node.endPosition.column)
			)
		)
	}
}

async function checkCode(doc: vscode.TextDocument, sourceCode: string, /*edit?: treesitter.Edit, */) {
	let docAnalysisState = documentAnalysisStates.get(doc.uri);

	if (!docAnalysisState) {
		docAnalysisState = {
			results: [],
			done: true
		};

		documentAnalysisStates.set(doc.uri, docAnalysisState);
	}

	// const data = retrieveTextForFastAnalysis(acitveDoc, edit);
	// const sourceCode = data.text;
	// const firstLineNo = data.startLine + 1;

	if (docAnalysisState.done) {
		docAnalysisState.done = false;

		inspectCode(sourceCode, /* firstLineNo, */ results => {
			if (!diagnosticsTree.has(doc.uri)) {
				diagnosticsTree.set(doc.uri, new RangeBinTree(
					new VSCodeRange(
						new vscode.Position(0, 0),
						new vscode.Position(Number.MAX_SAFE_INTEGER, Number.MAX_SAFE_INTEGER)
					),
					new vscode.Diagnostic(
						new vscode.Range(
							new vscode.Position(0, 0),
							new vscode.Position(Number.MAX_SAFE_INTEGER, Number.MAX_SAFE_INTEGER)
						), 
						'stub'
					)
				));
			}

			const ranges = results.map(result => {
				const line = result.location.line - 1;

				console.log(`DEBUG result: ${result.location.line}, ${result.location.snippet}`);

				const lineText = doc.getText(new vscode.Range(
					line, 0,
					line, Number.MAX_SAFE_INTEGER
				));

				if (lineText === undefined)
					return;

				const offset = lineText.indexOf(result.location.snippet);

				console.log(`DEBUG result 2: ${line}, ${offset} ${result.location.snippet.length}`);

				if (offset < 0)
					return;

				const diagnosticsRange = new VSCodeRange(
						new vscode.Position(line, offset),
						new vscode.Position(line, offset + result.location.snippet.length)
					);

				return diagnosticsRange;
			});

			ranges.forEach(r => r && diagnosticsTree.get(doc.uri)?.removeIntersecting(r));

			ranges.forEach((range, index) => {
				if (!range)
					return;

				const diag = new vscode.Diagnostic(
					new vscode.Range(range.start, range.end),
					results[index].description,
					vscode.DiagnosticSeverity.Warning
				);

				diagnosticsTree.get(doc.uri)?.addChild(
					range,
					diag
				);
			});

			const documentDiagnostics: vscode.Diagnostic[] = [];

			diagnosticsTree.get(doc.uri)?.forEachChildren(diag =>
				documentDiagnostics.push(diag)
			);

			golangDiagnosticCollection.set(
				doc.uri,
				documentDiagnostics
			);

			documentAnalysisStates.get(doc.uri)!.results = results;
		},

		() => documentAnalysisStates.get(doc.uri)!.done = true)
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
	const oldEndIndex = change.rangeOffset + change.rangeLength;
	
	const newEndIndex = change.rangeOffset + change.text.length;
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

function performCodeCheck(doc: vscode.TextDocument, requests: AnalysisRequest[]) {
	const sb = new StringBuilder();

	requests.forEach(r => {
		const startLineNumber = r.startLine + 1;

		sb.append(
			addLineComments(r.text, startLineNumber)
		);
	});

	checkCode(doc, sb.toString());
}

// This method is called when your extension is activated
// Your extension is activated the very first time the command is executed
export async function activate(context: vscode.ExtensionContext) {
	await treesitter.Parser.init();
	parser = new treesitter.Parser();
	
	const Golang = await treesitter.Language.load(context.extensionPath + '/parsers/go/tree-sitter-go.wasm');
	parser.setLanguage(Golang);

	const disposable = vscode.commands.registerCommand('aiInspection.runAnalysis', async (args?: InpectCommandArguments) => {
		let functionsForInspection: string[] = [];

		if (args) {
			functionsForInspection = args.functions;
		} else {
			const names = await vscode.window.showInputBox({
				placeHolder: 'Enter functions names separated with space',
				prompt: 'Functions to be analyzed'
			});

			console.log(names);

			if (names && names.length > 0)
				functionsForInspection = names?.split(' ');
		}

		const doc = vscode.window.activeTextEditor?.document;

		if (doc && documentStates.get(doc.uri)) {
			const docState = documentStates.get(doc.uri)!;

			if (functionsForInspection.length == 0) {
				console.log('Whole text analysis');

				performCodeCheck(doc, [{
					startLine: 0,
					text: doc.getText()
				}]);
			} else {
				const functionsRanges = findFunctionsByNames(docState.rangeTree!, functionsForInspection).map(node => ({
					startLine: node.startPosition.row,
					text: node.text
				}));

				performCodeCheck(doc, functionsRanges);
			}

			console.log(`func name: ${functionsForInspection}, ${functionsForInspection.length}`);
		}
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
			docState.rangeTree = createRangeBTreeNode(newTree?.rootNode!);

			const changeRange = new NumberRange(
				edit.startIndex,
				edit.newEndIndex
			);

			const node = findEnclosingBlock(docState.rangeTree, changeRange);

			node && performCodeCheck(
				e.document,
				[{
					startLine: node.startPosition.row,
					text: node.text	
				}]
			);
		} else {
			const tree = parser.parse(src);

			vscode.workspace.encode(src).then(
				val => documentStates.set(
					e.document.uri,
					{
						text: src,
						content: val,
						tree: tree,
						rangeTree: createRangeBTreeNode(tree?.rootNode!)
					}
				)
			);
		}
	});

	context.subscriptions.push(disposable);

	golangDiagnosticCollection = vscode.languages.createDiagnosticCollection("go");
}

// This method is called when your extension is deactivated
export function deactivate() {}
