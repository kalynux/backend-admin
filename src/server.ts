// Must run before any module that reads configuration at import time.
import 'dotenv/config';

import { startServer, registerShutdownHandlers } from './lifecycle';

/**
 * Process entrypoint. The lifecycle itself lives in `lifecycle.ts` so the drain sequence
 * can be asserted by `npm run verify:live` rather than only being exercised in production.
 */
startServer()
    .then(() => registerShutdownHandlers())
    .catch((error) => {
        // The logger may not exist yet — a configuration failure happens before it is
        // built — so this goes to stderr in plain text. An operator staring at a failed
        // boot needs a readable list of what is missing, not JSON.
        const message = error instanceof Error ? error.message : String(error);
        process.stderr.write(`\n[wi-admin] failed to start:\n${message}\n\n`);
        process.exit(1);
    });
