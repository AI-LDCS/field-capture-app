import { createApp } from "./app.ts";
import { bootstrapAdmin } from "./auth/bootstrap.ts";
import { config, requireConfig } from "./config.ts";
import { startAssembler } from "./services/assemble.ts";
import { startAnonymizeSweep } from "./services/anonymize.ts";
import { migrate } from "./migrate.ts";
import { ensureBucket } from "./services/storage.ts";

requireConfig();
await migrate();
await bootstrapAdmin();
await ensureBucket();
startAssembler();
startAnonymizeSweep();
createApp().listen(config.port, config.host, () => console.log(`app listening on ${config.host}:${config.port}`));
