import { Router } from 'express';
import { prisma } from '../db';
import { Prisma } from '@prisma/client';
import { AuthRequest } from '../middleware/auth';
import { SENDER_SELECT, MESSAGE_INCLUDE, uploadFile, uploadVoice, deleteUploadedFile, saveUploadedFile } from '../shared';

const router = Router();

// Получить сообщения чата
router.get('/chat/:chatId', async (req: AuthRequest, res) => {
  try {
    const chatId = String(req.params.chatId);
    const { cursor, limit = '50' } = req.query;
    const take = Math.min(Math.max(1, parseInt(limit as string) || 50), 200);

    const member = await prisma.chatMember.findUnique({
      where: { chatId_userId: { chatId, userId: req.userId! } },
    });

    if (!member) {
      res.status(403).json({ error: 'Нет доступа к этому чату' });
      return;
    }

    const createdAtFilter: Record<string, Date> = {};
    if (cursor) createdAtFilter.lt = new Date(cursor as string);
    if (member.clearedAt) createdAtFilter.gt = member.clearedAt;

    const messages = await prisma.message.findMany({
      where: {
        chatId,
        isDeleted: false,
        hiddenBy: { none: { userId: req.userId! } },
        // Scheduled messages: only visible to the sender until delivered
        OR: [
          { scheduledAt: null },
          { senderId: req.userId! },
        ],
        ...(Object.keys(createdAtFilter).length > 0 ? { createdAt: createdAtFilter } : {}),
      },
      include: MESSAGE_INCLUDE,
      orderBy: { createdAt: 'desc' },
      take,
    });

    res.json(messages.reverse());
  } catch (error) {
    console.error('Get messages error:', error);
    res.status(500).json({ error: 'Ошибка сервера' });
  }
});

// Загрузка файла
router.post('/upload', uploadFile.single('file'), saveUploadedFile(''), async (req: AuthRequest, res) => {
  try {
    if (!req.file) {
      res.status(400).json({ error: 'Файл не загружен' });
      return;
    }

    const fileUrl = (req.file as any).storageUrl;
    // multer decodes multipart filenames as latin1 — re-decode as UTF-8
    const originalName = Buffer.from(req.file.originalname, 'latin1').toString('utf8');

    res.json({
      url: fileUrl,
      filename: originalName,
      size: req.file.size,
      mimetype: req.file.mimetype,
    });
  } catch (error) {
    console.error('Upload error:', error);
    res.status(500).json({ error: 'Ошибка загрузки' });
  }
});

// Редактировать сообщение
router.put('/:id', async (req: AuthRequest, res) => {
  try {
    const { content } = req.body;
    const id = String(req.params.id);

    if (!content || typeof content !== 'string' || content.length > 10000) {
      res.status(400).json({ error: 'Содержимое обязательно и не должно превышать 10000 символов' });
      return;
    }

    const message = await prisma.message.findUnique({ where: { id } });
    if (!message || message.senderId !== req.userId) {
      res.status(403).json({ error: 'Нет прав для редактирования' });
      return;
    }

    const updated = await prisma.message.update({
      where: { id },
      data: { content, isEdited: true },
      include: MESSAGE_INCLUDE,
    });

    res.json(updated);
  } catch (error) {
    res.status(500).json({ error: 'Ошибка сервера' });
  }
});

// Удалить сообщение
router.delete('/:id', async (req: AuthRequest, res) => {
  try {
    const id = String(req.params.id);

    const message = await prisma.message.findUnique({
      where: { id },
      include: { media: true },
    });
    if (!message || message.senderId !== req.userId) {
      res.status(403).json({ error: 'Нет прав для удаления' });
      return;
    }

    // Delete media files from disk
    if (message.media && message.media.length > 0) {
      for (const m of message.media) {
        if (m.url) deleteUploadedFile(m.url);
      }
      await prisma.media.deleteMany({ where: { messageId: id } });
    }

    await prisma.message.update({
      where: { id },
      data: { isDeleted: true, content: null },
    });

    res.json({ success: true });
  } catch (error) {
    res.status(500).json({ error: 'Ошибка сервера' });
  }
});

// Получить общие медиа/файлы/ссылки чата
router.get('/chat/:chatId/shared', async (req: AuthRequest, res) => {
  try {
    const chatId = String(req.params.chatId);
    const { type } = req.query; // 'media' | 'files' | 'links'

    // Check membership
    const member = await prisma.chatMember.findUnique({
      where: { chatId_userId: { chatId, userId: req.userId! } },
    });
    if (!member) {
      res.status(403).json({ error: 'Нет доступа' });
      return;
    }

    const baseWhere: Prisma.MessageWhereInput = {
      chatId,
      isDeleted: false,
      hiddenBy: { none: { userId: req.userId! } },
      ...(member.clearedAt ? { createdAt: { gt: member.clearedAt } } : {}),
    };

    if (type === 'media') {
      // Images and videos
      const messages = await prisma.message.findMany({
        where: {
          ...baseWhere,
          media: { some: { type: { in: ['image', 'video'] } } },
        },
        include: {
          media: { where: { type: { in: ['image', 'video'] } } },
          sender: { select: SENDER_SELECT },
        },
        orderBy: { createdAt: 'desc' },
        take: 100,
      });
      res.json(messages);
    } else if (type === 'files') {
      // Files (documents, archives, audio, etc.)
      const messages = await prisma.message.findMany({
        where: {
          ...baseWhere,
          media: { some: { type: { notIn: ['image', 'video'] } } },
        },
        include: {
          media: { where: { type: { notIn: ['image', 'video'] } } },
          sender: { select: SENDER_SELECT },
        },
        orderBy: { createdAt: 'desc' },
        take: 100,
      });
      res.json(messages);
    } else if (type === 'links') {
      // Messages containing URLs
      const messages = await prisma.message.findMany({
        where: {
          ...baseWhere,
          content: { contains: 'http' },
        },
        include: {
          sender: { select: SENDER_SELECT },
        },
        orderBy: { createdAt: 'desc' },
        take: 100,
      });
      // Filter to only messages with actual URLs
      const withLinks = messages
        .filter((m) => m.content && /https?:\/\/[^\s]+/i.test(m.content))
        .map((m) => {
          const links = m.content!.match(/https?:\/\/[^\s]+/gi) || [];
          return { ...m, links };
        });
      res.json(withLinks);
    } else {
      res.status(400).json({ error: 'Invalid type. Use: media, files, or links' });
    }
  } catch (error) {
    console.error('Shared media error:', error);
    res.status(500).json({ error: 'Ошибка сервера' });
  }
});

// ─── Voice message upload + message creation ───────────────────────
// POST /api/messages/voice
// multipart: audio (file), chatId, duration?, waveform?, replyToId?
router.post('/voice', uploadVoice.single('audio'), saveUploadedFile('voice'), async (req: AuthRequest, res) => {
  try {
    if (!req.file) {
      res.status(400).json({ error: 'Аудиофайл не загружен' });
      return;
    }

    const chatId = typeof req.body.chatId === 'string' ? req.body.chatId : '';
    if (!chatId) {
      deleteUploadedFile((req.file as any).storageUrl);
      res.status(400).json({ error: 'chatId обязателен' });
      return;
    }

    // Membership check
    const member = await prisma.chatMember.findUnique({
      where: { chatId_userId: { chatId, userId: req.userId! } },
    });
    if (!member) {
      deleteUploadedFile((req.file as any).storageUrl);
      res.status(403).json({ error: 'Нет доступа к чату' });
      return;
    }

    // Parse duration (seconds)
    const rawDur = req.body.duration;
    let duration: number | null = null;
    if (rawDur !== undefined && rawDur !== '') {
      const d = Number(rawDur);
      if (!isNaN(d) && d > 0 && d <= 60 * 30) duration = d; // max 30 min
    }

    // Parse waveform — accept JSON array of numbers in [0, 1] (or 0-255); store as JSON string
    let waveformStr: string | null = null;
    if (typeof req.body.waveform === 'string' && req.body.waveform.length > 0) {
      try {
        const parsed = JSON.parse(req.body.waveform);
        if (Array.isArray(parsed) && parsed.length > 0 && parsed.length <= 1024 &&
            parsed.every((n) => typeof n === 'number' && isFinite(n))) {
          waveformStr = JSON.stringify(parsed);
        }
      } catch { /* ignore malformed waveform */ }
    }

    const replyToId = typeof req.body.replyToId === 'string' && req.body.replyToId.length > 0
      ? req.body.replyToId : null;

    const fileUrl = (req.file as any).storageUrl;

    const message = await prisma.message.create({
      data: {
        chatId,
        senderId: req.userId!,
        type: 'voice',
        replyToId,
        media: {
          create: {
            type: 'voice',
            url: fileUrl,
            filename: req.file.originalname,
            size: req.file.size,
            duration,
            waveform: waveformStr,
          },
        },
      },
      include: MESSAGE_INCLUDE,
    });

    // Add sender's read receipt
    await prisma.readReceipt.create({
      data: { messageId: message.id, userId: req.userId! },
    });

    res.json(message);
  } catch (error) {
    console.error('Voice upload error:', error);
    res.status(500).json({ error: 'Ошибка загрузки голосового' });
  }
});

// ─── Send E2EE message via REST (per-recipient envelopes) ───────────
// POST /api/messages/e2ee
// body: { chatId, ciphertext (base64, stored in content), envelopes: [{recipientId, deviceId?, ciphertext, messageType?}], replyToId?, type? }
router.post('/e2ee', async (req: AuthRequest, res) => {
  try {
    const { chatId, ciphertext, envelopes, replyToId, type } = req.body as {
      chatId?: string; ciphertext?: string; type?: string;
      envelopes?: Array<{ recipientId: string; deviceId?: string; ciphertext: string; messageType?: number }>;
      replyToId?: string;
    };

    if (!chatId || typeof chatId !== 'string') {
      res.status(400).json({ error: 'chatId обязателен' });
      return;
    }
    if (typeof ciphertext !== 'string' || ciphertext.length === 0 || ciphertext.length > 200_000) {
      res.status(400).json({ error: 'ciphertext обязателен (base64, до 200KB)' });
      return;
    }
    if (!Array.isArray(envelopes) || envelopes.length === 0 || envelopes.length > 50) {
      res.status(400).json({ error: 'envelopes: от 1 до 50' });
      return;
    }

    // Membership check
    const member = await prisma.chatMember.findUnique({
      where: { chatId_userId: { chatId, userId: req.userId! } },
    });
    if (!member) {
      res.status(403).json({ error: 'Нет доступа к чату' });
      return;
    }

    // Verify recipients are chat members
    const chatMembers = await prisma.chatMember.findMany({
      where: { chatId },
      select: { userId: true },
    });
    const memberIds = new Set(chatMembers.map(m => m.userId));
    for (const env of envelopes) {
      if (typeof env.recipientId !== 'string' || !memberIds.has(env.recipientId)) {
        res.status(400).json({ error: `Получатель ${env.recipientId} не состоит в чате` });
        return;
      }
      if (typeof env.ciphertext !== 'string' || env.ciphertext.length === 0 || env.ciphertext.length > 8192) {
        res.status(400).json({ error: 'envelope.ciphertext: base64 до 8KB' });
        return;
      }
    }

    const allowedTypes = new Set(['text', 'image', 'video', 'voice', 'file', 'gif']);
    const msgType = type && allowedTypes.has(type) ? type : 'text';

    const message = await prisma.message.create({
      data: {
        chatId,
        senderId: req.userId!,
        type: msgType,
        content: ciphertext,      // encrypted payload in content
        isEncrypted: true,
        replyToId: replyToId || null,
        e2eeEnvelopes: {
          create: envelopes.map(env => ({
            recipientId: env.recipientId,
            deviceId: env.deviceId || 'default',
            ciphertext: env.ciphertext,
            messageType: env.messageType ?? 1,
          })),
        },
      },
      include: {
        ...MESSAGE_INCLUDE,
        e2eeEnvelopes: true,
      },
    });

    await prisma.readReceipt.create({
      data: { messageId: message.id, userId: req.userId! },
    });

    res.json(message);
  } catch (error) {
    console.error('E2EE send error:', error);
    res.status(500).json({ error: 'Ошибка отправки зашифрованного сообщения' });
  }
});

// GET /api/messages/:id/envelope — get this user's E2EE envelope for a message
router.get('/:id/envelope', async (req: AuthRequest, res) => {
  try {
    const id = String(req.params.id);
    const msg = await prisma.message.findUnique({
      where: { id },
      select: { chatId: true, isEncrypted: true },
    });
    if (!msg) {
      res.status(404).json({ error: 'Сообщение не найдено' });
      return;
    }
    const member = await prisma.chatMember.findUnique({
      where: { chatId_userId: { chatId: msg.chatId, userId: req.userId! } },
    });
    if (!member) {
      res.status(403).json({ error: 'Нет доступа' });
      return;
    }
    const envelope = await prisma.e2EEEnvelope.findFirst({
      where: { messageId: id, recipientId: req.userId! },
    });
    if (!envelope) {
      res.status(404).json({ error: 'Envelope для этого пользователя не найден' });
      return;
    }
    res.json(envelope);
  } catch (error) {
    console.error('Envelope fetch error:', error);
    res.status(500).json({ error: 'Ошибка' });
  }
});

export default router;
