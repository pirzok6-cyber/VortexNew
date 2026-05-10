/**
 * Encrypt existing unencrypted files in the uploads directory.
 *
 * Run once after enabling ENCRYPTION_KEY:
 *   npx ts-node prisma/encrypt-existing-files.ts
 *
 * Safe to re-run — skips already-encrypted files (decryption test).
 */
import '../src/config'; // loads .env & initialises encryption
import path from 'path';
import fs from 'fs';
import { isEncryptionEnabled, encryptFileInPlace, decryptFileToBuffer } from '../src/encrypt';

const UPLOADS_ROOT = path.join(__dirname, '../uploads');

function walkDir(dir: string): string[] {
  const files: string[] = [];
  if (!fs.existsSync(dir)) return files;
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      files.push(...walkDir(full));
    } else {
      files.push(full);
    }
  }
  return files;
}

async function main() {
  if (!isEncryptionEnabled()) {
    console.error('❌ ENCRYPTION_KEY не задан в .env — сначала укажите ключ шифрования.');
    process.exit(1);
  }

  console.log('🔒 Начало шифрования файлов в uploads/…\n');

  const allFiles = walkDir(UPLOADS_ROOT);
  console.log(`📁 Найдено ${allFiles.length} файлов`);

  let encrypted = 0;
  let skipped = 0;

  for (const filePath of allFiles) {
    const relPath = path.relative(UPLOADS_ROOT, filePath);
    try {
      // Try to decrypt — if it works, file is already encrypted
      const decrypted = decryptFileToBuffer(filePath);
      if (decrypted !== null) {
        skipped++;
        continue;
      }

      // File is not encrypted — encrypt it
      encryptFileInPlace(filePath);
      encrypted++;
      process.stdout.write(`  ✔ ${encrypted} зашифровано, ${skipped} пропущено\r`);
    } catch (e) {
      console.error(`\n  ❌ Ошибка с файлом ${relPath}:`, e);
    }
  }

  console.log(`\n\n✅ Готово! Зашифровано ${encrypted} файлов, пропущено ${skipped} (уже зашифрованы).`);
}

main().catch((e) => {
  console.error('Ошибка:', e);
  process.exit(1);
});
