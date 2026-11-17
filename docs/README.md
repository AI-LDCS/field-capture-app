# Documentation

Start with the [main README](../README.md) for what the system is and how to run it.

## Using the app

| Page | For |
| --- | --- |
| [Admin guide](guides/admin.md) | Administrators: workers, routes, the route editor, assigning, reviewing, downloads |
| [Worker guide](guides/worker.md) | Field workers: starting a walk, recording, finishing, when something goes wrong |

## Running it

| Page | For |
| --- | --- |
| [Deployment](operations/deployment.md) | Putting it on a server (Tailscale or public), updating it |
| [Configuration](operations/configuration.md) | Environment variables and tuning constants |
| [Anonymizer](operations/anonymizer.md) | Hiding faces and plates: the GPU worker, who downloads what, failure and recovery |
| [Runbook](operations/runbook.md) | Health, backup and restore, RustFS export, troubleshooting, admin recovery |
| [Database migration plan](operations/database-migration.md) | Schema changes, Postgres upgrades, moving servers, going back |

## How it works

| Page | For |
| --- | --- |
| [Field flow](reference/field-flow.md) | GPS check, recording, recovery, upload, video assembly, completion rules |
| [API reference](reference/api.md) | Every endpoint |
| [Data model](reference/data-model.md) | Tables, database rules, state machines |
| [Security](reference/security.md) | Controls, exposure, what is not protected, the checklist before going public |

## Working on the code

| Page | For |
| --- | --- |
| [Architecture](development/architecture.md) | The parts, the request path, modules, layout rules |
| [Testing](development/testing.md) | Running and writing tests, CI, lint rules, what is not covered |
| [Decisions](development/decisions.md) | Why things are built this way |
| [Roadmap](development/roadmap.md) | Known limits and what comes next |

`test/repo/docs.test.ts` checks these pages against the code: every endpoint, environment variable, migration and audit action must be listed, and every link and file path must resolve. New pages go in one of the four folders above and get a row here.
