import { createApp } from "./app.ts";
import { bootstrapAdmin } from "./bootstrap.ts";
import { config, requireConfig } from "./config.ts";
import { migrate } from "./migrate.ts";

requireConfig();
await migrate();
await bootstrapAdmin();
createApp().listen(config.port, config.host, () => console.log(`app listening on ${config.host}:${config.port}`));
