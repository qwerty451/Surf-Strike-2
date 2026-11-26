/** Chat command parsing (docs/gameplay.md#chat). */
export type ChatCommand =
	| { kind: 'restart' }
	| { kind: 'back' }
	/** `!map [name]`: join that map's lobby (online the server answers; solo it loads). */
	| { kind: 'map'; name: string }
	| { kind: 'top' }
	| { kind: 'pb' }
	| { kind: 'help' }
	| { kind: 'spec'; target: string }
	| { kind: 'name'; name: string }
	| { kind: 'unknown'; name: string; args: string };

export function parseChatCommand(text: string): ChatCommand | null {
	const t = text.trim();
	if (!t.startsWith('!')) return null;
	const m = /^!(\S*)\s*(.*)$/s.exec(t)!;
	const name = m[1].toLowerCase();
	const args = m[2].trim();
	switch (name) {
		case 'r':
		case 'restart':
			return { kind: 'restart' };
		case 'back':
			return { kind: 'back' };
		case 'map':
		case 'join':
			return { kind: 'map', name: args };
		case 'top':
			return { kind: 'top' };
		case 'pb':
			return { kind: 'pb' };
		case 'help':
			return { kind: 'help' };
		case 'spec':
			return { kind: 'spec', target: args };
		case 'name':
			return { kind: 'name', name: args };
		default:
			return { kind: 'unknown', name, args };
	}
}

export const CHAT_HELP =
	'Commands: !r / !restart, !back, !map [name], !top, !pb, !spec [name], !name <new name>, !help';
