import { expect } from 'chai';
import { promises as fs } from 'fs';
import os from 'os';
import path from 'path';

import {
	getVpnControlKey,
	vpnControlActive,
	vpnEnableAllowed,
} from '~/lib/vpn-control-key';

const svc = (labels?: { [name: string]: string }) => ({ config: { labels } });
const warden = svc({ 'io.balena.features.dc-vpn-control': '1' });
const legacy = [svc({ 'io.balena.features.supervisor-api': '1' }), svc()];
const target = (labels: { [name: string]: string } = {}) => ({
	app: { releases: { abc: { services: { warden: { labels } } } } },
});
const oldTarget = target({ 'io.balena.features.supervisor-api': '1' });
const newTarget = target({ 'io.balena.features.dc-vpn-control': '1' });

describe('lib/vpn-control-key', () => {
	let dir: string;
	let keyPath: string;
	let prevEnv: string | undefined;

	beforeEach(async () => {
		dir = await fs.mkdtemp(path.join(os.tmpdir(), 'vpn-control-key-'));
		keyPath = path.join(dir, 'dc', 'vpn-control.key');
		prevEnv = process.env.DC_VPN_CONTROL_KEY_PATH;
		process.env.DC_VPN_CONTROL_KEY_PATH = keyPath;
	});

	afterEach(async () => {
		if (prevEnv === undefined) {
			delete process.env.DC_VPN_CONTROL_KEY_PATH;
		} else {
			process.env.DC_VPN_CONTROL_KEY_PATH = prevEnv;
		}
		await fs.rm(dir, { recursive: true, force: true });
	});

	it('creates a 64-hex key on first call', async () => {
		expect(await getVpnControlKey()).to.match(/^[0-9a-f]{64}$/);
	});

	it('returns the same key on subsequent calls', async () => {
		const first = await getVpnControlKey();
		const second = await getVpnControlKey();
		expect(second).to.equal(first);
		expect(await fs.readFile(keyPath, 'utf8')).to.equal(first);
	});

	it('returns one key for concurrent first calls', async () => {
		const keys = await Promise.all([
			getVpnControlKey(),
			getVpnControlKey(),
			getVpnControlKey(),
		]);
		expect(new Set(keys).size).to.equal(1);
	});

	it('vpnEnableAllowed accepts the key while a labelled service runs', async () => {
		const key = await getVpnControlKey();
		expect(
			await vpnEnableAllowed(key, [...legacy, warden], newTarget),
		).to.equal(true);
	});

	it('vpnEnableAllowed rejects missing, empty, wrong and longer keys while a labelled service runs', async () => {
		const key = await getVpnControlKey();
		const services = [...legacy, warden];
		expect(await vpnEnableAllowed(undefined, services, newTarget)).to.equal(
			false,
		);
		expect(await vpnEnableAllowed('', services, newTarget)).to.equal(false);
		expect(
			await vpnEnableAllowed('0'.repeat(64), services, newTarget),
		).to.equal(false);
		expect(await vpnEnableAllowed(key + 'x', services, newTarget)).to.equal(
			false,
		);
	});

	it('vpnEnableAllowed keeps the open toggle when no service carries the label (old release)', async () => {
		expect(await vpnEnableAllowed(undefined, legacy, oldTarget)).to.equal(true);
		expect(await vpnEnableAllowed(undefined, [], {})).to.equal(true);
	});

	it('vpnEnableAllowed enforces the key while only the target release carries the label', async () => {
		const key = await getVpnControlKey();
		expect(await vpnEnableAllowed(undefined, legacy, newTarget)).to.equal(
			false,
		);
		expect(await vpnEnableAllowed(undefined, [], newTarget)).to.equal(false);
		expect(await vpnEnableAllowed(key, [], newTarget)).to.equal(true);
	});

	it('vpnEnableAllowed fails closed when the target cannot be read', async () => {
		const key = await getVpnControlKey();
		expect(await vpnEnableAllowed(undefined, legacy, null)).to.equal(false);
		expect(await vpnEnableAllowed(key, legacy, null)).to.equal(true);
	});

	it('vpnControlActive needs a truthy label value', () => {
		expect(vpnControlActive([warden], {})).to.equal(true);
		expect(
			vpnControlActive(
				[svc({ 'io.balena.features.dc-vpn-control': 'true' })],
				{},
			),
		).to.equal(true);
		expect(
			vpnControlActive([svc({ 'io.balena.features.dc-vpn-control': '0' })], {}),
		).to.equal(false);
		expect(vpnControlActive(legacy, oldTarget)).to.equal(false);
		expect(
			vpnControlActive(
				legacy,
				target({ 'io.balena.features.dc-vpn-control': '0' }),
			),
		).to.equal(false);
	});
});
