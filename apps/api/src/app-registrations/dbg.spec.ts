jest.mock('pg', () => ({ Client: jest.fn().mockImplementation(() => ({ connect: async () => undefined, query: async () => ({ rows: [{name:'vector'},{name:'pg_trgm'}] }), end: async () => undefined })) }));
import { checkKvoxExtensions } from './dbgcopy';
import { buildRestoreGateContext } from '@marinoscar/platform-api/db-backup/testing';
it('x', async () => { try { console.log(await checkKvoxExtensions(buildRestoreGateContext())); } catch (e) { console.log('ERR', String(e)); } });
