/** Plattform der Test-App: gebundene Bausteine für die Module (wie `src/platform.ts` einer App). */
import { definePlatform } from '../../src/index.ts';
import { model } from './model.ts';
import { resources } from './resources.ts';

export const platform = definePlatform({ product: 'probe', title: 'Probe', model, resources });
export const { record, enqueue, emit, fullTx } = platform;
