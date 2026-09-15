// version-bump.cjs — Tăng patch version trong package.json rồi in ra version mới.
// Dùng bởi build.bat: for /f ... in ('node version-bump.cjs') do set VERSION=...
// (Không bundle vào app — đã loại trong electron-builder "files".)
//
// Bản phone dùng CHỦNG một kịch bản với bản PC, nhưng đọc/ghi package.json CỦA CHÍNH NÓ
// (theo __dirname). Hai app hai số phiên bản riêng, hai repo phát hành riêng — xem build.bat.
'use strict';

const fs = require('fs');
const path = require('path');

const file = path.join(__dirname, 'package.json');
const pkg = JSON.parse(fs.readFileSync(file, 'utf8'));

const p = String(pkg.version || '0.0.0').split('.').map(n => parseInt(n, 10) || 0);
while (p.length < 3) p.push(0);
p[2] = p[2] + 1;
pkg.version = p.slice(0, 3).join('.');

fs.writeFileSync(file, JSON.stringify(pkg, null, 2) + '\n');
process.stdout.write(pkg.version);
