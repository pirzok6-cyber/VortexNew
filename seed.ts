import { PrismaClient } from '@prisma/client';
import bcrypt from 'bcryptjs';

const prisma = new PrismaClient();

async function main() {
  console.log('Заполнение базы данных...\n');

  const password = await bcrypt.hash('demo123', 10);

  const usersData = [
    { username: 'evgeniy', displayName: 'Евгений', bio: 'Создатель Vortex' },
    { username: 'anastasia', displayName: 'Анастасия', bio: 'Дизайнер интерфейсов' },
    { username: 'artem', displayName: 'Артём', bio: 'Frontend разработчик' },
    { username: 'polina', displayName: 'Полина', bio: 'Backend разработчик' },
    { username: 'daniil', displayName: 'Даниил', bio: 'DevOps инженер' },
    { username: 'vladimir', displayName: 'Владимир', bio: 'Product Manager' },
  ];

  const users = await Promise.all(
    usersData.map((u) =>
      prisma.user.upsert({
        where: { username: u.username },
        update: { displayName: u.displayName, bio: u.bio },
        create: {
          username: u.username,
          displayName: u.displayName,
          password,
          bio: u.bio,
          isOnline: false,
        },
      })
    )
  );

  console.log(`Создано ${users.length} пользователей`);

  console.log('\n--- Тестовые аккаунты ---');
  console.log('Пароль для всех: demo123\n');
  for (const user of users) {
    console.log(`  ${user.username} (${user.displayName})`);
  }
  console.log('\nЗаполнение завершено!');
}

main()
  .catch(console.error)
  .finally(() => prisma.$disconnect());
