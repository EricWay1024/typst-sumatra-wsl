// All PDF extraction and SyncTeX generation run in this low-priority process.
import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { sourceMap } from './typst-sumatra.mjs';

const [pdf, metadataFile, pointsFile, mapFile] = process.argv.slice(2);
const here = path.dirname(fileURLToPath(import.meta.url));
const pages = JSON.parse(execFileSync('python3', [path.join(here, 'extract-boxes.py'), pdf], { maxBuffer: 64 * 1024 * 1024 }));
const result = sourceMap(pages, metadataFile, false);
fs.writeFileSync(pointsFile, JSON.stringify(result.points));
fs.writeFileSync(mapFile, result.plain);
