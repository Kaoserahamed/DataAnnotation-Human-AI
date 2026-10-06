/** Process entrypoint: load config, build the server, bind, and shut down cleanly. */

import { buildApp } from './app.js';
import { ConfigError, loadConfig } from './config.js';

async function main(): Promise<void> {
  const config = loadConfig();
  const { app } = await buildApp({ config });

  const shutdown = (signal: string): void => {
    app.log.info({ signal }, 'shutting down');
    void app
      .close()
      .then(() => process.exit(0))
      .catch((error: unknown) => {
        app.log.error({ err: error }, 'shutdown failed');
        process.exit(1);
      });
  };
  process.on('SIGINT', () => shutdown('SIGINT'));
  process.on('SIGTERM', () => shutdown('SIGTERM'));

  await app.listen({ host: config.HOST, port: config.PORT });
}

main().catch((error: unknown) => {
  if (error instanceof ConfigError) {
    console.error(`configuration error: ${error.message}`);
  } else {
    console.error('failed to start API:', error);
  }
  process.exit(1);
});
