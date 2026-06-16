#!/usr/bin/env node
// Entry shim: register the tsx loader, then run the TypeScript CLI. Keeps the
// CLI authored in TS (typed + linted) while staying `node`-runnable when
// installed or published (e.g. `npx @cognisphere/cognisphere-harness init`).
import { tsImport } from "tsx/esm/api";

await tsImport("../cli/index.ts", import.meta.url);
