import { Router } from 'express';
import { prisma } from '../db';
import { AuthRequest } from '../middleware/auth';
import { deleteUploadedFile } from '../shared';

const router = Router();

// Get all active stories (grouped by user)
router.get('/', async (req: AuthRequest, res) => {
  try {
    const userId = req.userId!;
    const now = new Date();

    // Get accepted friends
    const friendships = await prisma.friendship.findMany({
      where: {
        status: 'accepted',
        OR: [{ userId }, { friendId: userId }],
      },
      select: { userId: true, friendId: true },
    });

    const friendIds = friendships.map(f =>
      f.userId === userId ? f.friendId : f.userId,
    );
    // Include own userId to see own stories
    friendIds.push(userId);

    const stories = await prisma.story.findMany({
      where: {
        userId: { in: friendIds },
        expiresAt: { gt: now },
      },
      include: {
        user: {
          select: { id: true, username: true, displayName: true, avatar: true },
        },
        views: {
          select: { userId: true },
        },
      },
      orderBy: { createdAt: 'asc' },
    });

    // Group by user
    interface StoryItem {
      id: string;
      type: string;
      mediaUrl: string | null;
      content: string | null;
      bgColor: string | null;
      createdAt: Date;
      expiresAt: Date;
      viewCount: number;
      viewed: boolean;
    }
    interface StoryGroupResult {
      user: typeof stories[number]['user'];
      stories: StoryItem[];
      hasUnviewed: boolean;
    }
    const grouped: Record<string, StoryGroupResult> = {};
    for (const story of stories) {
      if (!grouped[story.userId]) {
        grouped[story.userId] = {
          user: story.user,
          stories: [],
          hasUnviewed: false,
        };
      }
      const viewed = story.views.some(v => v.userId === userId);
      grouped[story.userId].stories.push({
        id: story.id,
        type: story.type,
        mediaUrl: story.mediaUrl,
        content: story.content,
        bgColor: story.bgColor,
        createdAt: story.createdAt,
        expiresAt: story.expiresAt,
        viewCount: story.views.length,
        viewed,
      });
      if (!viewed && story.userId !== userId) {
        grouped[story.userId].hasUnviewed = true;
      }
    }

    // Own stories first, then unviewed, then viewed
    const result = Object.values(grouped).sort((a, b) => {
      if (a.user.id === userId) return -1;
      if (b.user.id === userId) return 1;
      if (a.hasUnviewed && !b.hasUnviewed) return -1;
      if (!a.hasUnviewed && b.hasUnviewed) return 1;
      return 0;
    });

    res.json(result);
  } catch (error) {
    console.error('Get stories error:', error);
    res.status(500).json({ error: 'Ошибка получения историй' });
  }
});

// Create a story
router.post('/', async (req: AuthRequest, res) => {
  try {
    const userId = req.userId!;
    const { type, mediaUrl, content, bgColor } = req.body;

    // Validate mediaUrl to prevent path traversal
    if (mediaUrl) {
      if (typeof mediaUrl !== 'string' || !mediaUrl.startsWith('/uploads/') || mediaUrl.includes('..')) {
        res.status(400).json({ error: 'Недопустимый URL медиафайла' });
        return;
      }
    }

    const story = await prisma.story.create({
      data: {
        userId,
        type: type || 'text',
        mediaUrl,
        content,
        bgColor: bgColor || '#6366f1',
        expiresAt: new Date(Date.now() + 24 * 60 * 60 * 1000), // 24 hours
      },
      include: {
        user: {
          select: { id: true, username: true, displayName: true, avatar: true },
        },
        views: true,
      },
    });

    res.json(story);
  } catch (error) {
    console.error('Create story error:', error);
    res.status(500).json({ error: 'Ошибка создания истории' });
  }
});

// View a story
router.post('/:storyId/view', async (req: AuthRequest, res) => {
  try {
    const userId = req.userId!;
    const storyId = req.params.storyId as string;

    // Verify story exists and viewer is the owner or a friend
    const story = await prisma.story.findUnique({ where: { id: storyId }, select: { userId: true } });
    if (!story) {
      res.status(404).json({ error: 'История не найдена' });
      return;
    }
    if (story.userId !== userId) {
      const friendship = await prisma.friendship.findFirst({
        where: {
          status: 'accepted',
          OR: [
            { userId, friendId: story.userId },
            { userId: story.userId, friendId: userId },
          ],
        },
      });
      if (!friendship) {
        res.status(403).json({ error: 'Нет доступа' });
        return;
      }
    }

    await prisma.storyView.upsert({
      where: { storyId_userId: { storyId, userId } },
      create: { storyId, userId },
      update: {},
    });

    res.json({ ok: true });
  } catch (error) {
    console.error('View story error:', error);
    res.status(500).json({ error: 'Ошибка просмотра истории' });
  }
});

// Get story viewers
router.get('/:storyId/viewers', async (req: AuthRequest, res) => {
  try {
    const userId = req.userId!;
    const storyId = req.params.storyId as string;

    const story = await prisma.story.findUnique({ where: { id: storyId }, select: { userId: true } });
    if (!story || story.userId !== userId) {
      res.status(403).json({ error: 'Только автор может просматривать аудиторию' });
      return;
    }

    const views = await prisma.storyView.findMany({
      where: {
        storyId,
        user: { hideStoryViews: false },
      },
      include: {
        user: {
          select: { id: true, username: true, displayName: true, avatar: true },
        },
      },
      orderBy: { viewedAt: 'desc' },
    });

    res.json(views.map(v => ({
      userId: v.userId,
      username: v.user.username,
      displayName: v.user.displayName,
      avatar: v.user.avatar,
      viewedAt: v.viewedAt,
    })));
  } catch (error) {
    console.error('Get story viewers error:', error);
    res.status(500).json({ error: 'Ошибка получения просмотров' });
  }
});

// Delete own story
router.delete('/:storyId', async (req: AuthRequest, res) => {
  try {
    const userId = req.userId!;
    const storyId = req.params.storyId as string;

    const story = await prisma.story.findUnique({ where: { id: storyId } });
    if (!story || story.userId !== userId) {
      res.status(403).json({ error: 'Нет прав' });
      return;
    }

    // Delete media file if present
    if (story.mediaUrl) deleteUploadedFile(story.mediaUrl);

    await prisma.story.delete({ where: { id: storyId } });
    res.json({ ok: true });
  } catch (error) {
    console.error('Delete story error:', error);
    res.status(500).json({ error: 'Ошибка удаления истории' });
  }
});

export default router;
