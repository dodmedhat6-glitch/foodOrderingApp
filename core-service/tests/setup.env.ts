import 'reflect-metadata'
import {config} from 'dotenv';
import path from 'path';

// .env.test lives at the core-service root, one level up from tests/.
// It must load before src/lib/config/env.ts pulls in .env, because dotenv
// does not overwrite variables that are already set.
config({path: path.resolve(__dirname, '../.env.test')});
