/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import {
	CancellationToken,
	InlineCompletionContext,
	InlineCompletionItem,
	InlineCompletionItemProvider,
	InlineCompletionTriggerKind,
	Position,
	Range,
	TextDocument,
	window,
	workspace,
} from 'vscode';
import { v4 as uuidV4 } from 'uuid';
import { SideCarClient } from '../sidecar/client';
import { disableLoadingStatus, setLoadingStatus } from './statusBar';


export type CompletionRequest = {
	filepath: string;
	language: string;
	text: string;
	// The cursor position in the editor
	position: {
		line: number;
		character: number;
		byteOffset: number;
	};
	requestId: string;
	indentation?: string;
	clipboard?: string;
	manually?: boolean;
	id: string;
};

export type CompletionResponseChoice = {
	insertText: string;
	insertRange: {
		startPosition: {
			line: number;
			character: number;
			byteOffset: number;
		};
		endPosition: {
			line: number;
			character: number;
			byteOffset: number;
		};
	};
};

export type CompletionResponse = {
	completions: CompletionResponseChoice[];
};


type DisplayedCompletion = {
	id: string;
	completion: CompletionResponse;
	displayedAt: number;
};

// This is in ms (so we can debounce accordingly)
// we assume 250ms for the generation to be accepted and another 100ms for the response
// to be accepted, so its a good number to debounce on.
export const DEBOUNCE_DELAY = 350;

export class SidecarCompletionProvider implements InlineCompletionItemProvider {
	private static debounceTimeout: NodeJS.Timeout | undefined = undefined;
	private triggerMode: 'automatic' | 'manual' | 'disabled' = 'automatic';
	private flyingRequestController: AbortController | undefined;
	private loading = false;
	private displayedCompletion: DisplayedCompletion | null = null;
	private _sidecarClient: SideCarClient;
	private static lastRequestId: string | null = null;
	private static debouncing = false;

	public constructor(sidecarClient: SideCarClient) {
		this._sidecarClient = sidecarClient;
		this.updateConfiguration();
	}

	private getEditorIndentation(): string | undefined {
		const editor = window.activeTextEditor;
		if (!editor) {
			return undefined;
		}

		const { insertSpaces, tabSize } = editor.options;
		if (insertSpaces && typeof tabSize === 'number' && tabSize > 0) {
			return ' '.repeat(tabSize);
		} else if (!insertSpaces) {
			return '\t';
		}
		return undefined;
	}

	async checkRequestPossible(): Promise<string | null> {
		// Here we check if the request which we are working on is still valid
		// and has not been cancelled by the user
		// if the timer is still going on, we should debounce this request
		// and not let it go through
		const uuid = uuidV4();
		SidecarCompletionProvider.lastRequestId = uuid;
		if (SidecarCompletionProvider.debouncing) {
			SidecarCompletionProvider.debounceTimeout?.refresh();
			const lastUUID = await new Promise((resolve) =>
				setTimeout(() => {
					resolve(SidecarCompletionProvider.lastRequestId);
				}, DEBOUNCE_DELAY)
			);
			if (uuid !== lastUUID) {
				return null;
			}
		} else {
			SidecarCompletionProvider.debouncing = true;
			SidecarCompletionProvider.debounceTimeout = setTimeout(async () => {
				SidecarCompletionProvider.debouncing = false;
			}, DEBOUNCE_DELAY);
			return uuid;
		}
		// we do not reach this condition here but typescript is stupid
		return uuid;
	}

	async provideInlineCompletionItems(
		document: TextDocument,
		position: Position,
		context: InlineCompletionContext,
		token: CancellationToken,
	): Promise<InlineCompletionItem[] | null> {
		console.log('called to provide an inline completion here');
		const requestId = await this.checkRequestPossible();
		if (!requestId) {
			console.log('request was rejected');
			return null;
		}
		// at this point we have the request id
		if (token?.isCancellationRequested) {
			return null;
		}
		const request: CompletionRequest = {
			filepath: document.uri.fsPath,
			language: document.languageId, // https://code.visualstudio.com/docs/languages/identifiers
			text: document.getText(),
			position: {
				line: position.line,
				character: position.character,
				byteOffset: document.offsetAt(position),
			},
			requestId: SidecarCompletionProvider.lastRequestId as string,
			indentation: this.getEditorIndentation(),
			manually: context.triggerKind === InlineCompletionTriggerKind.Invoke,
			id: requestId,
		};

		const abortController = new AbortController();
		this.flyingRequestController = abortController;

		token.onCancellationRequested(() => abortController.abort());

		try {
			this.loading = true;
			// update the status bar to show that we are loading the response
			setLoadingStatus();
			const response = await this._sidecarClient.inlineCompletion(request, abortController.signal);
			this.loading = false;

			if (token?.isCancellationRequested) {
				return null;
			}

			// Now that we have the completions we can do some each checks here
			// and return when we have a new line and call it a day
			for await (const completion of response) {
				// while polling we can check if the cancellation has been requested
				// and if so we return null here
				if (token.isCancellationRequested) {
					return null;
				}
				if (completion.completions.length === 0) {
					return null;
				}
				const inlineCompletionItem = completion.completions[0];
				if (inlineCompletionItem.insertText === '') {
					continue;
				}
				// First we check if we are at the end of a line or something, so we can
				// just send the first line and call it a day, but taking care of the fact
				// that it might also be our first line range so being careful with that
				if (inlineCompletionItem.insertText.endsWith('\n') && inlineCompletionItem.insertText.length > 1) {
					// we want to remove the \n over here
					const insertText = inlineCompletionItem.insertText.slice(0, -1);
					// now we change the range end position as well
					const insertRange = new Range(
						inlineCompletionItem.insertRange.startPosition.line,
						inlineCompletionItem.insertRange.startPosition.character,
						inlineCompletionItem.insertRange.endPosition.line,
						inlineCompletionItem.insertRange.endPosition.character - 1,
					);
					const inlineCompletion: InlineCompletionItem = {
						insertText: insertText,
						range: insertRange,
					};
					// disable the status bar loading status
					disableLoadingStatus();
					// the stream might still be open, so we want to send
					// a request to the server here asking it to stop streaming
					return [inlineCompletion];
				}
			}
		} catch (error: any) {
			// in case of errors disable the loading as well
			disableLoadingStatus();
			console.log(error);
			if (this.flyingRequestController === abortController) {
				// the request was not replaced by a new request, set loading to false safely
				this.loading = false;
			}
			if (error.name !== 'AbortError') {
				console.debug('Error when providing completions', { error });
			}
		}

		return null;
	}

	private updateConfiguration() {
		if (!workspace.getConfiguration('editor').get('inlineSuggest.enabled', true)) {
			this.triggerMode = 'disabled';
		}
	}

	public handleEvent(
		event: 'show' | 'accept' | 'dismiss' | 'accept_word' | 'accept_line',
		completion?: CompletionResponse,
	) {
		if (event === 'show' && completion) {
			const comparisonId = 'completion-test'.replace('completion-', '');
			const timestamp = Date.now();
			this.displayedCompletion = {
				id: `view-${comparisonId}-at-${timestamp}`,
				completion,
				displayedAt: timestamp,
			};
			this.postEvent(event, this.displayedCompletion);
		} else if (this.displayedCompletion) {
			this.postEvent(event, this.displayedCompletion);
			this.displayedCompletion = null;
		}
	}

	private postEvent(
		event: 'show' | 'accept' | 'dismiss' | 'accept_word' | 'accept_line',
		displayedCompletion: DisplayedCompletion,
	) {
		const { id, completion, displayedAt } = displayedCompletion;
		const elapsed = Date.now() - displayedAt;
		let eventData: { type: string; select_kind?: 'line'; elapsed?: number };
		switch (event) {
			case 'show':
				eventData = { type: 'view' };
				break;
			case 'accept':
				eventData = { type: 'select', elapsed };
				break;
			case 'dismiss':
				eventData = { type: 'dismiss', elapsed };
				break;
			case 'accept_word':
				// select_kind should be 'word' but not supported by Tabby Server yet, use 'line' instead
				eventData = { type: 'select', select_kind: 'line', elapsed };
				break;
			case 'accept_line':
				eventData = { type: 'select', select_kind: 'line', elapsed };
				break;
			default:
				// unknown event type, should be unreachable
				return;
		}
		try {
			// const postBody: LogEventRequest = {
			// 	...eventData,
			// 	completion_id: completion.id,
			// 	// Assume only one choice is provided for now
			// 	choice_index: completion.choices[0]!.index,
			// 	view_id: id,
			// };
			console.debug(`Post event ${event}`, { eventData });
			// agent().postEvent(postBody);
		} catch (error: any) {
			console.debug('Error when posting event', { error });
		}
	}
}
