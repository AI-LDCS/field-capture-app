# Documentation

Start with the [main README](../README.md) for what the system is and how to run it.

| I want to... | Read |
| --- | --- |
| understand how it is built | [Architecture](architecture.md) |
| see the tables, rules and state machines | [Data model](data-model.md) |
| call or review an endpoint | [API reference](api.md) |
| understand recording, upload, recovery and completion | [Field flow](field-flow.md) |
| judge whether it is safe to expose | [Security](security.md) |
| change a setting or threshold | [Configuration](configuration.md) |
| put it on a server | [Deployment](deployment.md) |
| keep it running, back it up, fix it | [Operations](operations.md) |
| run or write tests | [Testing](testing.md) |
| learn why things are the way they are | [Decisions](decisions.md) |
| know what is missing and what is next | [Roadmap](roadmap.md) |
| use it as an administrator | [Admin guide](admin-guide.md) |
| use it as a field worker | [Worker guide](worker-guide.md) |

The API reference and the environment-variable list are checked by a test (`test/docs.test.ts`) so they cannot silently fall behind the code.
