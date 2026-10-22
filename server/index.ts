import { createApp } from "./app.ts";
import { bootstrapAdmin } from "./bootstrap.ts";
import { config, requireConfig } from "./config.ts";
import { startAssembler } from "./assemble.ts";
import { migrate } from "./migrate.ts";
import { ensureBucket } from "./storage.ts";

requireConfig();
await migrate();
await bootstrapAdmin();
await ensureBucket();
startAssembler();
createApp().listen(config.port, config.host, () => console.log(`app listening on ${config.host}:${config.port}`));
