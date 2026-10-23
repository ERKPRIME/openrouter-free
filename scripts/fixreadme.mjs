import { readFileSync, writeFileSync } from 'fs';
let s = readFileSync('README.md','utf8');
s = s.replace('on macOS or Linux.','on macOS, Linux, or Windows. On Windows, run `./scripts/install.sh` from Git Bash.');
writeFileSync('README.md', s);
console.log('done');
