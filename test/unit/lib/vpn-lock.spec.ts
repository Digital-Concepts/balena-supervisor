import { expect } from 'chai';
import { promises as fs } from 'fs';
import type { SinonStub } from 'sinon';
import { stub } from 'sinon';

import { readVpnLock } from '~/lib/vpn-lock';
import log from '~/lib/supervisor-console';

function codedError(code: string): NodeJS.ErrnoException {
	const err = new Error(code) as NodeJS.ErrnoException;
	err.code = code;
	return err;
}

describe('lib/vpn-lock', () => {
	let readFile: SinonStub;
	// log.error is stubbed (and reset per-test) by the global mocha hooks; read
	// it lazily since the stub replaces the property after this module loads.
	const logError = () => log.error as SinonStub;

	beforeEach(() => {
		readFile = stub(fs, 'readFile');
	});

	afterEach(() => {
		readFile.restore();
	});

	it('returns null when no lock file exists (cloud target governs)', async () => {
		readFile.rejects(codedError('ENOENT'));
		expect(await readVpnLock()).to.equal(null);
		expect(logError().called).to.equal(false);
	});

	it('reads a valid lock file', async () => {
		readFile.resolves(
			JSON.stringify({ enabled: false, lockedAt: '2026-05-07T00:00:00.000Z' }),
		);
		const lock = await readVpnLock();
		expect(lock).to.deep.equal({
			enabled: false,
			lockedAt: '2026-05-07T00:00:00.000Z',
		});

		readFile.resolves(JSON.stringify({ enabled: true, lockedAt: 'x' }));
		expect((await readVpnLock())!.enabled).to.equal(true);
	});

	it('fails closed (VPN disabled) when the file exists but is unreadable', async () => {
		readFile.rejects(codedError('EIO'));
		const lock = await readVpnLock();
		expect(lock).to.not.equal(null);
		expect(lock!.enabled).to.equal(false);
		expect(logError().called).to.equal(true);
	});

	it('fails closed when the lock file is corrupt', async () => {
		readFile.resolves('this is not json');
		const lock = await readVpnLock();
		expect(lock).to.not.equal(null);
		expect(lock!.enabled).to.equal(false);
		expect(logError().called).to.equal(true);
	});

	it('fails closed when the lock file is missing the enabled field', async () => {
		readFile.resolves(JSON.stringify({ foo: 1 }));
		const lock = await readVpnLock();
		expect(lock).to.not.equal(null);
		expect(lock!.enabled).to.equal(false);
		expect(logError().called).to.equal(true);
	});
});
