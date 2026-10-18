import { buildApp } from '../apps/api/src/app.js';

type Built = Awaited<ReturnType<typeof buildApp>>;

let built: Built | null = null;
let initPromise: Promise<void> | null = null;

async function init(): Promise<void> {
  if (built) return;
  if (!initPromise) {
    initPromise = (async () => {
      built = await buildApp({ migrate: true });
      await built.app.ready();
    })().catch((err) => {
      initPromise = null;
      throw err;
    });
  }
  await initPromise;
}

export default async function handler(req: any, res: any): Promise<void> {
  await init();
  built!.app.server.emit('request', req, res);
}
