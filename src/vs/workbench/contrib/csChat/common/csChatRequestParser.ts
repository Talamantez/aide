/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { CancellationToken } from 'vs/base/common/cancellation';
import { OffsetRange } from 'vs/editor/common/core/offsetRange';
import { IPosition, Position } from 'vs/editor/common/core/position';
import { Range } from 'vs/editor/common/core/range';
import { ICSChatAgentService } from 'vs/workbench/contrib/csChat/common/csChatAgents';
import { ChatRequestAgentPart, ChatRequestAgentSubcommandPart, ChatRequestDynamicReferencePart, ChatRequestSlashCommandPart, ChatRequestTextPart, ChatRequestVariablePart, IParsedChatRequest, IParsedChatRequestPart, chatAgentLeader, chatSubcommandLeader, chatFileVariableLeader } from 'vs/workbench/contrib/csChat/common/csChatParserTypes';
import { ICSChatSlashCommandService } from 'vs/workbench/contrib/csChat/common/csChatSlashCommands';
import { ICSChatVariablesService, IDynamicReference } from 'vs/workbench/contrib/csChat/common/csChatVariables';

const agentReg = /^!([\w_\-]*)(?=(\s|$|\b))/i; // An @-agent
const variableReg = /^#([\w_\-]+)(:\d+)?(?=(\s|$|\b))/i; // A #-variable with an optional numeric : arg (@response:2)
const slashReg = /\/([\w_\-]+)(?=(\s|$|\b))/i; // A / command
const variableWithArgReg = /\#([\w_\-]+):([\w_\-\.]+)(?=(\s|$|\b))/i; // A variable with a string : arg (#file:foo.ts)

export class ChatRequestParser {
	constructor(
		@ICSChatAgentService private readonly agentService: ICSChatAgentService,
		@ICSChatVariablesService private readonly variableService: ICSChatVariablesService,
		@ICSChatSlashCommandService private readonly slashCommandService: ICSChatSlashCommandService
	) { }

	async parseChatRequest(sessionId: string, message: string): Promise<IParsedChatRequest> {
		const parts: IParsedChatRequestPart[] = [];
		const references = this.variableService.getDynamicReferences(sessionId); // must access this list before any async calls

		let lineNumber = 1;
		let column = 1;
		for (let i = 0; i < message.length; i++) {
			const previousChar = message.charAt(i - 1);
			const char = message.charAt(i);
			let newPart: IParsedChatRequestPart | undefined;
			if (previousChar.match(/\s/) || i === 0) {
				if (char === chatFileVariableLeader) {
					newPart = this.tryToParseVariable(message.slice(i), i, new Position(lineNumber, column), parts) ||
						await this.tryToParseDynamicVariable(message.slice(i), i, new Position(lineNumber, column), references);
				} else if (char === chatAgentLeader) {
					newPart = this.tryToParseAgent(message.slice(i), message, i, new Position(lineNumber, column), parts);
				} else if (char === chatSubcommandLeader) {
					// TODO try to make this sync
					newPart = await this.tryToParseSlashCommand(sessionId, message.slice(i), message, i, new Position(lineNumber, column), parts);
				}
			}

			if (newPart) {
				if (i !== 0) {
					// Insert a part for all the text we passed over, then insert the new parsed part
					const previousPart = parts.at(-1);
					const previousPartEnd = previousPart?.range.endExclusive ?? 0;
					const previousPartEditorRangeEndLine = previousPart?.editorRange.endLineNumber ?? 1;
					const previousPartEditorRangeEndCol = previousPart?.editorRange.endColumn ?? 1;
					parts.push(new ChatRequestTextPart(
						new OffsetRange(previousPartEnd, i),
						new Range(previousPartEditorRangeEndLine, previousPartEditorRangeEndCol, lineNumber, column),
						message.slice(previousPartEnd, i)));
				}

				parts.push(newPart);
			}

			if (char === '\n') {
				lineNumber++;
				column = 1;
			} else {
				column++;
			}
		}

		const lastPart = parts.at(-1);
		const lastPartEnd = lastPart?.range.endExclusive ?? 0;
		if (lastPartEnd < message.length) {
			parts.push(new ChatRequestTextPart(
				new OffsetRange(lastPartEnd, message.length),
				new Range(lastPart?.editorRange.endLineNumber ?? 1, lastPart?.editorRange.endColumn ?? 1, lineNumber, column),
				message.slice(lastPartEnd, message.length)));
		}

		return {
			parts,
			text: message,
		};
	}

	private tryToParseAgent(message: string, fullMessage: string, offset: number, position: IPosition, parts: ReadonlyArray<IParsedChatRequestPart>): ChatRequestAgentPart | ChatRequestVariablePart | undefined {
		const nextVariableMatch = message.match(agentReg);
		if (!nextVariableMatch) {
			return;
		}

		const [full, name] = nextVariableMatch;
		const varRange = new OffsetRange(offset, offset + full.length);
		const varEditorRange = new Range(position.lineNumber, position.column, position.lineNumber, position.column + full.length);

		const agent = this.agentService.getAgent(name);
		if (!agent) {
			return;
		}

		if (parts.some(p => p instanceof ChatRequestAgentPart)) {
			// Only one agent allowed
			return;
		}

		// The agent must come first
		if (parts.some(p => (p instanceof ChatRequestTextPart && p.text.trim() !== '') || !(p instanceof ChatRequestAgentPart))) {
			return;
		}

		const previousPart = parts.at(-1);
		const previousPartEnd = previousPart?.range.endExclusive ?? 0;
		const textSincePreviousPart = fullMessage.slice(previousPartEnd, offset);
		if (textSincePreviousPart.trim() !== '') {
			return;
		}

		return new ChatRequestAgentPart(varRange, varEditorRange, agent);
	}

	private tryToParseVariable(message: string, offset: number, position: IPosition, parts: ReadonlyArray<IParsedChatRequestPart>): ChatRequestAgentPart | ChatRequestVariablePart | undefined {
		const nextVariableMatch = message.match(variableReg);
		if (!nextVariableMatch) {
			return;
		}

		const [full, name] = nextVariableMatch;
		const variableArg = nextVariableMatch[2] ?? '';
		const varRange = new OffsetRange(offset, offset + full.length);
		const varEditorRange = new Range(position.lineNumber, position.column, position.lineNumber, position.column + full.length);

		if (this.variableService.hasVariable(name)) {
			return new ChatRequestVariablePart(varRange, varEditorRange, name, variableArg);
		}

		return;
	}

	private async tryToParseSlashCommand(sessionId: string, remainingMessage: string, fullMessage: string, offset: number, position: IPosition, parts: ReadonlyArray<IParsedChatRequestPart>): Promise<ChatRequestSlashCommandPart | ChatRequestAgentSubcommandPart | undefined> {
		const nextSlashMatch = remainingMessage.match(slashReg);
		if (!nextSlashMatch) {
			return;
		}

		if (parts.some(p => p instanceof ChatRequestSlashCommandPart)) {
			// Only one slash command allowed
			return;
		}

		const [full, command] = nextSlashMatch;
		const slashRange = new OffsetRange(offset, offset + full.length);
		const slashEditorRange = new Range(position.lineNumber, position.column, position.lineNumber, position.column + full.length);

		const usedAgent = parts.find((p): p is ChatRequestAgentPart => p instanceof ChatRequestAgentPart);
		if (usedAgent) {
			// The slash command must come immediately after the agent
			if (parts.some(p => (p instanceof ChatRequestTextPart && p.text.trim() !== '') || !(p instanceof ChatRequestAgentPart) && !(p instanceof ChatRequestTextPart))) {
				return;
			}

			const previousPart = parts.at(-1);
			const previousPartEnd = previousPart?.range.endExclusive ?? 0;
			const textSincePreviousPart = fullMessage.slice(previousPartEnd, offset);
			if (textSincePreviousPart.trim() !== '') {
				return;
			}

			const subCommands = await usedAgent.agent.provideSlashCommands(CancellationToken.None);
			const subCommand = subCommands.find(c => c.name === command);
			if (subCommand) {
				// Valid agent subcommand
				return new ChatRequestAgentSubcommandPart(slashRange, slashEditorRange, subCommand);
			}
		} else {
			const slashCommands = this.slashCommandService.getCommands();
			const slashCommand = slashCommands.find(c => c.command === command);
			if (slashCommand) {
				// Valid standalone slash command
				return new ChatRequestSlashCommandPart(slashRange, slashEditorRange, slashCommand);
			}
		}

		return;
	}

	private async tryToParseDynamicVariable(message: string, offset: number, position: IPosition, references: ReadonlyArray<IDynamicReference>): Promise<ChatRequestDynamicReferencePart | undefined> {
		const nextVarMatch = message.match(variableWithArgReg);
		if (!nextVarMatch) {
			return;
		}

		const [full, name, arg] = nextVarMatch;
		const range = new OffsetRange(offset, offset + full.length);
		const editorRange = new Range(position.lineNumber, position.column, position.lineNumber, position.column + full.length);

		const refAtThisPosition = references.find(r =>
			r.range.startLineNumber === position.lineNumber &&
			r.range.startColumn === position.column);
		if (refAtThisPosition) {
			return new ChatRequestDynamicReferencePart(range, editorRange, name, arg, refAtThisPosition.data);
		}

		return;
	}
}
