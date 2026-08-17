#!/usr/bin/env node

import { main } from "../dist/shell/index.js";

await main({ arguments: process.argv, environment: process.env });
