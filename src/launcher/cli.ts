#!/usr/bin/env node

import { launchPi } from "./pi-agents.js";

const code = await launchPi(process.argv.slice(2));
process.exit(code);
