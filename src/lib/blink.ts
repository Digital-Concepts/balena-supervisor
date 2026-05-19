import blinking from 'blinking';
import memoizee from 'memoizee';
import { exists } from './fs-utils';
import * as config from '../config';
import { ledFile } from './constants';

export type Blink = ReturnType<typeof blinking>;

const CM4_LED_PATHS = [
	'/sys/class/leds/ACT/brightness',
	'/sys/class/leds/PWR/brightness',
	'/sys/class/leds/STATUS/brightness',
];

const DEFAULT_LED_PATH = '/sys/class/leds/led0/brightness';

export const getBlink = memoizee(
	async (): Promise<Blink> => {
		const deviceType = await config.get('deviceType');
		const isCM4 = deviceType?.toLowerCase().includes('raspberrypicm4');

		if (isCM4) {
			for (const ledPath of CM4_LED_PATHS) {
				if (await exists(ledPath)) {
					return blinking(ledPath);
				}
			}
			// Fallback to default if no CM4 LED found
			if (await exists(DEFAULT_LED_PATH)) {
				return blinking(DEFAULT_LED_PATH);
			}
			return blinking('/dev/null');
		} else {
			if (!(await exists(ledFile))) {
				return blinking('/dev/null');
			}

			return blinking(ledFile);
		}
	},
	{ promise: true },
);
