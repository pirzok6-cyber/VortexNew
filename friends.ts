import { Router } from 'express';
import { prisma } from '../db';
import { AuthRequest } from '../middleware/auth';
import { USER_SELECT } from '../shared';

const router = Router();

// ─── Get accepted friends list ───────────────────────────────────────
router.get('/', async (req: AuthRequest, res) => {
  try {
    const userId = req.userId!;

    const friendships = await prisma.friendship.findMany({
      where: {
        status: 'accepted',
        OR: [{ userId }, { friendId: userId }],
      },
      include: {
        user: { select: USER_SELECT },
        friend: { select: USER_SELECT },
      },
    });

    const friends = friendships.map(f => ({
      ...(f.userId === userId ? f.friend : f.user),
      friendshipId: f.id,
    }));

    res.json(friends);
  } catch (error) {
    console.error('Get friends error:', error);
    res.status(500).json({ error: 'Ошибка получения друзей' });
  }
});

// ─── Get incoming friend requests ────────────────────────────────────
router.get('/requests', async (req: AuthRequest, res) => {
  try {
    const userId = req.userId!;

    const requests = await prisma.friendship.findMany({
      where: { friendId: userId, status: 'pending' },
      include: {
        user: { select: USER_SELECT },
      },
      orderBy: { createdAt: 'desc' },
    });

    res.json(requests.map(r => ({ id: r.id, user: r.user, createdAt: r.createdAt })));
  } catch (error) {
    console.error('Get friend requests error:', error);
    res.status(500).json({ error: 'Ошибка получения заявок' });
  }
});

// ─── Get outgoing friend requests ────────────────────────────────────
router.get('/outgoing', async (req: AuthRequest, res) => {
  try {
    const userId = req.userId!;

    const requests = await prisma.friendship.findMany({
      where: { userId, status: 'pending' },
      include: {
        friend: { select: USER_SELECT },
      },
      orderBy: { createdAt: 'desc' },
    });

    res.json(requests.map(r => ({ id: r.id, user: r.friend, createdAt: r.createdAt })));
  } catch (error) {
    console.error('Get outgoing requests error:', error);
    res.status(500).json({ error: 'Ошибка получения заявок' });
  }
});

// ─── Get friendship status with a user ───────────────────────────────
router.get('/status/:userId', async (req: AuthRequest, res) => {
  try {
    const userId = req.userId!;
    const targetId = String(req.params.userId);

    if (userId === targetId) {
      res.json({ status: 'self' });
      return;
    }

    const friendship = await prisma.friendship.findFirst({
      where: {
        OR: [
          { userId, friendId: targetId },
          { userId: targetId, friendId: userId },
        ],
      },
    });

    if (!friendship) {
      res.json({ status: 'none', friendshipId: null });
      return;
    }

    // Determine who sent the request to show correct action
    const direction = friendship.userId === userId ? 'outgoing' : 'incoming';
    res.json({ status: friendship.status, friendshipId: friendship.id, direction });
  } catch (error) {
    console.error('Get friend status error:', error);
    res.status(500).json({ error: 'Ошибка получения статуса' });
  }
});

// ─── Send friend request ─────────────────────────────────────────────
router.post('/request', async (req: AuthRequest, res) => {
  try {
    const userId = req.userId!;
    const { friendId } = req.body;

    if (!friendId || typeof friendId !== 'string') {
      res.status(400).json({ error: 'ID пользователя обязателен' });
      return;
    }

    if (userId === friendId) {
      res.status(400).json({ error: 'Нельзя добавить себя в друзья' });
      return;
    }

    // Check if target user exists
    const targetUser = await prisma.user.findUnique({ where: { id: friendId } });
    if (!targetUser) {
      res.status(404).json({ error: 'Пользователь не найден' });
      return;
    }

    // Check for existing friendship in either direction
    const existing = await prisma.friendship.findFirst({
      where: {
        OR: [
          { userId, friendId },
          { userId: friendId, friendId: userId },
        ],
      },
    });

    if (existing) {
      if (existing.status === 'accepted') {
        res.status(400).json({ error: 'Уже в друзьях' });
        return;
      }
      if (existing.status === 'pending') {
        // If they already sent us a request, auto-accept
        if (existing.userId === friendId) {
          const updated = await prisma.friendship.update({
            where: { id: existing.id },
            data: { status: 'accepted' },
            include: { user: { select: USER_SELECT }, friend: { select: USER_SELECT } },
          });
          res.json({ status: 'accepted', friendship: updated });
          return;
        }
        res.status(400).json({ error: 'Заявка уже отправлена' });
        return;
      }
      if (existing.status === 'declined') {
        // Allow re-sending if previously declined — keep existing direction to avoid @@unique conflict
        const updated = await prisma.friendship.update({
          where: { id: existing.id },
          data: { status: 'pending' },
        });
        res.json({ status: 'pending', friendship: updated });
        return;
      }
    }

    const friendship = await prisma.friendship.create({
      data: { userId, friendId },
      include: { user: { select: USER_SELECT }, friend: { select: USER_SELECT } },
    });

    res.json({ status: 'pending', friendship });
  } catch (error) {
    console.error('Send friend request error:', error);
    res.status(500).json({ error: 'Ошибка отправки заявки' });
  }
});

// ─── Accept friend request ───────────────────────────────────────────
router.post('/:id/accept', async (req: AuthRequest, res) => {
  try {
    const userId = req.userId!;
    const friendshipId = String(req.params.id);

    const friendship = await prisma.friendship.findUnique({ where: { id: friendshipId } });

    if (!friendship || friendship.friendId !== userId || friendship.status !== 'pending') {
      res.status(404).json({ error: 'Заявка не найдена' });
      return;
    }

    const updated = await prisma.friendship.update({
      where: { id: friendshipId },
      data: { status: 'accepted' },
      include: { user: { select: USER_SELECT }, friend: { select: USER_SELECT } },
    });

    res.json(updated);
  } catch (error) {
    console.error('Accept friend request error:', error);
    res.status(500).json({ error: 'Ошибка принятия заявки' });
  }
});

// ─── Decline friend request ──────────────────────────────────────────
router.post('/:id/decline', async (req: AuthRequest, res) => {
  try {
    const userId = req.userId!;
    const friendshipId = String(req.params.id);

    const friendship = await prisma.friendship.findUnique({ where: { id: friendshipId } });

    if (!friendship || friendship.friendId !== userId || friendship.status !== 'pending') {
      res.status(404).json({ error: 'Заявка не найдена' });
      return;
    }

    await prisma.friendship.update({
      where: { id: friendshipId },
      data: { status: 'declined' },
    });

    res.json({ success: true });
  } catch (error) {
    console.error('Decline friend request error:', error);
    res.status(500).json({ error: 'Ошибка отклонения заявки' });
  }
});

// ─── Remove friend ───────────────────────────────────────────────────
router.delete('/:id', async (req: AuthRequest, res) => {
  try {
    const userId = req.userId!;
    const friendshipId = String(req.params.id);

    const friendship = await prisma.friendship.findUnique({ where: { id: friendshipId } });

    if (!friendship || (friendship.userId !== userId && friendship.friendId !== userId)) {
      res.status(404).json({ error: 'Дружба не найдена' });
      return;
    }

    await prisma.friendship.delete({ where: { id: friendshipId } });

    res.json({ success: true });
  } catch (error) {
    console.error('Remove friend error:', error);
    res.status(500).json({ error: 'Ошибка удаления друга' });
  }
});

export default router;
