/** Cosmetics shop (docs/economy.md#shop): purchases, equipping, guests, persistence, loadout broadcast. */
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, before, describe, it } from 'node:test';
import { Worker } from 'node:worker_threads';
import { COSMETIC_SLOTS, cosmeticPrice, emptyLoadout, getCosmetic, LOOTBOX, lootItems, PROTOCOL_VERSION, pts, shopItems } from '@surf/shared';
import { Db } from './db.ts';
import { world } from './economy-helpers.ts';
import type { GameServer } from './server.ts';
import { startServer } from './server.ts';
import { BOX_NEWS_MS, Shop, type ShopPlayer } from './shop.ts';
import { sleep, TestClient, testMap } from './test-helpers.ts';

const PRICE = pts(30);
const give = (db: Db, accountId: number, tenths: number) =>
	db.payPoints({ accountId, at: 1, mode: 'surf', map: 'm', reason: 'playtime', label: 'x', base: tenths, counted: 0, mult: 10, amount: tenths });
const buyArgs = (accountId: number, item: string, amount = PRICE) => ({ accountId, at: 5, reason: `shop:${item}`, label: 'x', amount });

describe('buying (database)', () => {
	it('deducts, logs and grants together; refuses duplicates and missing coins', () => {
		const db = new Db(':memory:');
		const id = db.createAccount('Ana', 'h')!.id;
		assert.equal(db.buyItem(buyArgs(id, 'hat_cap'), 'hat_cap'), 'poor', 'no stats row yet');
		give(db, id, PRICE * 2 - 1);
		assert.equal(db.buyItem(buyArgs(id, 'hat_cap'), 'hat_cap'), 'ok');
		assert.equal(db.buyItem(buyArgs(id, 'hat_cap'), 'hat_cap'), 'owned');
		assert.equal(db.buyItem(buyArgs(id, 'hat_straw'), 'hat_straw'), 'poor', '0.1 coin short');
		assert.deepEqual(db.ownedItems(id), ['hat_cap']);
		assert.deepEqual(db.accountStats(id), { playtimeSecs: 0, pointsTotal: PRICE * 2 - 1, pointsBalance: PRICE - 1 });
		const log = db.recentPoints(id, 10).filter((r) => r.reason.startsWith('shop:'));
		assert.deepEqual(log.map((r) => [r.reason, r.amount]), [['shop:hat_cap', -PRICE]]);
		assert.equal(db.buyItem(buyArgs(999, 'hat_cap'), 'hat_cap'), 'poor', 'no such account');
		db.close();
	});

	it('nothing is taken when granting fails', () => {
		const db = new Db(':memory:');
		const id = db.createAccount('Ana', 'h')!.id;
		give(db, id, PRICE);
		db.db.exec(`CREATE TRIGGER boom BEFORE INSERT ON owned_items BEGIN SELECT RAISE(ABORT, 'boom'); END`);
		assert.throws(() => db.buyItem(buyArgs(id, 'hat_cap'), 'hat_cap'), /boom/);
		assert.equal(db.accountStats(id).pointsBalance, PRICE);
		assert.equal(db.recentPoints(id, 10).length, 1);
		db.close();
	});

	it('concurrent buyers on separate connections: one purchase, one payment', async () => {
		const dir = mkdtempSync(join(tmpdir(), 'surf-shop-'));
		const path = join(dir, 'surf.db');
		try {
			const db = new Db(path);
			const id = db.createAccount('Ana', 'h')!.id;
			give(db, id, PRICE * 3);
			const gate = new Int32Array(new SharedArrayBuffer(4));
			const code = `
				import { workerData, parentPort } from 'node:worker_threads';
				const { Db } = await import(workerData.db);
				const db = new Db(workerData.path);
				parentPort.postMessage('ready');
				Atomics.wait(workerData.gate, 0, 0);
				const out = [];
				for (let i = 0; i < 20; i++) out.push(db.buyItem(workerData.args, 'hat_cap'));
				db.close();
				parentPort.postMessage(out);`;
			const results: string[] = [];
			const workers = Array.from(
				{ length: 3 },
				() =>
					new Worker(new URL(`data:text/javascript,${encodeURIComponent(code)}`), {
						workerData: { db: new URL('./db.ts', import.meta.url).href, path, gate, args: buyArgs(id, 'hat_cap') }
					})
			);
			const done = workers.map(
				(w) =>
					new Promise<void>((ok, fail) => {
						w.on('message', (m: string | string[]) => {
							if (Array.isArray(m)) results.push(...m);
						});
						w.on('error', fail);
						w.on('exit', () => ok());
					})
			);
			await Promise.race([Promise.all(workers.map((w) => new Promise((ok) => w.once('message', ok)))), Promise.all(done)]);
			Atomics.store(gate, 0, 1);
			Atomics.notify(gate, 0);
			await Promise.all(done);
			assert.equal(results.length, 60);
			assert.equal(results.filter((r) => r === 'ok').length, 1);
			assert.equal(results.filter((r) => r === 'owned').length, 59);
			assert.equal(db.accountStats(id).pointsBalance, PRICE * 2);
			assert.deepEqual(db.ownedItems(id), ['hat_cap']);
			db.close();
		} finally {
			rmSync(dir, { recursive: true, force: true });
		}
	});

	it('equips owned items only, one per slot; rows go with the account', () => {
		const db = new Db(':memory:');
		const id = db.createAccount('Ana', 'h')!.id;
		give(db, id, PRICE * 2);
		assert.equal(db.equip(id, 'hat', 'hat_cap'), false);
		db.buyItem(buyArgs(id, 'hat_cap'), 'hat_cap');
		db.buyItem(buyArgs(id, 'hat_straw'), 'hat_straw');
		assert.equal(db.equip(id, 'hat', 'hat_cap'), true);
		assert.equal(db.equip(id, 'hat', 'hat_straw'), true);
		assert.deepEqual(db.equipped(id), { hat: 'hat_straw' });
		assert.equal(db.equip(id, 'hat', null), true);
		assert.deepEqual(db.equipped(id), {});
		db.equip(id, 'hat', 'hat_cap');
		db.db.prepare('DELETE FROM accounts WHERE id = ?').run(id);
		assert.deepEqual(db.ownedItems(id), []);
		assert.deepEqual(db.equipped(id), {});
		db.close();
	});

	it('a database of the previous schema gets the new tables and keeps its coins', () => {
		const dir = mkdtempSync(join(tmpdir(), 'surf-shop-'));
		const path = join(dir, 'surf.db');
		try {
			// The previous schema is this one without the two tables.
			const old = new Db(path);
			const id = old.createAccount('Ana', 'h')!.id;
			give(old, id, PRICE);
			old.db.exec('DROP TABLE equipped; DROP TABLE owned_items;');
			const rows = old.db.prepare('SELECT * FROM point_log').all();
			old.close();
			for (let i = 0; i < 2; i++) {
				const db = new Db(path);
				assert.deepEqual(db.db.prepare('SELECT * FROM point_log').all(), rows);
				assert.equal(db.accountStats(id).pointsBalance, PRICE);
				assert.deepEqual(db.ownedItems(id), []);
				db.close();
			}
			const db = new Db(path);
			assert.equal(db.buyItem(buyArgs(id, 'hat_cap'), 'hat_cap'), 'ok');
			db.equip(id, 'hat', 'hat_cap');
			assert.equal(db.db.pragma('integrity_check', { simple: true }), 'ok');
			assert.deepEqual(db.db.pragma('foreign_key_check'), []);
			db.close();
			const again = new Db(path);
			assert.deepEqual(again.equipped(id), { hat: 'hat_cap' });
			again.close();
		} finally {
			rmSync(dir, { recursive: true, force: true });
		}
	});

	it('Economy.buy takes the price of the rarity and refuses unsold items', () => {
		const w = world(testMap());
		const [p] = w.join(1);
		give(w.db, p!.accountId!, PRICE * 2);
		assert.equal(w.economy.buy(p!.accountId!, getCosmetic('top_default')!), 'unknown');
		const before = w.sent(p!, 'coins').length;
		assert.equal(w.economy.buy(p!.accountId!, getCosmetic('top_sunset')!), 'ok');
		const coins = w.sent(p!, 'coins').slice(before);
		assert.equal(coins.length, 1);
		assert.equal(coins[0]!.balance, PRICE);
		assert.equal(coins[0]!.recent[0]!.label, 'Shop: Sunset tee');
	});
});

describe('shop on the server', () => {
	let server: GameServer;
	let dir: string;
	const clients: TestClient[] = [];
	const boot = () => startServer({ port: 0, host: '127.0.0.1', dbPath: join(dir, 'surf.db'), maps: [testMap()], initialMap: 'surf_test', log: () => {} });
	const connect = async (name: string, token?: string) => {
		const c = new TestClient(server.port);
		clients.push(c);
		const welcome = await c.hello(name, undefined, token);
		return { c, welcome };
	};
	const register = async (name: string, coins: number) => {
		const { c, welcome } = await connect(`${name}Guest`);
		const a = await c.auth('register', name, 'secret1');
		assert.ok(a.ok);
		const account = server.db.accountByName(name)!;
		// Without the welcome bonus.
		server.db.db.prepare('UPDATE account_stats SET points_balance = 0 WHERE account_id = ?').run(account.id);
		if (coins) give(server.db, account.id, coins);
		return { c, id: welcome.selfId, accountId: account.id, token: a.ok ? a.token! : '' };
	};
	const request = async (c: TestClient, msg: unknown) => {
		const n = c.messages.length;
		c.send(msg);
		return c.waitFor('shopResult', () => true, n);
	};

	before(async () => {
		dir = mkdtempSync(join(tmpdir(), 'surf-shop-'));
		server = await boot();
	});
	after(async () => {
		for (const c of clients) c.close();
		await server.close();
		rmSync(dir, { recursive: true, force: true });
	});

	it('guests see the stock but cannot buy or equip', async () => {
		const { c, welcome } = await connect('Guesty');
		const shop = await c.waitFor('shop');
		assert.deepEqual(shop.items, shopItems().map((i) => ({ id: i.id, price: cosmeticPrice(i) })));
		assert.deepEqual(shop.owned, []);
		assert.deepEqual(shop.loadout, emptyLoadout());
		assert.equal('loadout' in welcome.players.find((p) => p.id === welcome.selfId)!, false);
		for (const msg of [
			{ type: 'shopBuy', item: 'hat_cap' },
			{ type: 'shopEquip', slot: 'hat', item: 'hat_cap' }
		]) {
			const r = await request(c, msg);
			assert.equal(r.ok, false);
			assert.match(r.error!, /Log in/);
		}
		c.close();
	});

	it('buy, equip, broadcast to others, welcome and join, unequip, reconnect, logout', async () => {
		const { c: other } = await connect('Watcher');
		const { c, id, token } = await register('Buyer', PRICE * 2);
		let r = await request(c, { type: 'shopEquip', slot: 'hat', item: 'hat_cap' });
		assert.match(r.error!, /do not own/);
		r = await request(c, { type: 'shopBuy', item: 'hat_cap' });
		assert.equal(r.ok, true);
		assert.equal(c.of('coins').at(-1)!.balance, PRICE);
		assert.deepEqual(c.of('shop').at(-1)!.owned, ['hat_cap']);
		assert.equal(other.of('cosmetics').length, 0, 'owning is not wearing');

		r = await request(c, { type: 'shopEquip', slot: 'hat', item: 'hat_cap' });
		assert.equal(r.ok, true);
		const seen = await other.waitFor('cosmetics');
		assert.deepEqual(seen, { type: 'cosmetics', id, loadout: { ...emptyLoadout(), hat: 'hat_cap' } });
		// Wearing it again changes nothing for the others.
		await request(c, { type: 'shopEquip', slot: 'hat', item: 'hat_cap' });
		await other.barrier();
		assert.equal(other.of('cosmetics').length, 1);

		// A player who joins later gets it with the player list.
		const { c: late, welcome } = await connect('Late');
		assert.equal(welcome.players.find((p) => p.id === id)!.loadout?.hat, 'hat_cap');
		late.close();

		// Reconnect with the session: still owned and worn; others hear it with `join`.
		c.close();
		await other.waitFor('leave', (m) => m.id === id);
		const n = other.messages.length;
		const back = await connect('x', token);
		assert.equal(back.welcome.players.find((p) => p.id === back.welcome.selfId)!.loadout?.hat, 'hat_cap');
		const shop = await back.c.waitFor('shop');
		assert.deepEqual([shop.owned, shop.loadout.hat], [['hat_cap'], 'hat_cap']);
		const joined = await other.waitFor('join', (m) => m.player.id === back.welcome.selfId, n);
		assert.equal(joined.player.loadout?.hat, 'hat_cap');

		r = await request(back.c, { type: 'shopEquip', slot: 'hat', item: null });
		assert.equal(r.ok, true);
		assert.deepEqual((await other.waitFor('cosmetics', () => true, n)).loadout, emptyLoadout());
		await request(back.c, { type: 'shopEquip', slot: 'hat', item: 'hat_cap' });
		await other.barrier();

		// Logging out takes it off, logging in puts it on.
		let m = other.messages.length;
		await back.c.auth('logout');
		assert.equal((await other.waitFor('cosmetics', () => true, m)).loadout.hat, null);
		await back.c.barrier();
		assert.deepEqual(back.c.of('shop').at(-1)!.owned, []);
		m = other.messages.length;
		await back.c.auth('login', 'Buyer', 'secret1');
		assert.equal((await other.waitFor('cosmetics', () => true, m)).loadout.hat, 'hat_cap');
		back.c.close();
		other.close();
	});

	it('refuses too few coins, duplicates, unknown and malformed requests without taking coins', async () => {
		const { c, accountId } = await register('Strict', PRICE * 2 - 1);
		const bad = async (msg: unknown, re: RegExp) => {
			const r = await request(c, msg);
			assert.equal(r.ok, false);
			assert.match(r.error!, re);
			await sleep(150); // below the rate limit
		};
		assert.equal((await request(c, { type: 'shopBuy', item: 'shoes_boots' })).ok, true);
		await bad({ type: 'shopBuy', item: 'shoes_boots' }, /already own/);
		await bad({ type: 'shopBuy', item: 'hat_cap' }, /Not enough/);
		for (const item of ['nope', 'top_default', '__proto__', 5, null, {}]) await bad({ type: 'shopBuy', item }, /not available/);
		await bad({ type: 'shopEquip', slot: 'hat', item: 'shoes_boots' }, /Invalid/);
		await bad({ type: 'shopEquip', slot: 'cape', item: null }, /Invalid/);
		await bad({ type: 'shopEquip', slot: 'shoes', item: 7 }, /Invalid/);
		await bad({ type: 'shopEquip', slot: 'shoes', item: 'shoes_slides' }, /do not own/);
		assert.equal(server.db.accountStats(accountId).pointsBalance, PRICE - 1);
		assert.deepEqual(server.db.ownedItems(accountId), ['shoes_boots']);
		c.close();
	});

	it('a double click buys once; a flood is refused', async () => {
		const { c, accountId } = await register('Clicker', PRICE * 20);
		const n = c.messages.length;
		for (let i = 0; i < 30; i++) c.send({ type: 'shopBuy', item: 'top_halves' });
		const results = () => c.messages.slice(n).flatMap((m) => (m.type === 'shopResult' ? [m] : []));
		await c.until(() => results().length === 30);
		assert.equal(results().filter((m) => m.ok).length, 1);
		assert.ok(results().some((m) => /Too fast/.test(m.error ?? '')));
		assert.equal(server.db.accountStats(accountId).pointsBalance, PRICE * 19);
		c.close();
	});

	it('two tabs of one account: one purchase', async () => {
		const { c, accountId, token } = await register('Twin', PRICE * 5);
		const second = new TestClient(server.port);
		clients.push(second);
		await second.open();
		second.send({ type: 'hello', playerId: crypto.randomUUID(), name: 'y', version: PROTOCOL_VERSION, token });
		for (const x of [c, second]) x.send({ type: 'shopBuy', item: 'bottom_cargo' });
		await second.waitFor('shopResult');
		assert.equal(server.db.accountStats(accountId).pointsBalance, PRICE * 4);
		assert.deepEqual(server.db.ownedItems(accountId), ['bottom_cargo']);
		second.close();
	});

	it('loot box: charged, item granted, a duplicate gives coins back, refused when broke, guest or complete', async () => {
		const open = async (c: TestClient) => {
			const n = c.messages.length;
			c.send({ type: 'boxOpen' });
			return c.waitFor('boxResult', () => true, n);
		};
		const { c: guest } = await connect('BoxGuest');
		const g = await open(guest);
		assert.ok(!g.ok && /Log in/.test(g.error));
		guest.close();

		const all = lootItems().map((i) => i.id);
		const { c, accountId } = await register('Opener', LOOTBOX.price + 100);
		assert.deepEqual(c.of('shop').at(-1)!.box, { price: LOOTBOX.price, odds: LOOTBOX.odds, items: all });
		const r = await open(c);
		assert.ok(r.ok && !r.duplicate && r.refund === 0 && all.includes(r.item));
		assert.deepEqual(server.db.ownedItems(accountId), [r.ok && r.item]);
		assert.deepEqual(c.of('shop').at(-1)!.owned, [r.ok && r.item]);
		assert.equal(server.db.accountStats(accountId).pointsBalance, 100);
		const poor = await open(c);
		assert.ok(!poor.ok && /Not enough/.test(poor.error));
		assert.equal(server.db.accountStats(accountId).pointsBalance, 100);

		// Everything owned: refused, nothing charged.
		give(server.db, accountId, LOOTBOX.price * 2);
		for (const id of all) server.db.db.prepare('INSERT OR IGNORE INTO owned_items (account_id, item_id, bought_at, price) VALUES (?, ?, 1, 0)').run(accountId, id);
		const full = await open(c);
		assert.ok(!full.ok && /everything/.test(full.error));
		assert.equal(server.db.accountStats(accountId).pointsBalance, LOOTBOX.price * 2 + 100);
		c.close();
		await c.until(() => server.lobby.playerCount === 0);
	});

	describe('loot box news', () => {
		const open = async (c: TestClient) => {
			const n = c.messages.length;
			c.send({ type: 'boxOpen' });
			const r = await c.waitFor('boxResult', () => true, n);
			assert.ok(r.ok);
			return r as Extract<typeof r, { ok: true }>;
		};
		const reveal = (c: TestClient) => c.send({ type: 'boxRevealed' });

		it('everyone hears it, once, after the opener has seen it; duplicates are marked', async () => {
			const { c: guest } = await connect('NewsGuest');
			const { c: spec } = await connect('NewsSpec');
			spec.send({ type: 'spectate', targetId: -1 });
			const { c, id, accountId } = await register('NewsOpener', LOOTBOX.price * 2);
			const all = [guest, spec, c];
			const fromOpener = (m: { id: number; name: string }) => m.id === id && m.name === 'NewsOpener';
			const quiet = async (n: number) => {
				for (const x of all) {
					await x.barrier();
					assert.equal(x.of('boxNews').filter(fromOpener).length, n);
				}
			};
			const r = await open(c);
			await quiet(0);
			// Whatever the client claims, the server announces its own result.
			c.send({ type: 'boxRevealed', item: 'hat_2030', duplicate: true });
			for (const x of all) assert.deepEqual(await x.waitFor('boxNews', fromOpener), { type: 'boxNews', id, name: 'NewsOpener', item: r.item, duplicate: false });
			reveal(c);
			reveal(guest);
			await quiet(1);
			const rarity = getCosmetic(r.item)!.rarity;
			const said = guest.of('chat').some((m) => /^NewsOpener found .* in a loot box/.test(m.text));
			assert.equal(said, rarity === 'rare' || rarity === 'epic');

			for (const i of lootItems().slice(1)) server.db.db.prepare('INSERT OR IGNORE INTO owned_items (account_id, item_id, bought_at, price) VALUES (?, ?, 1, 0)').run(accountId, i.id);
			server.db.db.prepare('DELETE FROM owned_items WHERE account_id = ? AND item_id = ?').run(accountId, lootItems()[0]!.id);
			const nextNews = guest.messages.length;
			const d = await open(c);
			reveal(c);
			const m = await guest.waitFor('boxNews', fromOpener, nextNews);
			assert.deepEqual([m.item, m.duplicate], [d.item, d.item !== lootItems()[0]!.id]);
			for (const x of all) x.close();
			await c.until(() => server.lobby.playerCount === 0);
		});

		it('another open and a disconnect announce what is left', async () => {
			const { c: other } = await connect('NewsOther');
			const { c, id } = await register('NewsTwice', LOOTBOX.price * 2);
			const fromOpener = (m: { id: number; name: string }) => m.id === id && m.name === 'NewsTwice';
			const a = await open(c);
			const b = await open(c);
			const first = await other.waitFor('boxNews', fromOpener);
			assert.deepEqual([first.id, first.item], [id, a.item]);
			await other.barrier();
			assert.equal(other.of('boxNews').filter(fromOpener).length, 1);
			const afterClose = other.messages.length;
			c.close();
			// Earlier disconnects can have the same id. Observe this one after the barrier.
			await other.waitFor('leave', (m) => m.id === id, afterClose);
			assert.deepEqual(other.of('boxNews').filter(fromOpener).map((m) => m.item), [a.item, b.item]);
			other.close();
		});
	});

	it('loot box news: announced by itself when the opener stays silent; rare ones are said in chat', () => {
		const db = new Db(':memory:');
		const id = db.createAccount('Silent', 'x')!.id;
		give(db, id, LOOTBOX.price * 200);
		let now = 1000;
		const news: { item: string; duplicate: boolean }[] = [];
		const lines: string[] = [];
		const economy = { openBox: (a: number, item: { id: string }) => ({ duplicate: db.openBox({ accountId: a, at: 1, reason: 'x', label: 'x', amount: 1 }, item.id, { amount: 1, label: 'x' }) === 'duplicate', refund: 0 }) };
		const shop = new Shop<ShopPlayer>({
			db,
			economy: () => economy as never,
			send: () => {},
			broadcast: (m) => void (m.type === 'boxNews' && news.push(m)),
			system: (t) => lines.push(t),
			now: () => now,
			log: () => {}
		});
		const p: ShopPlayer = { id: 7, name: 'Silent', accountId: id, loadout: emptyLoadout() };
		shop.announce(p);
		shop.openBox(p);
		now += BOX_NEWS_MS - 1;
		shop.tick();
		assert.equal(news.length, 0);
		now += 1;
		shop.tick();
		shop.tick();
		assert.equal(news.length, 1);
		shop.announce(p);
		assert.equal(news.length, 1);

		for (let i = 0; i < 150; i++) {
			shop.openBox(p);
			shop.announce(p);
		}
		const rare = news.map((n) => getCosmetic(n.item)!).filter((i) => i.rarity === 'rare' || i.rarity === 'epic');
		assert.deepEqual(lines, rare.map((i) => `Silent found ${i.name} (${i.rarity === 'epic' ? 'Epic' : 'Rare'}) in a loot box.`));
		db.close();
	});

	it('loot box in the database: grant or refund, all or nothing', () => {
		const id = server.db.createAccount('BoxDb', 'x')!.id;
		give(server.db, id, 1000);
		const e = { accountId: id, at: 5, reason: 'shop:lootbox', label: 'Shop: Loot box', amount: 800 };
		const refund = { amount: 200, label: 'Duplicate: Trilby' };
		const before = server.db.accountStats(id).pointsTotal;
		assert.equal(server.db.openBox(e, 'hat_trilby', refund), 'new');
		assert.equal(server.db.openBox(e, 'hat_trilby', refund), 'poor');
		give(server.db, id, 800);
		assert.equal(server.db.openBox(e, 'hat_trilby', refund), 'duplicate');
		assert.equal(server.db.accountStats(id).pointsBalance, 400);
		assert.equal(server.db.accountStats(id).pointsTotal, before + 800, 'a refund is no lifetime point');
		assert.deepEqual(server.db.ownedItems(id), ['hat_trilby']);
		const log = server.db.recentPoints(id, 10).filter((x) => x.reason === 'shop:lootbox');
		assert.deepEqual(log.map((x) => [x.label, x.amount]), [['Duplicate: Trilby', 200], ['Shop: Loot box', -800], ['Shop: Loot box', -800]]);
	});

	it('items of a newer version are ignored and kept; everything survives a restart', async () => {
		const { c, accountId, token } = await register('Future', PRICE);
		await request(c, { type: 'shopBuy', item: 'glasses_shades' });
		await request(c, { type: 'shopEquip', slot: 'glasses', item: 'glasses_shades' });
		const raw = server.db.db;
		raw.prepare('INSERT INTO owned_items VALUES (?, ?, 1, 750)').run(accountId, 'hat_2030');
		raw.prepare('INSERT INTO equipped VALUES (?, ?, ?), (?, ?, ?)').run(accountId, 'hat', 'hat_2030', accountId, 'cape', 'hat_2030');
		for (const x of clients) x.close();
		await server.close();
		server = await boot();
		const { c: again, welcome } = await connect('z', token);
		const me = welcome.players.find((p) => p.id === welcome.selfId)!;
		assert.deepEqual(me.loadout, { ...emptyLoadout(), glasses: 'glasses_shades' });
		assert.deepEqual(Object.keys(me.loadout!), [...COSMETIC_SLOTS]);
		assert.deepEqual((await again.waitFor('shop')).owned, ['glasses_shades']);
		assert.ok(server.db.ownedItems(accountId).includes('hat_2030'), 'kept for when the server knows it');
		again.close();
	});
});
