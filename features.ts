import { Router } from 'express';
import { prisma } from '../db';
import { AuthRequest } from '../middleware/auth';
import { SENDER_SELECT } from '../shared';

const router = Router();

// ══════════ 1. BLOCKED USERS ═══════════════════════════════════════
router.get('/blocks', async (req: AuthRequest, res) => {
  const rows = await prisma.blockedUser.findMany({
    where: { blockerId: req.userId! },
    include: { blocked: { select: SENDER_SELECT } },
    orderBy: { createdAt: 'desc' },
  });
  res.json(rows.map(r => ({ id: r.id, user: r.blocked, createdAt: r.createdAt })));
});

router.post('/blocks/:userId', async (req: AuthRequest, res) => {
  const targetId = String(req.params.userId);
  if (targetId === req.userId) {
    res.status(400).json({ error: 'Нельзя заблокировать себя' });
    return;
  }
  const exists = await prisma.user.findUnique({ where: { id: targetId }, select: { id: true } });
  if (!exists) {
    res.status(404).json({ error: 'Пользователь не найден' });
    return;
  }
  await prisma.blockedUser.upsert({
    where: { blockerId_blockedId: { blockerId: req.userId!, blockedId: targetId } },
    create: { blockerId: req.userId!, blockedId: targetId },
    update: {},
  });
  res.json({ success: true });
});

router.delete('/blocks/:userId', async (req: AuthRequest, res) => {
  await prisma.blockedUser.deleteMany({
    where: { blockerId: req.userId!, blockedId: String(req.params.userId) },
  });
  res.json({ success: true });
});

// ══════════ 2. POLLS ═══════════════════════════════════════════════
// Create poll message
router.post('/polls', async (req: AuthRequest, res) => {
  try {
    const { chatId, question, options, multiChoice, anonymous, closesAt } = req.body as {
      chatId?: string; question?: string; options?: string[];
      multiChoice?: boolean; anonymous?: boolean; closesAt?: string;
    };
    if (!chatId || typeof question !== 'string' || question.length === 0 || question.length > 300) {
      res.status(400).json({ error: 'chatId и question (до 300 симв) обязательны' });
      return;
    }
    if (!Array.isArray(options) || options.length < 2 || options.length > 10 ||
        !options.every(o => typeof o === 'string' && o.length > 0 && o.length <= 100)) {
      res.status(400).json({ error: 'options: 2-10 строк до 100 символов' });
      return;
    }
    const member = await prisma.chatMember.findUnique({
      where: { chatId_userId: { chatId, userId: req.userId! } },
    });
    if (!member) { res.status(403).json({ error: 'Нет доступа' }); return; }

    const closeDate = closesAt ? new Date(closesAt) : null;
    if (closeDate && (isNaN(closeDate.getTime()) || closeDate.getTime() <= Date.now())) {
      res.status(400).json({ error: 'closesAt должен быть в будущем' }); return;
    }

    const message = await prisma.message.create({
      data: {
        chatId, senderId: req.userId!, type: 'poll', content: question,
        poll: {
          create: {
            question,
            multiChoice: !!multiChoice,
            anonymous: !!anonymous,
            closesAt: closeDate,
            options: { create: options.map((text, i) => ({ text, order: i })) },
          },
        },
      },
      include: {
        sender: { select: SENDER_SELECT },
        poll: { include: { options: { orderBy: { order: 'asc' } } } },
      },
    });
    res.json(message);
  } catch (e) {
    console.error('Poll create error:', e);
    res.status(500).json({ error: 'Ошибка создания опроса' });
  }
});

router.post('/polls/:pollId/vote', async (req: AuthRequest, res) => {
  try {
    const pollId = String(req.params.pollId);
    const { optionIds } = req.body as { optionIds?: string[] };
    if (!Array.isArray(optionIds) || optionIds.length === 0) {
      res.status(400).json({ error: 'optionIds обязателен' }); return;
    }
    const poll = await prisma.poll.findUnique({
      where: { id: pollId },
      include: { options: true, message: { select: { chatId: true } } },
    });
    if (!poll) { res.status(404).json({ error: 'Опрос не найден' }); return; }
    if (poll.closed || (poll.closesAt && poll.closesAt.getTime() < Date.now())) {
      res.status(400).json({ error: 'Опрос закрыт' }); return;
    }
    const member = await prisma.chatMember.findUnique({
      where: { chatId_userId: { chatId: poll.message.chatId, userId: req.userId! } },
    });
    if (!member) { res.status(403).json({ error: 'Нет доступа' }); return; }

    const validIds = new Set(poll.options.map(o => o.id));
    const toVote = optionIds.filter(id => validIds.has(id));
    if (toVote.length === 0) { res.status(400).json({ error: 'Некорректные optionIds' }); return; }
    if (!poll.multiChoice && toVote.length > 1) {
      res.status(400).json({ error: 'Опрос не мульти-выбор' }); return;
    }

    // Atomically replace the user's previous votes in this poll so a mid-op
    // failure doesn't leave the user with zero votes.
    await prisma.$transaction([
      prisma.pollVote.deleteMany({ where: { pollId, userId: req.userId! } }),
      ...toVote.map(optionId =>
        prisma.pollVote.create({
          data: { pollId, optionId, userId: req.userId! },
        })
      ),
    ]);

    const results = await prisma.pollOption.findMany({
      where: { pollId },
      include: { _count: { select: { votes: true } } },
      orderBy: { order: 'asc' },
    });
    res.json({
      pollId,
      options: results.map(o => ({ id: o.id, text: o.text, votes: o._count.votes })),
    });
  } catch (e) {
    console.error('Poll vote error:', e);
    res.status(500).json({ error: 'Ошибка голосования' });
  }
});

router.get('/polls/:pollId', async (req: AuthRequest, res) => {
  const pollId = String(req.params.pollId);
  const poll = await prisma.poll.findUnique({
    where: { id: pollId },
    include: {
      message: { select: { chatId: true } },
      options: {
        orderBy: { order: 'asc' },
        include: {
          votes: {
            include: { user: { select: SENDER_SELECT } },
          },
        },
      },
    },
  });
  if (!poll) { res.status(404).json({ error: 'Не найден' }); return; }
  const member = await prisma.chatMember.findUnique({
    where: { chatId_userId: { chatId: poll.message.chatId, userId: req.userId! } },
  });
  if (!member) { res.status(403).json({ error: 'Нет доступа' }); return; }

  const myVotes = poll.options.flatMap(o => o.votes.filter(v => v.userId === req.userId!)).map(v => v.optionId);
  res.json({
    id: poll.id,
    question: poll.question,
    multiChoice: poll.multiChoice,
    anonymous: poll.anonymous,
    closed: poll.closed || (poll.closesAt ? poll.closesAt.getTime() < Date.now() : false),
    closesAt: poll.closesAt,
    myVotes,
    options: poll.options.map(o => ({
      id: o.id, text: o.text,
      votes: o.votes.length,
      voters: poll.anonymous ? null : o.votes.map(v => v.user),
    })),
  });
});

// ══════════ 3. MENTIONS ═════════════════════════════════════════════
// Parse @username tokens, resolve to userIds, store Mention records.
// POST /features/mentions/attach — called by client after sending a message.
router.post('/mentions/attach', async (req: AuthRequest, res) => {
  try {
    const { messageId, usernames } = req.body as { messageId?: string; usernames?: string[] };
    if (!messageId || !Array.isArray(usernames)) {
      res.status(400).json({ error: 'messageId и usernames обязательны' }); return;
    }
    const msg = await prisma.message.findUnique({
      where: { id: messageId },
      select: { senderId: true, chatId: true },
    });
    if (!msg || msg.senderId !== req.userId) {
      res.status(403).json({ error: 'Нет прав' }); return;
    }
    const clean = [...new Set(usernames.map(u => String(u).toLowerCase().replace(/^@/, '')))]
      .filter(u => /^[a-z0-9_]{3,20}$/.test(u)).slice(0, 20);
    if (clean.length === 0) { res.json({ mentioned: [] }); return; }

    // Only mention users that are members of the chat
    const users = await prisma.user.findMany({
      where: {
        username: { in: clean },
        chatMembers: { some: { chatId: msg.chatId } },
      },
      select: { id: true, username: true, displayName: true },
    });

    for (const u of users) {
      await prisma.mention.upsert({
        where: { messageId_userId: { messageId, userId: u.id } },
        create: { messageId, userId: u.id },
        update: {},
      });
    }
    res.json({ mentioned: users });
  } catch (e) {
    console.error('Mention attach error:', e);
    res.status(500).json({ error: 'Ошибка' });
  }
});

// GET /features/mentions — unread mentions for current user
router.get('/mentions', async (req: AuthRequest, res) => {
  const mentions = await prisma.mention.findMany({
    where: { userId: req.userId!, read: false },
    include: {
      message: {
        include: {
          sender: { select: SENDER_SELECT },
          chat: { select: { id: true, name: true, type: true } },
        },
      },
    },
    orderBy: { createdAt: 'desc' },
    take: 100,
  });
  res.json(mentions);
});

router.post('/mentions/read', async (req: AuthRequest, res) => {
  const { messageIds } = req.body as { messageIds?: string[] };
  if (Array.isArray(messageIds) && messageIds.length > 0) {
    await prisma.mention.updateMany({
      where: { userId: req.userId!, messageId: { in: messageIds.slice(0, 200) } },
      data: { read: true },
    });
  } else {
    await prisma.mention.updateMany({
      where: { userId: req.userId! }, data: { read: true },
    });
  }
  res.json({ success: true });
});

// ══════════ 4. THREADS ══════════════════════════════════════════════
// GET /features/threads/:rootMessageId — all replies in thread
router.get('/threads/:rootMessageId', async (req: AuthRequest, res) => {
  const rootId = String(req.params.rootMessageId);
  const root = await prisma.message.findUnique({
    where: { id: rootId }, select: { chatId: true },
  });
  if (!root) { res.status(404).json({ error: 'Не найден' }); return; }
  const member = await prisma.chatMember.findUnique({
    where: { chatId_userId: { chatId: root.chatId, userId: req.userId! } },
  });
  if (!member) { res.status(403).json({ error: 'Нет доступа' }); return; }

  const replies = await prisma.message.findMany({
    where: { threadRootId: rootId, isDeleted: false },
    include: {
      sender: { select: SENDER_SELECT },
      media: true,
      reactions: true,
    },
    orderBy: { createdAt: 'asc' },
    take: 500,
  });
  res.json(replies);
});

// POST /features/threads/:rootMessageId/reply — post to thread
router.post('/threads/:rootMessageId/reply', async (req: AuthRequest, res) => {
  try {
    const rootId = String(req.params.rootMessageId);
    const { content } = req.body as { content?: string };
    if (typeof content !== 'string' || content.length === 0 || content.length > 10000) {
      res.status(400).json({ error: 'content: 1-10000 символов' }); return;
    }
    const root = await prisma.message.findUnique({
      where: { id: rootId }, select: { chatId: true, threadRootId: true },
    });
    if (!root) { res.status(404).json({ error: 'Не найден' }); return; }
    // Don't allow nested threads (replies to replies): use the outermost root
    const actualRoot = root.threadRootId || rootId;
    const member = await prisma.chatMember.findUnique({
      where: { chatId_userId: { chatId: root.chatId, userId: req.userId! } },
    });
    if (!member) { res.status(403).json({ error: 'Нет доступа' }); return; }

    const reply = await prisma.message.create({
      data: {
        chatId: root.chatId,
        senderId: req.userId!,
        content,
        type: 'text',
        threadRootId: actualRoot,
      },
      include: { sender: { select: SENDER_SELECT } },
    });
    res.json(reply);
  } catch (e) {
    console.error('Thread reply error:', e);
    res.status(500).json({ error: 'Ошибка' });
  }
});

// ══════════ 5. CHANNELS (one-way broadcast) ═════════════════════════
router.post('/channels', async (req: AuthRequest, res) => {
  try {
    const { name, description, avatar, isPublic } = req.body as {
      name?: string; description?: string; avatar?: string; isPublic?: boolean;
    };
    if (typeof name !== 'string' || name.length === 0 || name.length > 100) {
      res.status(400).json({ error: 'name: 1-100 символов' }); return;
    }
    const channel = await prisma.chat.create({
      data: {
        type: 'channel',
        name,
        description: description || null,
        avatar: avatar || null,
        isPublic: !!isPublic,
        // Creator is the admin (stored as a ChatMember with role='admin')
        members: { create: { userId: req.userId!, role: 'admin' } },
        subscribers: { create: { userId: req.userId! } },
      },
      include: { subscribers: true },
    });
    res.json(channel);
  } catch (e) {
    console.error('Channel create error:', e);
    res.status(500).json({ error: 'Ошибка создания канала' });
  }
});

router.get('/channels/discover', async (req: AuthRequest, res) => {
  const { q } = req.query;
  const channels = await prisma.chat.findMany({
    where: {
      type: 'channel',
      isPublic: true,
      ...(typeof q === 'string' && q.length > 0
        ? { OR: [{ name: { contains: q } }, { description: { contains: q } }] }
        : {}),
    },
    include: { _count: { select: { subscribers: true } } },
    take: 50,
  });
  res.json(channels.map(c => ({
    id: c.id, name: c.name, description: c.description, avatar: c.avatar,
    subscribersCount: c._count.subscribers,
  })));
});

router.post('/channels/:id/subscribe', async (req: AuthRequest, res) => {
  const chatId = String(req.params.id);
  const channel = await prisma.chat.findUnique({
    where: { id: chatId }, select: { type: true, isPublic: true },
  });
  if (!channel || channel.type !== 'channel') {
    res.status(404).json({ error: 'Канал не найден' }); return;
  }
  await prisma.channelSubscription.upsert({
    where: { chatId_userId: { chatId, userId: req.userId! } },
    create: { chatId, userId: req.userId! },
    update: {},
  });
  // Also add as chat member (read-only role) so they see posts
  await prisma.chatMember.upsert({
    where: { chatId_userId: { chatId, userId: req.userId! } },
    create: { chatId, userId: req.userId!, role: 'subscriber' },
    update: {},
  });
  res.json({ success: true });
});

router.post('/channels/:id/unsubscribe', async (req: AuthRequest, res) => {
  const chatId = String(req.params.id);
  await prisma.channelSubscription.deleteMany({ where: { chatId, userId: req.userId! } });
  // Only remove ChatMember if not an admin
  const member = await prisma.chatMember.findUnique({
    where: { chatId_userId: { chatId, userId: req.userId! } },
  });
  if (member && member.role !== 'admin') {
    await prisma.chatMember.delete({ where: { id: member.id } });
  }
  res.json({ success: true });
});

// Post to a channel (admins only)
router.post('/channels/:id/post', async (req: AuthRequest, res) => {
  try {
    const chatId = String(req.params.id);
    const { content, mediaUrl, mediaType } = req.body as {
      content?: string; mediaUrl?: string; mediaType?: string;
    };
    const channel = await prisma.chat.findUnique({
      where: { id: chatId }, select: { type: true },
    });
    if (!channel || channel.type !== 'channel') {
      res.status(404).json({ error: 'Канал не найден' }); return;
    }
    const member = await prisma.chatMember.findUnique({
      where: { chatId_userId: { chatId, userId: req.userId! } },
    });
    if (!member || member.role !== 'admin') {
      res.status(403).json({ error: 'Только админы могут публиковать' }); return;
    }
    if ((!content || content.length === 0) && !mediaUrl) {
      res.status(400).json({ error: 'content или mediaUrl обязательны' }); return;
    }
    if (typeof content === 'string' && content.length > 10000) {
      res.status(400).json({ error: 'content: до 10000 символов' }); return;
    }

    const message = await prisma.message.create({
      data: {
        chatId, senderId: req.userId!,
        content: content || null,
        type: mediaType || 'text',
        ...(mediaUrl ? {
          media: { create: { type: mediaType || 'file', url: mediaUrl } },
        } : {}),
      },
      include: {
        sender: { select: SENDER_SELECT },
        media: true,
      },
    });
    res.json(message);
  } catch (e) {
    console.error('Channel post error:', e);
    res.status(500).json({ error: 'Ошибка публикации' });
  }
});

// ══════════ 6. CHAT FOLDERS ═════════════════════════════════════════
router.get('/folders', async (req: AuthRequest, res) => {
  const folders = await prisma.chatFolder.findMany({
    where: { userId: req.userId! },
    include: { members: { select: { chatId: true, order: true } } },
    orderBy: { order: 'asc' },
  });
  res.json(folders);
});

router.post('/folders', async (req: AuthRequest, res) => {
  const { name, icon, color } = req.body as { name?: string; icon?: string; color?: string };
  if (typeof name !== 'string' || name.length === 0 || name.length > 40) {
    res.status(400).json({ error: 'name: 1-40 символов' }); return;
  }
  const count = await prisma.chatFolder.count({ where: { userId: req.userId! } });
  const folder = await prisma.chatFolder.create({
    data: {
      userId: req.userId!, name,
      icon: icon || null, color: color || null, order: count,
    },
  });
  res.json(folder);
});

router.put('/folders/:id', async (req: AuthRequest, res) => {
  const id = String(req.params.id);
  const { name, icon, color, order } = req.body as {
    name?: string; icon?: string; color?: string; order?: number;
  };
  const folder = await prisma.chatFolder.findUnique({ where: { id } });
  if (!folder || folder.userId !== req.userId) {
    res.status(404).json({ error: 'Не найдено' }); return;
  }
  const data: Record<string, unknown> = {};
  if (typeof name === 'string' && name.length > 0 && name.length <= 40) data.name = name;
  if (typeof icon === 'string' || icon === null) data.icon = icon;
  if (typeof color === 'string' || color === null) data.color = color;
  if (typeof order === 'number') data.order = order;
  const updated = await prisma.chatFolder.update({ where: { id }, data });
  res.json(updated);
});

router.delete('/folders/:id', async (req: AuthRequest, res) => {
  const id = String(req.params.id);
  const folder = await prisma.chatFolder.findUnique({ where: { id } });
  if (!folder || folder.userId !== req.userId) {
    res.status(404).json({ error: 'Не найдено' }); return;
  }
  await prisma.chatFolder.delete({ where: { id } });
  res.json({ success: true });
});

router.post('/folders/:id/chats', async (req: AuthRequest, res) => {
  const id = String(req.params.id);
  const { chatIds } = req.body as { chatIds?: string[] };
  if (!Array.isArray(chatIds) || chatIds.length === 0 || chatIds.length > 200) {
    res.status(400).json({ error: 'chatIds: 1-200' }); return;
  }
  const folder = await prisma.chatFolder.findUnique({ where: { id } });
  if (!folder || folder.userId !== req.userId) {
    res.status(404).json({ error: 'Не найдено' }); return;
  }
  // Verify user is member of each chat
  const memberships = await prisma.chatMember.findMany({
    where: { userId: req.userId!, chatId: { in: chatIds } },
    select: { chatId: true },
  });
  const valid = memberships.map(m => m.chatId);
  for (let i = 0; i < valid.length; i++) {
    await prisma.chatFolderMember.upsert({
      where: { folderId_chatId: { folderId: id, chatId: valid[i] } },
      create: { folderId: id, chatId: valid[i], order: i },
      update: {},
    });
  }
  res.json({ added: valid });
});

router.delete('/folders/:id/chats/:chatId', async (req: AuthRequest, res) => {
  const id = String(req.params.id);
  const folder = await prisma.chatFolder.findUnique({ where: { id } });
  if (!folder || folder.userId !== req.userId) {
    res.status(404).json({ error: 'Не найдено' }); return;
  }
  await prisma.chatFolderMember.deleteMany({
    where: { folderId: id, chatId: String(req.params.chatId) },
  });
  res.json({ success: true });
});

// ══════════ 7. SEARCH BY DATE ═══════════════════════════════════════
// GET /features/chats/:chatId/messages-by-date?date=YYYY-MM-DD
// Returns messages from that calendar day (UTC).
router.get('/chats/:chatId/messages-by-date', async (req: AuthRequest, res) => {
  const chatId = String(req.params.chatId);
  const date = String(req.query.date || '');
  if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) {
    res.status(400).json({ error: 'date должен быть YYYY-MM-DD' }); return;
  }
  const member = await prisma.chatMember.findUnique({
    where: { chatId_userId: { chatId, userId: req.userId! } },
  });
  if (!member) { res.status(403).json({ error: 'Нет доступа' }); return; }

  const start = new Date(`${date}T00:00:00.000Z`);
  const end = new Date(`${date}T23:59:59.999Z`);
  if (isNaN(start.getTime())) { res.status(400).json({ error: 'Некорректная дата' }); return; }

  const messages = await prisma.message.findMany({
    where: {
      chatId,
      isDeleted: false,
      createdAt: { gte: start, lte: end },
      hiddenBy: { none: { userId: req.userId! } },
      OR: [{ scheduledAt: null }, { senderId: req.userId! }],
      ...(member.clearedAt ? { createdAt: { gte: start, lte: end, gt: member.clearedAt } } : {}),
    },
    include: {
      sender: { select: SENDER_SELECT },
      media: true,
    },
    orderBy: { createdAt: 'asc' },
    take: 500,
  });
  res.json({ date, count: messages.length, messages });
});

// GET /features/chats/:chatId/active-dates?from=YYYY-MM-DD&to=YYYY-MM-DD
// Calendar dots: which days have messages. Uses raw SQL for DATE() grouping.
router.get('/chats/:chatId/active-dates', async (req: AuthRequest, res) => {
  const chatId = String(req.params.chatId);
  const member = await prisma.chatMember.findUnique({
    where: { chatId_userId: { chatId, userId: req.userId! } },
  });
  if (!member) { res.status(403).json({ error: 'Нет доступа' }); return; }

  const from = String(req.query.from || '');
  const to = String(req.query.to || '');
  if (!/^\d{4}-\d{2}-\d{2}$/.test(from) || !/^\d{4}-\d{2}-\d{2}$/.test(to)) {
    res.status(400).json({ error: 'from/to: YYYY-MM-DD' }); return;
  }

  const rows = await prisma.message.findMany({
    where: {
      chatId,
      isDeleted: false,
      createdAt: {
        gte: new Date(`${from}T00:00:00.000Z`),
        lte: new Date(`${to}T23:59:59.999Z`),
      },
    },
    select: { createdAt: true },
  });
  const byDay = new Map<string, number>();
  for (const r of rows) {
    const key = r.createdAt.toISOString().slice(0, 10);
    byDay.set(key, (byDay.get(key) || 0) + 1);
  }
  const result = [...byDay.entries()]
    .map(([day, cnt]) => ({ day, cnt }))
    .sort((a, b) => a.day.localeCompare(b.day));
  res.json(result);
});

export default router;
