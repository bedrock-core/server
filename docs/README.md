# Design notes

What is built is documented on the [docs site](https://bedrock-core.drav.dev/docs/server). This
folder holds what is not built yet, and the measurements the code's comments cite.

| Page | What it is |
| --- | --- |
| [07-capabilities](./07-capabilities.md) | One grid, many addons: a contract several addons implement with one elected owner per capability, local plugins for everything that is not shared. Proposed; four spikes first. |
| [spikes/](./spikes/) | Findings pages — every measured number a comment in `packages/*/src` relies on. |

Each spike is one probe in `packages/test-addon`, driven by a custom command, with its numbers
recorded whichever way they go. The probe is deleted once the page is written.
