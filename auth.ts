
import { Router } from 'express';
import bcrypt from 'bcryptjs';
import jwt from 'jsonwebtoken';
import { prisma } from '../db';
import { config } from '../config';
import { USER_SELECT } from '../shared';
import { authenticateToken, AuthRequest } from '../middleware/auth';

const router = Router();

// ✅ РЕГИСТРАЦИЯ (упрощённая, без лимитов и багов)
router.post('/register', async (req, res) => {
  try {
    const { username, displayName, password, bio } = req.body;

    if (!username || !password) {
      return res.status(400).json({ error: 'Username и пароль обязательны' });
    }

    if (!/^[a-zA-Z0-9_]{3,20}$/.test(username)) {
      return res.status(400).json({ error: 'Username: 3-20 символов, только латиница, цифры, _' });
    }

    if (password.length < 3) {
      return res.status(400).json({ error: 'Пароль слишком короткий' });
    }

    const existing = await prisma.user.findUnique({
      where: { username: username.toLowerCase() }
    });

    if (existing) {
      return res.status(400).json({ error: 'Username занят' });
    }

    const hashedPassword = await bcrypt.hash(password, 10);

    const user = await prisma.user.create({
      data: {
        username: username.toLowerCase(),
        displayName: displayName || username,
        password: hashedPassword,
        bio: bio || null,
        registrationIp: req.ip || 'unknown',
      },
      select: USER_SELECT,
    });

    const token = jwt.sign(
      { userId: user.id },
      config.jwtSecret,
      { expiresIn: '30d' }
    );

    res.json({ token, user: { ...user, isOnline: true } });

  } catch (error) {
    console.error('Registration error:', error);
    res.status(500).json({ error: 'Ошибка сервера' });
  }
});

// ✅ ВХОД (оставил как есть, он у тебя норм)
router.post('/login', async (req, res) => {
  try {
    const { username, password } = req.body;

    if (!username || !password) {
      res.status(400).json({ error: 'Username и пароль обязательны' });
      return;
    }

    const user = await prisma.user.findUnique({
      where: { username: username.toLowerCase() },
      select: { ...USER_SELECT, password: true },
    });

    if (!user) {
      res.status(400).json({ error: 'Неверный username или пароль' });
      return;
    }

    const validPassword = await bcrypt.compare(password, user.password);
    if (!validPassword) {
      res.status(400).json({ error: 'Неверный username или пароль' });
      return;
    }

    await prisma.user.update({
      where: { id: user.id },
      data: { isOnline: true, lastSeen: new Date() },
    });

    const token = jwt.sign({ userId: user.id }, config.jwtSecret, { expiresIn: '30d' });

    const { password: _, ...userWithoutPassword } = user;
    res.json({ token, user: { ...userWithoutPassword, isOnline: true } });

  } catch (error) {
    console.error('Login error:', error);
    res.status(500).json({ error: 'Ошибка сервера' });
  }
});

// ✅ ТЕКУЩИЙ ПОЛЬЗОВАТЕЛЬ
router.get('/me', authenticateToken, async (req: AuthRequest, res) => {
  try {
    const user = await prisma.user.findUnique({
      where: { id: req.userId },
      select: USER_SELECT,
    });

    if (!user) {
      res.status(404).json({ error: 'Пользователь не найден' });
      return;
    }

    res.json({ user });
  } catch {
    res.status(500).json({ error: 'Ошибка сервера' });
  }
});

export default router;