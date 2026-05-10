/**
 * Полная очистка базы данных от тестовых данных.
 * Удаляет ВСЕ: пользователей, чаты, сообщения, истории, дружбы.
 * Таблицы и схема остаются на месте.
 *
 * Запуск: npx tsx prisma/clean-db.ts
 */

import { PrismaClient } from '@prisma/client';
import fs from 'fs';
import path from 'path';

const prisma = new PrismaClient();

async function cleanDatabase() {
  console.log('⚠️  ВНИМАНИЕ: Полная очистка базы данных!\n');

  // Удаляем в правильном порядке (зависимости → родители)
  const counts: Record<string, number> = {};

  // 1. Зависимые таблицы
  const r1 = await prisma.hiddenMessage.deleteMany();
  counts['HiddenMessage'] = r1.count;

  const r2 = await prisma.readReceipt.deleteMany();
  counts['ReadReceipt'] = r2.count;

  const r3 = await prisma.reaction.deleteMany();
  counts['Reaction'] = r3.count;

  const r4 = await prisma.pinnedMessage.deleteMany();
  counts['PinnedMessage'] = r4.count;

  const r5 = await prisma.media.deleteMany();
  counts['Media'] = r5.count;

  const r6 = await prisma.storyView.deleteMany();
  counts['StoryView'] = r6.count;

  const r7 = await prisma.story.deleteMany();
  counts['Story'] = r7.count;

  // 2. Сообщения
  const r8 = await prisma.message.deleteMany();
  counts['Message'] = r8.count;

  // 3. Чаты
  const r9 = await prisma.chatMember.deleteMany();
  counts['ChatMember'] = r9.count;

  const r10 = await prisma.chat.deleteMany();
  counts['Chat'] = r10.count;

  // 4. Дружбы
  const r11 = await prisma.friendship.deleteMany();
  counts['Friendship'] = r11.count;

  // 5. Пользователи
  const r12 = await prisma.user.deleteMany();
  counts['User'] = r12.count;

  // 6. Чистка папки uploads (кроме avatars/.gitkeep)
  const uploadsDir = path.join(__dirname, '..', 'uploads');
  let filesDeleted = 0;

  if (fs.existsSync(uploadsDir)) {
    const entries = fs.readdirSync(uploadsDir);
    for (const entry of entries) {
      const fullPath = path.join(uploadsDir, entry);
      const stat = fs.statSync(fullPath);

      if (stat.isDirectory()) {
        // Для папки avatars — очистить содержимое, но оставить папку
        if (entry === 'avatars') {
          const avatarFiles = fs.readdirSync(fullPath);
          for (const f of avatarFiles) {
            if (f === '.gitkeep') continue;
            fs.unlinkSync(path.join(fullPath, f));
            filesDeleted++;
          }
        }
      } else {
        // Файлы в корне uploads
        if (entry !== '.gitkeep') {
          fs.unlinkSync(fullPath);
          filesDeleted++;
        }
      }
    }
  }

  // Вывод результатов
  console.log('┌──────────────────────────────────────┐');
  console.log('│     🧹 База данных очищена!          │');
  console.log('├──────────────────────────────────────┤');
  for (const [table, count] of Object.entries(counts)) {
    if (count > 0) {
      console.log(`│  ${table.padEnd(20)} ${String(count).padStart(6)} удалено  │`);
    }
  }
  if (filesDeleted > 0) {
    console.log(`│  ${'Файлы (uploads)'.padEnd(20)} ${String(filesDeleted).padStart(6)} удалено  │`);
  }
  console.log('└──────────────────────────────────────┘');
  console.log('\n✅ Готово. БД чистая, можно начинать с нуля.');
}

cleanDatabase()
  .catch((e) => {
    console.error('❌ Ошибка очистки:', e);
    process.exit(1);
  })
  .finally(() => prisma.$disconnect());
