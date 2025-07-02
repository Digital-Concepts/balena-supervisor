import * as config from '../config';
import * as dbus from './dbus';
import _ from 'lodash';
import log from './supervisor-console';

export const initialized = _.once(async () => {
	await config.initialized();

	const handleDiscoverability = async (conf: any) => {
		if (conf.hostDiscoverability != null) {
			try {
				await switchDiscoverability(conf.hostDiscoverability);
			} catch (err) {
				log.error('Failed to switch discoverability:', err);
			}
		}
	};
	config.on('change', handleDiscoverability);

	return () => {
		config.removeListener('change', handleDiscoverability);
	};
});

async function switchDiscoverability(discoverable: boolean) {
	try {
		if (discoverable) {
			log.info('Setting host to discoverable ... NOT');
			await dbus.stopService('avahi-daemon');
			await dbus.stopSocket('avahi-daemon');
		} else {
			log.info('Setting host to undiscoverable');
			await dbus.stopService('avahi-daemon');
			await dbus.stopSocket('avahi-daemon');
		}
	} catch (e) {
		log.error('There was an error switching host discoverability:', e);
	}
}
