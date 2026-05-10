/**
 * Migrate existing plain-text messages to encrypted form.
 *
 * Run once after enabling ENCRYPTION_KEY:
 *   npx ts-node prisma/encrypt-existing.ts
 *
 * Safe to re-run — skips already-encrypted messages ("enc:v1:" prefix).
 */
import '../src/config'; // loads .env & initialises encryption
import { PrismaClient } from '@prisma/client';
import { encryptText, isEncryptionEnabled } from '../src/encrypt';

// Use raw PrismaClient to bypass the encryption middleware (avoid double-encryption)
const rawPrisma = new PrismaClient();

async function main() {
  if (!isEncryptionEnabled()) {
    console.error('❌ ENCRYPTION_KEY не задан в .env — сначала укажите ключ шифрования.');
    process.exit(1);
  }

  console.log('🔒 Начало шифрования существующих сообщений…\n');

  // We bypass the Prisma middleware by using $queryRawUnsafe for the SELECT,
  // then use raw UPDATE to avoid double-encryption via middleware.
  const messages: Array<{ id: string; content: string | null; quote: string | null }> =
    await rawPrisma.$queryRaw`
      SELECT id, content, quote FROM "Message"
      WHERE (content IS NOT NULL AND content != '' AND content NOT LIKE 'enc:v1:%')
         OR (quote IS NOT NULL AND quote != '' AND quote NOT LIKE 'enc:v1:%')
    `;

  console.log(`📝 Найдено ${messages.length} незашифрованных сообщений`);

  let encrypted = 0;
  const BATCH_SIZE = 500;

  for (let i = 0; i < messages.length; i += BATCH_SIZE) {
    const batch = messages.slice(i, i + BATCH_SIZE);
    await rawPrisma.$transaction(
      batch.map((msg) => {
        const newContent = msg.content && !msg.content.startsWith('enc:v1:')
          ? encryptText(msg.content) : null;
        const newQuote = msg.quote && !msg.quote.startsWith('enc:v1:')
          ? encryptText(msg.quote) : null;

        return rawPrisma.$executeRaw`
          UPDATE "Message"
          SET content = COALESCE(${newContent}::text, content),
              quote   = COALESCE(${newQuote}::text, quote)
          WHERE id = ${msg.id}
        `;
      })
    );
    encrypted += batch.length;
    process.stdout.write(`  ✔ ${encrypted}/${messages.length}\r`);
  }

  console.log(`\n\n✅ Готово! Зашифровано ${encrypted} сообщений.`);
  console.log('⚠  СОХРАНИТЕ КЛЮЧ ENCRYPTION_KEY В НАДЁЖНОМ МЕСТЕ — без него данные не восстановить!');
  await rawPrisma.$disconnect();
}

main().catch((e) => {
  console.error('Ошибка миграции:', e);
  process.exit(1);
});
