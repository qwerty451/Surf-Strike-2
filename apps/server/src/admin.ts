/**
 * Admin menu (docs/gameplay.md#admin, docs/architecture.md#admin-and-bans).
 *
 * Admin is decided only here, on the server, by the logged-in account's
 * username (case-insensitive, ADMIN_USERNAMES), never by display name and
 * never by anything the client claims. Every `admin` message is re-checked.
 *
 * - Map enable/disable (`map_settings`): disabled maps never come up in votes,
 *   `!rtv`, random picks or the lone-player Change map; at least one map stays
 *   enabled. An admin can still force any map.
 * - Bans (`bans`), permanent or with an expiry: account bans (plus the player key of a connected target)
 *   and guest bans (player key, plus the client IP when known). Banned
 *   connections get `banned` and close code 4009. Admins cannot be banned.
 * - Coins: add to, subtract from or reset an account's balance (Economy.adjust).
 * - Every action is logged to the console and to `admin_log`.
 */
import { isIP } from 'node:net';
import type { AdminAction, AdminState, MapDef, ServerMessage } from '@surf/shared';
import { ADMIN_COINS_MAX, ADMIN_EXTEND, formatTenths, getCosmetic, mapTitle, MAX_BAN_REASON, sanitizeText, usernameKey } from '@surf/shared';
import { AttemptLimiter } from './auth.ts';
import type { BanRow, Db } from './db.ts';
export { clientIp, parseTrustProxy, type TrustProxy } from './proxy.ts';

/** Admin actions per connection per minute (beyond that: "Slow down."). */
export const ADMIN_ACTIONS_PER_MINUTE = 30;
/** Automatic warnings and bans in `adminState`. */
export const ADMIN_ABUSE_MAX = 50;

/** `ADMIN_USERNAMES` (comma-separated, case-insensitive). Unset or empty: no admins. */
export function parseAdminUsernames(raw: string | undefined): string[] {
	return (raw ?? '')
		.split(',')
		.map((s) => s.trim())
		.filter(Boolean)
		.map(usernameKey);
}

/**
 * Address for per-IP limits: IPv4 as is, IPv6 as its /64 (one household or
 * machine usually owns a whole /64, so limiting single addresses limits nothing).
 */
export function ipKey(ip: string): string {
	if (isIP(ip) !== 6) return ip;
	const [head, tail] = ip.toLowerCase().split('::') as [string, string | undefined];
	const a = head ? head.split(':') : [];
	const b = tail ? tail.split(':') : [];
	const groups = tail === undefined ? a : [...a, ...Array<string>(Math.max(0, 8 - a.length - b.length)).fill('0'), ...b];
	return `${groups.slice(0, 4).map((g) => g.replace(/^0+(?=.)/, '')).join(':')}::/64`;
}

/** What the admin module needs to know about a connection. */
export interface AdminClient {
	id: number;
	name: string;
	playerId: string;
	accountId: number | null;
	ip: string | null;
	admin: boolean;
	helloed: boolean;
}

export interface AdminHost<C extends AdminClient> {
	db: Db;
	maps: readonly MapDef[];
	clients(): Iterable<C>;
	send(c: C, msg: ServerMessage): void;
	broadcast(msg: ServerMessage): void;
	system(text: string): void;
	log(msg: string): void;
	/** Immediate map change (MapRotation.forceMap + the mapChange broadcast). */
	forceMap(mapId: string): boolean;
	/** Extend the current map; null on success, else the reason. */
	extend(seconds: number): string | null;
	/** Change an account's balance (Economy.adjust); null = no such account. */
	adjustCoins(accountId: number, amount: number | null): { delta: number; balance: number } | null;
	/** Give an item to a logged-in client; false when it is already owned. */
	giveItem(c: C, itemId: string): boolean;
	/** Take an item from a logged-in client; false when it is not owned. */
	takeItem(c: C, itemId: string): boolean;
	/** Send `banned`, close with 4009 and drop the connection. */
	kickBanned(c: C, ban: BanRow): void;
}

type Result = { ok: true; message?: string; changed?: boolean } | { ok: false; error: string };

export class AdminController<C extends AdminClient> {
	private readonly admins: Set<string>;
	private readonly disabled: Set<string>;
	private readonly limits = new WeakMap<C, AttemptLimiter>();
	private readonly denied = new WeakSet<C>();

	constructor(
		private readonly host: AdminHost<C>,
		adminUsernames: readonly string[],
		private readonly now: () => number
	) {
		this.admins = new Set(adminUsernames.map(usernameKey));
		const known = new Set(host.maps.map((m) => m.id));
		this.disabled = new Set([...host.db.disabledMaps()].filter((id) => known.has(id)));
		// A hand-edited DB with every map disabled: keep the first one playable.
		if (host.maps.length > 0 && host.maps.every((m) => this.disabled.has(m.id))) this.disabled.delete(host.maps[0].id);
	}

	/** Admin by account username only (guests are never admins). */
	isAdminAccount(username: string | null | undefined): boolean {
		return !!username && this.admins.has(usernameKey(username));
	}

	isEnabled(mapId: string): boolean {
		return !this.disabled.has(mapId);
	}

	mapsMessage(): ServerMessage {
		return { type: 'maps', enabled: this.host.maps.filter((m) => this.isEnabled(m.id)).map((m) => m.id) };
	}

	/** Ban blocking this connection: the account's ban, else (non-admins) a player key / IP ban. */
	banFor(accountId: number | null, admin: boolean, playerKey: string | null, ip: string | null): BanRow | null {
		if (admin) return null;
		const db = this.host.db;
		const t = this.now();
		const account = accountId !== null ? db.accountBan(accountId, t) : null;
		if (account && account.expiresAt === null) return account;
		const guest = db.guestBan(playerKey, ip, t);
		return guest && (!account || guest.expiresAt === null) ? guest : account;
	}

	/** Seconds until a ban lifts by itself; undefined = permanent. */
	secondsLeft(b: BanRow): number | undefined {
		return b.expiresAt === null ? undefined : Math.max(1, Math.ceil((b.expiresAt - this.now()) / 1000));
	}

	/**
	 * Automatic ban of an account for `ms` (abuse detection): stored with an
	 * expiry, connected clients are kicked. Admins are never banned.
	 */
	autoBan(accountId: number, reason: string, ms: number): void {
		const db = this.host.db;
		const account = db.accountById(accountId);
		if (!account || this.isAdminAccount(account.username)) return;
		const now = this.now();
		if (db.accountBan(accountId, now)) return;
		const target = [...this.host.clients()].find((c) => c.helloed && c.accountId === accountId);
		const ban = db.addBan({
			accountId,
			playerKey: target?.playerId || null,
			ip: null,
			usernameSnapshot: account.username,
			reason,
			createdAt: now,
			createdBy: 'auto',
			expiresAt: now + ms
		});
		if (this.kickAll(ban) > 0) this.host.system(`${account.username} was banned for ${Math.round(ms / 60_000)} minutes.`);
		this.pushState();
	}

	/** Disconnect everyone a ban covers (never admins); returns how many. */
	private kickAll(ban: BanRow): number {
		let kicked = 0;
		for (const o of [...this.host.clients()]) {
			if (!o.helloed || o.admin) continue;
			const hit =
				(ban.accountId !== null && o.accountId === ban.accountId) ||
				(ban.playerKey !== null && o.playerId === ban.playerKey) ||
				(ban.ip !== null && o.ip === ban.ip);
			if (!hit) continue;
			this.host.kickBanned(o, ban);
			kicked++;
		}
		return kicked;
	}

	state(): AdminState {
		const players: AdminState['players'] = [];
		for (const c of this.host.clients()) {
			if (!c.helloed) continue;
			players.push({
				id: c.id,
				name: c.name,
				...(c.accountId !== null ? { account: c.name } : {}),
				guest: c.accountId === null,
				admin: c.admin,
				...(c.accountId !== null
					? {
							coins: this.host.db.accountStats(c.accountId).pointsBalance,
							items: this.host.db.ownedItems(c.accountId).filter((id) => getCosmetic(id))
						}
					: {})
			});
		}
		return {
			maps: this.host.maps.map((m) => ({ id: m.id, title: m.title, kind: m.kind, size: m.size, enabled: this.isEnabled(m.id) })),
			bans: this.host.db.bans().filter((b) => b.expiresAt === null || b.expiresAt > this.now()).map((b) => ({
				id: b.id,
				username: b.usernameSnapshot,
				kind: b.accountId !== null ? 'account' : 'guest',
				reason: b.reason,
				createdAt: b.createdAt,
				createdBy: b.createdBy,
				...(b.expiresAt === null ? {} : { secondsLeft: this.secondsLeft(b) })
			})),
			players,
			abuse: this.host.db.abuseLog(ADMIN_ABUSE_MAX).map(({ accountId: _a, ...e }) => e)
		};
	}

	/** Send the current state to every connected admin (players or bans changed). */
	pushState(): void {
		let msg: ServerMessage | null = null;
		for (const c of this.host.clients()) {
			if (!c.helloed || !c.admin) continue;
			msg ??= { type: 'adminState', ...this.state() };
			this.host.send(c, msg);
		}
	}

	/** Handle an `admin` message. Non-admins get an error and nothing happens. */
	handle(c: C, raw: unknown): void {
		const reply = (r: Result) =>
			this.host.send(c, r.ok ? { type: 'adminResult', ok: true, ...(r.message ? { message: r.message } : {}) } : { type: 'adminResult', ok: false, error: r.error });
		if (!c.admin) {
			if (!this.denied.has(c)) {
				this.denied.add(c);
				this.host.log(`admin denied #${c.id} ${c.name}`);
			}
			return reply({ ok: false, error: 'You are not an admin.' });
		}
		const t = this.now();
		let lim = this.limits.get(c);
		if (!lim) this.limits.set(c, (lim = new AttemptLimiter(ADMIN_ACTIONS_PER_MINUTE)));
		if (lim.blocked('admin', t)) return reply({ ok: false, error: 'Too many admin actions. Wait a moment.' });
		lim.hit('admin', t);

		const a = raw as Partial<AdminAction> & Record<string, unknown>;
		let r: Result;
		if (!a || typeof a !== 'object' || typeof a.action !== 'string') r = { ok: false, error: 'Bad admin request.' };
		else {
			switch (a.action) {
				case 'setMapEnabled':
					r = this.setMapEnabled(c, a.mapId, a.enabled);
					break;
				case 'ban':
					r = this.ban(c, a.targetId, a.username, a.reason);
					break;
				case 'unban':
					r = this.unban(c, a.banId);
					break;
				case 'coins':
					r = this.coins(c, a.username, a.op, a.amount);
					break;
				case 'giveItem':
					r = this.giveItem(c, a.targetId, a.item);
					break;
				case 'takeItem':
					r = this.takeItem(c, a.targetId, a.item);
					break;
				case 'forceMap':
					r = this.forceMap(c, a.mapId);
					break;
				case 'extend':
					r = this.extend(c);
					break;
				case 'listBans':
					r = { ok: true };
					break;
				default:
					r = { ok: false, error: 'Unknown admin action.' };
			}
		}
		reply(r);
		if (r.ok && r.changed) this.pushState();
		else this.host.send(c, { type: 'adminState', ...this.state() });
	}

	// -----------------------------------------------------------------------

	private audit(c: C, action: string, target: string | null, detail: string | null = null): void {
		this.host.log(`admin ${c.name} (account ${c.accountId}) ${action}${target ? ` ${target}` : ''}${detail ? ` (${detail})` : ''}`);
		this.host.db.logAdmin({ accountId: c.accountId, username: c.name }, action, target, detail, Date.now());
	}

	private map(id: unknown): MapDef | undefined {
		return typeof id === 'string' ? this.host.maps.find((m) => m.id === id) : undefined;
	}

	private setMapEnabled(c: C, mapId: unknown, enabled: unknown): Result {
		const map = this.map(mapId);
		if (!map) return { ok: false, error: 'Unknown map.' };
		if (typeof enabled !== 'boolean') return { ok: false, error: 'Bad admin request.' };
		if (this.isEnabled(map.id) === enabled) return { ok: true };
		if (!enabled && this.host.maps.filter((m) => this.isEnabled(m.id)).length <= 1) {
			return { ok: false, error: 'At least one map must stay enabled.' };
		}
		if (enabled) this.disabled.delete(map.id);
		else this.disabled.add(map.id);
		this.host.db.setMapEnabled(map.id, enabled);
		this.audit(c, enabled ? 'enable-map' : 'disable-map', map.id);
		this.host.broadcast(this.mapsMessage());
		return { ok: true, changed: true, message: `${mapTitle(map)} ${enabled ? 'enabled' : 'disabled'}.` };
	}

	/** A temporary ban can still be made permanent. */
	private permanentlyBanned(accountId: number): boolean {
		return this.host.db.accountBan(accountId, this.now())?.expiresAt === null;
	}

	private ban(c: C, targetId: unknown, username: unknown, rawReason: unknown): Result {
		const reason = typeof rawReason === 'string' ? sanitizeText(rawReason, MAX_BAN_REASON) || null : null;
		const db = this.host.db;
		let ban: BanRow;
		if (typeof targetId === 'number') {
			const target = [...this.host.clients()].find((o) => o.helloed && o.id === targetId);
			if (!target) return { ok: false, error: 'That player is no longer connected.' };
			if (target === c) return { ok: false, error: "You can't ban yourself." };
			if (target.admin) return { ok: false, error: 'Admins cannot be banned.' };
			if (target.accountId !== null) {
				if (this.permanentlyBanned(target.accountId)) return { ok: false, error: `${target.name} is already banned.` };
				ban = db.addBan({
					accountId: target.accountId,
					playerKey: target.playerId || null,
					ip: null,
					usernameSnapshot: target.name,
					reason,
					createdAt: Date.now(),
					createdBy: c.name
				});
			} else {
				ban = db.addBan({
					accountId: null,
					playerKey: target.playerId || null,
					ip: target.ip,
					usernameSnapshot: target.name,
					reason,
					createdAt: Date.now(),
					createdBy: c.name
				});
			}
		} else if (typeof username === 'string' && username.trim()) {
			const account = db.accountByName(username.trim().slice(0, 64));
			if (!account) return { ok: false, error: `No account named "${username.trim().slice(0, 24)}".` };
			if (account.id === c.accountId) return { ok: false, error: "You can't ban yourself." };
			if (this.isAdminAccount(account.username)) return { ok: false, error: 'Admins cannot be banned.' };
			if (this.permanentlyBanned(account.id)) return { ok: false, error: `${account.username} is already banned.` };
			ban = db.addBan({
				accountId: account.id,
				playerKey: null,
				ip: null,
				usernameSnapshot: account.username,
				reason,
				createdAt: Date.now(),
				createdBy: c.name
			});
		} else {
			return { ok: false, error: 'Pick a player or enter a username.' };
		}
		const kind = ban.accountId !== null ? 'account' : 'guest';
		this.audit(c, 'ban', `${kind} ${ban.usernameSnapshot}`, `ban ${ban.id}${reason ? `, reason: ${reason}` : ''}`);
		const kicked = this.kickAll(ban);
		if (kicked > 0) this.host.system(`${ban.usernameSnapshot} was banned.`);
		return { ok: true, changed: true, message: `Banned ${ban.usernameSnapshot}.` };
	}

	private unban(c: C, banId: unknown): Result {
		if (typeof banId !== 'number' || !Number.isInteger(banId)) return { ok: false, error: 'Bad admin request.' };
		const ban = this.host.db.removeBan(banId);
		if (!ban) return { ok: false, error: 'No such ban.' };
		this.audit(c, 'unban', `${ban.accountId !== null ? 'account' : 'guest'} ${ban.usernameSnapshot}`, `ban ${ban.id}`);
		return { ok: true, changed: true, message: `Unbanned ${ban.usernameSnapshot}.` };
	}

	private coins(c: C, username: unknown, op: unknown, amount: unknown): Result {
		if (typeof username !== 'string' || !username.trim()) return { ok: false, error: 'Pick a player or enter a username.' };
		if (op !== 'add' && op !== 'subtract' && op !== 'reset') return { ok: false, error: 'Bad admin request.' };
		let tenths: number | null = null;
		if (op !== 'reset') {
			if (typeof amount !== 'number' || !Number.isInteger(amount) || amount < 1 || amount > ADMIN_COINS_MAX) {
				return { ok: false, error: `Enter a whole number from 1 to ${ADMIN_COINS_MAX}.` };
			}
			tenths = (op === 'add' ? 1 : -1) * amount * 10;
		}
		const account = this.host.db.accountByName(username.trim().slice(0, 64));
		const r = account && this.host.adjustCoins(account.id, tenths);
		if (!account || !r) return { ok: false, error: `No account named "${username.trim().slice(0, 24)}".` };
		const now = `${formatTenths(r.balance)} coins`;
		if (r.delta === 0) return { ok: true, message: `${account.username} already has ${now}.` };
		const change = `${r.delta > 0 ? '+' : ''}${formatTenths(r.delta)}`;
		this.audit(c, `coins-${op}`, `account ${account.username}`, `${change}, now ${formatTenths(r.balance)}`);
		return { ok: true, changed: true, message: `${account.username}: ${change} coins, now ${now}.` };
	}

	private giveItem(c: C, targetId: unknown, itemId: unknown): Result {
		const item = typeof itemId === 'string' ? getCosmetic(itemId) : undefined;
		if (!item || item.isDefault) return { ok: false, error: 'Unknown item.' };
		const target = [...this.host.clients()].find((o) => o.helloed && o.id === targetId);
		if (!target) return { ok: false, error: 'That player is no longer connected.' };
		if (target.accountId === null) return { ok: false, error: 'Guests cannot own items.' };
		if (!this.host.giveItem(target, item.id)) return { ok: false, error: `${target.name} already owns ${item.name}.` };
		this.audit(c, 'give-item', `account ${target.name}`, item.id);
		return { ok: true, changed: true, message: `${target.name} got ${item.name}.` };
	}

	private takeItem(c: C, targetId: unknown, itemId: unknown): Result {
		const item = typeof itemId === 'string' ? getCosmetic(itemId) : undefined;
		if (!item || item.isDefault) return { ok: false, error: 'Unknown item.' };
		const target = [...this.host.clients()].find((o) => o.helloed && o.id === targetId);
		if (!target) return { ok: false, error: 'That player is no longer connected.' };
		if (target.accountId === null) return { ok: false, error: 'Guests cannot own items.' };
		if (!this.host.takeItem(target, item.id)) return { ok: false, error: `${target.name} does not own ${item.name}.` };
		this.audit(c, 'take-item', `account ${target.name}`, item.id);
		return { ok: true, changed: true, message: `Removed ${item.name} from ${target.name}.` };
	}

	private forceMap(c: C, mapId: unknown): Result {
		const map = this.map(mapId);
		if (!map) return { ok: false, error: 'Unknown map.' };
		this.audit(c, 'force-map', map.id);
		this.host.system(`${c.name} (admin) changed the map.`);
		if (!this.host.forceMap(map.id)) return { ok: false, error: 'Unknown map.' };
		return { ok: true, changed: true, message: `Changed to ${mapTitle(map)}.` };
	}

	private extend(c: C): Result {
		const err = this.host.extend(ADMIN_EXTEND);
		if (err) return { ok: false, error: err };
		this.audit(c, 'extend', null, `${ADMIN_EXTEND / 60} min`);
		this.host.system(`${c.name} (admin) extended the map by ${ADMIN_EXTEND / 60} minutes.`);
		return { ok: true, message: `Extended by ${ADMIN_EXTEND / 60} minutes.` };
	}
}
