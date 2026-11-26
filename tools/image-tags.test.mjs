import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { it } from 'node:test';
import { fileURLToPath } from 'node:url';

it('emits bounded unique branch tags and preserves netcode and latest mappings', () => {
	const dir = mkdtempSync(join(tmpdir(), 'surf-image-tags-'));
	try {
		const script = fileURLToPath(new URL('./image-tags.sh', import.meta.url));
		const tags = (ref, type = 'branch') => {
			const output = join(dir, 'output');
			rmSync(output, { force: true });
			execFileSync('bash', [script], {
				env: { ...process.env, OWNER: 'EXample', REF_NAME: ref, REF_TYPE: type, SHA: '0123456789', GITHUB_OUTPUT: output }
			});
			return readFileSync(output, 'utf8').match(/^ghcr\.io\/example\/surf-strike-2:.+$/gm).map((line) => line.split(':')[1]);
		};

		const refs = ['latest', 'netcode', 'feat/fOO', 'feat-foo', 'x'.repeat(150) + '1', 'x'.repeat(150) + '2', '🎮'];
		const branches = refs.map((ref) => {
			const [branch, sha, ...rest] = tags(ref);
			assert.match(branch, /^branch-[a-z0-9._-]*$/);
			assert.ok(branch.length <= 128);
			assert.equal(sha, 'sha-0123456');
			assert.deepEqual(rest, []);
			return branch;
		});
		assert.equal(new Set(branches).size, refs.length);
		assert.deepEqual(tags('feat/netcode'), ['netcode', 'sha-0123456']);
		assert.equal(tags('master').at(-1), 'latest');
		assert.notEqual(tags('master', 'tag').at(-1), 'latest');
		assert.notEqual(tags('feat/netcode', 'tag')[0], 'netcode');
	} finally {
		rmSync(dir, { recursive: true, force: true });
	}
});
