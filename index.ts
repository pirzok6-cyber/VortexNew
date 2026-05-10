import { Server, Socket } from 'socket.io';
import jwt from 'jsonwebtoken';
import { prisma } from '../db';
import { config } from '../config';
import { SENDER_SELECT, deleteUploadedFile } from '../shared';

interface AuthSocket extends Socket {
  userId?: string;
}

const onlineUsers = new Map<string, Set<string>>();

// ─── Active group calls: chatId → Set<userId> ────────────────────────
const activeGroupCalls = new Map<string, Set<string>>();

// ─── Socket rate limiting ────────────────────────────────────────────
const rateLimitMap = new Map<string, { count: number; resetAt: number }>();
const RATE_LIMIT_WINDOW = 1000; // 1 second
const RATE_LIMIT_MAX = 10; // max events per window

const MAX_TIMEOUT = 2_147_483_647; // Max safe setTimeout delay (~24.8 days)

function checkRateLimit(userId: string): boolean {
  const now = Date.now();
  const entry = rateLimitMap.get(userId);
  if (!entry || now > entry.resetAt) {
    rateLimitMap.set(userId, { count: 1, resetAt: now + RATE_LIMIT_WINDOW });
    return true;
  }
  entry.count++;
  return entry.count <= RATE_LIMIT_MAX;
}

// Clean up stale rate-limit entries every 30s
setInterval(() => {
  const now = Date.now();
  for (const [key, val] of rateLimitMap) {
    if (now > val.resetAt) rateLimitMap.delete(key);
  }
}, 30_000);

async function isChatMember(chatId: string, userId: string): Promise<boolean> {
  const member = await prisma.chatMember.findUnique({
    where: { chatId_userId: { chatId, userId } },
  });
  return !!member;
}

export function setupSocket(io: Server) {
  // On startup, re-schedule any pending scheduled messages
  rescheduleMessages(io);

  io.use((socket: AuthSocket, next) => {
    const token = socket.handshake.auth.token;
    if (!token) return next(new Error('Требуется авторизация'));

    try {
      const decoded = jwt.verify(token, config.jwtSecret) as { userId: string };
      socket.userId = decoded.userId;
      next();
    } catch {
      next(new Error('Недействительный токен'));
    }
  });

  io.on('connection', async (socket: AuthSocket) => {
    const userId = socket.userId!;
    console.log(`Пользователь подключился: ${userId}`);

    if (!onlineUsers.has(userId)) {
      onlineUsers.set(userId, new Set());
    }
    onlineUsers.get(userId)!.add(socket.id);

    await prisma.user.update({
      where: { id: userId },
      data: { isOnline: true, lastSeen: new Date() },
    });

    socket.broadcast.emit('user_online', { userId });

    const userChats = await prisma.chatMember.findMany({
      where: { userId },
      select: { chatId: true },
    });

    for (const { chatId } of userChats) {
      socket.join(`chat:${chatId}`);
    }

    socket.on('join_chat', async (chatId: string) => {
      if (await isChatMember(chatId, userId)) {
        socket.join(`chat:${chatId}`);
      }
    });

    socket.on('leave_chat', (chatId: string) => {
      socket.leave(`chat:${chatId}`);
    });

    // ─── E2EE: send an encrypted message with per-recipient envelopes ─────
    socket.on('send_encrypted_message', async (data: {
      chatId: string;
      ciphertext: string;                           // base64 — stored in `content`
      envelopes: Array<{
        recipientId: string;
        deviceId?: string;
        ciphertext: string;
        messageType?: number;
      }>;
      replyToId?: string;
      type?: string;
    }) => {
      try {
        if (!checkRateLimit(userId)) {
          socket.emit('error', { message: 'Слишком много сообщений, подождите' });
          return;
        }
        if (!data || typeof data.chatId !== 'string' || typeof data.ciphertext !== 'string') return;
        if (data.ciphertext.length === 0 || data.ciphertext.length > 200_000) {
          socket.emit('error', { message: 'ciphertext: до 200KB' });
          return;
        }
        if (!Array.isArray(data.envelopes) || data.envelopes.length === 0 || data.envelopes.length > 50) {
          socket.emit('error', { message: 'envelopes: от 1 до 50' });
          return;
        }
        if (!(await isChatMember(data.chatId, userId))) {
          socket.emit('error', { message: 'Нет доступа к этому чату' });
          return;
        }

        const chatMembers = await prisma.chatMember.findMany({
          where: { chatId: data.chatId },
          select: { userId: true },
        });
        const memberIds = new Set(chatMembers.map(m => m.userId));
        for (const env of data.envelopes) {
          if (typeof env.recipientId !== 'string' || !memberIds.has(env.recipientId)) {
            socket.emit('error', { message: 'Некорректный получатель' });
            return;
          }
          if (typeof env.ciphertext !== 'string' || env.ciphertext.length === 0 || env.ciphertext.length > 8192) {
            socket.emit('error', { message: 'envelope.ciphertext: до 8KB' });
            return;
          }
        }

        const allowedTypes = new Set(['text', 'image', 'video', 'voice', 'file', 'gif']);
        const msgType = data.type && allowedTypes.has(data.type) ? data.type : 'text';

        const message = await prisma.message.create({
          data: {
            chatId: data.chatId,
            senderId: userId,
            type: msgType,
            content: data.ciphertext,
            isEncrypted: true,
            replyToId: data.replyToId || null,
            e2eeEnvelopes: {
              create: data.envelopes.map(env => ({
                recipientId: env.recipientId,
                deviceId: env.deviceId || 'default',
                ciphertext: env.ciphertext,
                messageType: env.messageType ?? 1,
              })),
            },
          },
          include: {
            sender: { select: SENDER_SELECT },
            replyTo: {
              include: { sender: { select: { id: true, username: true, displayName: true } } },
            },
            media: true,
            reactions: true,
            readBy: true,
            e2eeEnvelopes: true,
          },
        });

        await prisma.readReceipt.create({ data: { messageId: message.id, userId } });

        // Deliver to each member: only include THEIR envelope
        for (const mid of memberIds) {
          const memberSockets = onlineUsers.get(mid);
          if (!memberSockets) continue;
          const envelope = message.e2eeEnvelopes.find(e => e.recipientId === mid) || null;
          const perUserPayload = {
            ...message,
            // Hide other users' envelopes — each recipient only sees their own
            e2eeEnvelopes: envelope ? [envelope] : [],
            readBy: [{ userId }],
          };
          for (const sid of memberSockets) {
            const memberSocket = io.sockets.sockets.get(sid);
            if (memberSocket) {
              memberSocket.join(`chat:${data.chatId}`);
              io.to(sid).emit('new_message', perUserPayload);
            }
          }
        }
      } catch (error) {
        console.error('Send encrypted message error:', error);
        socket.emit('error', { message: 'Ошибка отправки зашифрованного сообщения' });
      }
    });

    // Отправка сообщения
    socket.on('send_message', async (data: {
      chatId: string;
      content?: string;
      type?: string;
      replyToId?: string;
      quote?: string;
      forwardedFromId?: string;
      mediaUrl?: string;
      mediaType?: string;
      fileName?: string;
      fileSize?: number;
      duration?: number;
      scheduledAt?: string;
    }) => {
      try {
        // Rate limit
        if (!checkRateLimit(userId)) {
          socket.emit('error', { message: 'Слишком много сообщений, подождите' });
          return;
        }

        // Validate payload
        if (!data.chatId || typeof data.chatId !== 'string') return;
        if (data.content && data.content.length > 10000) {
          socket.emit('error', { message: 'Сообщение слишком длинное' });
          return;
        }

        // Membership check
        if (!(await isChatMember(data.chatId, userId))) {
          socket.emit('error', { message: 'Нет доступа к этому чату' });
          return;
        }

        // Validate message type
        const VALID_TYPES = ['text', 'image', 'video', 'voice', 'file', 'gif'];
        const msgType = data.type || 'text';
        if (!VALID_TYPES.includes(msgType)) {
          socket.emit('error', { message: 'Недопустимый тип сообщения' });
          return;
        }

        // Validate mediaUrl — only /uploads/ paths or https URLs allowed
        if (data.mediaUrl) {
          if (typeof data.mediaUrl !== 'string') {
            socket.emit('error', { message: 'Некорректный mediaUrl' });
            return;
          }
          const isLocalUpload = data.mediaUrl.startsWith('/uploads/');
          const isExternalUrl = data.mediaUrl.startsWith('https://');
          if (!isLocalUpload && !isExternalUrl) {
            socket.emit('error', { message: 'Недопустимый mediaUrl' });
            return;
          }
          if (isLocalUpload && data.mediaUrl.includes('..')) {
            socket.emit('error', { message: 'Недопустимый путь в mediaUrl' });
            return;
          }
        }

        const scheduledAt = data.scheduledAt ? new Date(data.scheduledAt) : null;

        // Validate scheduledAt — must be in the future and within 7 days
        if (scheduledAt) {
          const now = Date.now();
          const maxSchedule = now + 7 * 24 * 60 * 60 * 1000;
          if (isNaN(scheduledAt.getTime()) || scheduledAt.getTime() <= now || scheduledAt.getTime() > maxSchedule) {
            socket.emit('error', { message: 'Некорректная дата отложенного сообщения' });
            return;
          }
        }

        // Validate forwardedFromId — must reference an existing user
        let validForwardedFromId: string | null = null;
        if (data.forwardedFromId) {
          const forwardUser = await prisma.user.findUnique({ where: { id: data.forwardedFromId }, select: { id: true } });
          if (forwardUser) {
            validForwardedFromId = forwardUser.id;
          }
        }

        const message = await prisma.message.create({
          data: {
            chatId: data.chatId,
            senderId: userId,
            content: data.content || null,
            type: msgType,
            replyToId: data.replyToId || null,
            quote: data.quote || null,
            forwardedFromId: validForwardedFromId,
            scheduledAt,
            ...(data.mediaUrl
              ? {
                media: {
                  create: {
                    type: data.mediaType || 'file',
                    url: data.mediaUrl,
                    filename: data.fileName,
                    size: data.fileSize,
                    duration: data.duration,
                  },
                },
              }
              : {}),
          },
          include: {
            sender: { select: SENDER_SELECT },
            forwardedFrom: { select: SENDER_SELECT },
            replyTo: {
              include: { sender: { select: { id: true, username: true, displayName: true } } },
            },
            media: true,
            reactions: true,
            readBy: true,
          },
        });

        // Scheduled messages: only send to the sender immediately, deliver to chat at scheduled time
        if (scheduledAt && scheduledAt.getTime() > Date.now()) {
          socket.emit('new_message', {
            ...message,
            readBy: [{ userId }],
          });

          const delay = Math.min(scheduledAt.getTime() - Date.now(), MAX_TIMEOUT);
          setTimeout(async () => {
            try {
              // Check if message was deleted while waiting
              const current = await prisma.message.findUnique({ where: { id: message.id } });
              if (!current || current.isDeleted) return;

              // Clear scheduledAt and emit to all
              await prisma.message.update({
                where: { id: message.id },
                data: { scheduledAt: null },
              });

              await prisma.readReceipt.create({
                data: { messageId: message.id, userId },
              });

              const members = await prisma.chatMember.findMany({
                where: { chatId: data.chatId },
                select: { userId: true },
              });
              for (const member of members) {
                const memberSockets = onlineUsers.get(member.userId);
                if (memberSockets) {
                  for (const sid of memberSockets) {
                    const memberSocket = io.sockets.sockets.get(sid);
                    if (memberSocket) memberSocket.join(`chat:${data.chatId}`);
                  }
                }
              }

              const updated = await prisma.message.findUnique({
                where: { id: message.id },
                include: {
                  sender: { select: SENDER_SELECT },
                  forwardedFrom: { select: SENDER_SELECT },
                  replyTo: {
                    include: { sender: { select: { id: true, username: true, displayName: true } } },
                  },
                  media: true,
                  reactions: true,
                  readBy: true,
                },
              });
              if (updated) {
                // Get chat details for notification
                const chat = await prisma.chat.findUnique({
                  where: { id: data.chatId },
                  include: {
                    members: {
                      include: { user: { select: { id: true, username: true, displayName: true } } },
                    },
                  },
                });
                let recipientName = '';
                if (chat) {
                  if (chat.type === 'group') {
                    recipientName = chat.name || 'Group';
                  } else if (chat.type === 'favorites') {
                    recipientName = 'Избранное';
                  } else {
                    const otherMember = chat.members.find(m => m.userId !== userId);
                    recipientName = otherMember?.user.displayName || otherMember?.user.username || '';
                  }
                }

                io.to(`chat:${data.chatId}`).emit('scheduled_delivered', {
                  ...updated,
                  readBy: updated.readBy.map(r => ({ userId: r.userId })),
                  _recipientName: recipientName,
                  _deliveredAt: new Date().toISOString(),
                });
              }
            } catch (err) {
              console.error('Scheduled delivery error:', err);
            }
          }, delay);
          return;
        }

        await prisma.readReceipt.create({
          data: { messageId: message.id, userId },
        });

        const members = await prisma.chatMember.findMany({
          where: { chatId: data.chatId },
          select: { userId: true },
        });

        for (const member of members) {
          const memberSockets = onlineUsers.get(member.userId);
          if (memberSockets) {
            for (const sid of memberSockets) {
              const memberSocket = io.sockets.sockets.get(sid);
              if (memberSocket) {
                memberSocket.join(`chat:${data.chatId}`);
              }
            }
          }
        }

        io.to(`chat:${data.chatId}`).emit('new_message', {
          ...message,
          readBy: [{ userId }],
        });
      } catch (error) {
        console.error('Send message error:', error);
        socket.emit('error', { message: 'Ошибка отправки сообщения' });
      }
    });

    // Индикатор набора текста (with membership check)
    socket.on('typing_start', async (chatId: string) => {
      if (!chatId || typeof chatId !== 'string') return;
      if (!(await isChatMember(chatId, userId))) return;
      socket.to(`chat:${chatId}`).emit('user_typing', { chatId, userId });
    });

    socket.on('typing_stop', async (chatId: string) => {
      if (!chatId || typeof chatId !== 'string') return;
      if (!(await isChatMember(chatId, userId))) return;
      socket.to(`chat:${chatId}`).emit('user_stopped_typing', { chatId, userId });
    });

    // Отметки о прочтении
    socket.on('read_messages', async (data: { chatId: string; messageIds: string[] }) => {
      try {
        if (!data.chatId || !Array.isArray(data.messageIds) || data.messageIds.length === 0) return;
        // Limit array size to prevent abuse
        if (data.messageIds.length > 200) {
          socket.emit('error', { message: 'Слишком много сообщений за раз (макс. 200)' });
          return;
        }
        if (!(await isChatMember(data.chatId, userId))) return;

        await prisma.$transaction(
          data.messageIds.map(messageId =>
            prisma.readReceipt.upsert({
              where: { messageId_userId: { messageId, userId } },
              create: { messageId, userId },
              update: {},
            })
          )
        );

        socket.to(`chat:${data.chatId}`).emit('messages_read', {
          chatId: data.chatId,
          userId,
          messageIds: data.messageIds,
        });
      } catch (error) {
        console.error('Read receipts error:', error);
      }
    });

    // Редактирование сообщения
    socket.on('edit_message', async (data: { messageId: string; content: string; chatId: string }) => {
      try {
        if (!checkRateLimit(userId)) return;
        if (!data.messageId || !data.content || data.content.length > 10000) return;

        const message = await prisma.message.findUnique({ where: { id: data.messageId } });
        if (!message || message.senderId !== userId) return;

        const updated = await prisma.message.update({
          where: { id: data.messageId },
          data: { content: data.content, isEdited: true },
          include: {
            sender: { select: SENDER_SELECT },
            replyTo: {
              include: { sender: { select: { id: true, username: true, displayName: true } } },
            },
            media: true,
            reactions: { include: { user: { select: { id: true, username: true, displayName: true } } } },
            readBy: { select: { userId: true } },
          },
        });

        io.to(`chat:${message.chatId}`).emit('message_edited', updated);
      } catch (error) {
        console.error('Edit message error:', error);
      }
    });

    // Удаление сообщения
    socket.on('delete_message', async (data: { messageId: string; chatId: string }) => {
      try {
        if (!checkRateLimit(userId)) return;
        if (!data.messageId) return;

        const message = await prisma.message.findUnique({
          where: { id: data.messageId },
          include: { media: true },
        });
        if (!message) return;

        // Проверяем членство в чате
        if (!(await isChatMember(message.chatId, userId))) return;

        // Delete media files from disk
        if (message.media && message.media.length > 0) {
          for (const m of message.media) {
            if (m.url) deleteUploadedFile(m.url);
          }
          // Delete media records from DB
          await prisma.media.deleteMany({ where: { messageId: data.messageId } });
        }

        await prisma.message.update({
          where: { id: data.messageId },
          data: { isDeleted: true, content: null },
        });

        io.to(`chat:${message.chatId}`).emit('message_deleted', {
          messageId: data.messageId,
          chatId: message.chatId,
        });
      } catch (error) {
        console.error('Delete message error:', error);
      }
    });

    // Массовое удаление сообщений (с опцией «только у меня» / «у всех»)
    socket.on('delete_messages', async (data: { messageIds: string[]; chatId: string; deleteForAll: boolean }) => {
      try {
        if (!checkRateLimit(userId)) return;
        if (!data.chatId || !Array.isArray(data.messageIds) || data.messageIds.length === 0) return;
        if (data.messageIds.length > 100) return; // лимит

        // Проверяем членство в чате
        if (!(await isChatMember(data.chatId, userId))) return;

        if (data.deleteForAll) {
          // Удалить у всех — любой участник чата может удалить любое сообщение
          const messages = await prisma.message.findMany({
            where: {
              id: { in: data.messageIds },
              chatId: data.chatId,
              isDeleted: false,
            },
            include: { media: true },
          });

          const deletedIds: string[] = [];

          for (const message of messages) {
            // Удаляем медиа-файлы с диска
            if (message.media && message.media.length > 0) {
              for (const m of message.media) {
                if (m.url) deleteUploadedFile(m.url);
              }
              await prisma.media.deleteMany({ where: { messageId: message.id } });
            }

            await prisma.message.update({
              where: { id: message.id },
              data: { isDeleted: true, content: null },
            });

            deletedIds.push(message.id);
          }

          if (deletedIds.length > 0) {
            io.to(`chat:${data.chatId}`).emit('messages_deleted', {
              messageIds: deletedIds,
              chatId: data.chatId,
            });
          }
        } else {
          // Удалить только у меня — создаём записи HiddenMessage
          const validMessages = await prisma.message.findMany({
            where: {
              id: { in: data.messageIds },
              chatId: data.chatId,
              isDeleted: false,
            },
            select: { id: true },
          });

          const validIds = validMessages.map(m => m.id);
          if (validIds.length === 0) return;

          // Upsert hidden records (пропускаем дубли)
          await prisma.$transaction(
            validIds.map(msgId =>
              prisma.hiddenMessage.upsert({
                where: { messageId_userId: { messageId: msgId, userId } },
                create: { messageId: msgId, userId },
                update: {},
              })
            )
          );

          // Отправляем только этому пользователю
          socket.emit('messages_hidden', {
            messageIds: validIds,
            chatId: data.chatId,
          });
        }
      } catch (error) {
        console.error('Bulk delete messages error:', error);
      }
    });

    // Реакции
    socket.on('add_reaction', async (data: { messageId: string; emoji: string; chatId: string }) => {
      try {
        if (!checkRateLimit(userId)) return;
        if (!data.chatId || !data.messageId || !data.emoji) return;
        if (typeof data.emoji !== 'string' || data.emoji.length > 10) return;
        if (!(await isChatMember(data.chatId, userId))) return;

        await prisma.reaction.upsert({
          where: {
            messageId_userId_emoji: { messageId: data.messageId, userId, emoji: data.emoji },
          },
          create: { messageId: data.messageId, userId, emoji: data.emoji },
          update: {},
        });

        const user = await prisma.user.findUnique({
          where: { id: userId },
          select: { id: true, username: true, displayName: true },
        });

        io.to(`chat:${data.chatId}`).emit('reaction_added', {
          messageId: data.messageId,
          chatId: data.chatId,
          userId,
          username: user?.displayName || user?.username,
          emoji: data.emoji,
        });
      } catch (error) {
        console.error('Add reaction error:', error);
      }
    });

    socket.on('remove_reaction', async (data: { messageId: string; emoji: string; chatId: string }) => {
      try {
        if (!data.chatId || !data.messageId || !data.emoji) return;
        if (!(await isChatMember(data.chatId, userId))) return;

        await prisma.reaction.deleteMany({
          where: {
            messageId: data.messageId,
            userId,
            emoji: data.emoji,
          },
        });

        io.to(`chat:${data.chatId}`).emit('reaction_removed', {
          messageId: data.messageId,
          chatId: data.chatId,
          userId,
          emoji: data.emoji,
        });
      } catch (error) {
        console.error('Remove reaction error:', error);
      }
    });

    // ======= Pin / Unpin Messages =======

    socket.on('pin_message', async (data: { messageId: string; chatId: string }) => {
      try {
        // Verify user is member of the chat
        const member = await prisma.chatMember.findUnique({
          where: { chatId_userId: { chatId: data.chatId, userId } },
        });
        if (!member) return;

        // Upsert pin
        await prisma.pinnedMessage.upsert({
          where: { chatId_messageId: { chatId: data.chatId, messageId: data.messageId } },
          create: { chatId: data.chatId, messageId: data.messageId },
          update: { pinnedAt: new Date() },
        });

        // Fetch the full message to broadcast
        const message = await prisma.message.findUnique({
          where: { id: data.messageId },
          include: {
            sender: { select: SENDER_SELECT },
            media: true,
          },
        });

        io.to(`chat:${data.chatId}`).emit('message_pinned', {
          chatId: data.chatId,
          message,
        });
      } catch (error) {
        console.error('Pin message error:', error);
      }
    });

    socket.on('unpin_message', async (data: { messageId: string; chatId: string }) => {
      try {
        const member = await prisma.chatMember.findUnique({
          where: { chatId_userId: { chatId: data.chatId, userId } },
        });
        if (!member) return;

        await prisma.pinnedMessage.deleteMany({
          where: { chatId: data.chatId, messageId: data.messageId },
        });

        // Find the new latest pinned message (if any)
        const latestPin = await prisma.pinnedMessage.findFirst({
          where: { chatId: data.chatId },
          orderBy: { pinnedAt: 'desc' },
          include: {
            message: {
              include: {
                sender: { select: SENDER_SELECT },
                media: true,
              },
            },
          },
        });

        io.to(`chat:${data.chatId}`).emit('message_unpinned', {
          chatId: data.chatId,
          messageId: data.messageId,
          newPinnedMessage: latestPin?.message || null,
        });
      } catch (error) {
        console.error('Unpin message error:', error);
      }
    });

    // ======= WebRTC Calls =======

    // Initiate a call: relay offer to the target user
    socket.on('call_offer', async (data: { targetUserId: string; offer: unknown; callType: 'voice' | 'video'; chatId?: string }) => {
      if (!data.targetUserId) return;

      // Find a common personal chat between caller and target (server-side lookup for security)
      let chatId = data.chatId;
      if (!chatId) {
        const commonChat = await prisma.chat.findFirst({
          where: {
            type: 'personal',
            AND: [
              { members: { some: { userId } } },
              { members: { some: { userId: data.targetUserId } } },
            ],
          },
          select: { id: true },
        });
        if (!commonChat) {
          socket.emit('call_unavailable', { targetUserId: data.targetUserId });
          return;
        }
        chatId = commonChat.id;
      } else {
        // If chatId provided, verify membership
        if (!(await isChatMember(chatId, userId)) || !(await isChatMember(chatId, data.targetUserId))) {
          socket.emit('error', { message: 'Нет общего чата для звонка' });
          return;
        }
      }

      const targetSockets = onlineUsers.get(data.targetUserId);
      if (targetSockets) {
        // Look up caller info to send to callee
        let callerInfo: { id: string; username: string; displayName: string; avatar: string | null } | null = null;
        try {
          const caller = await prisma.user.findUnique({
            where: { id: userId },
            select: { id: true, username: true, displayName: true, avatar: true },
          });
          callerInfo = caller;
        } catch (e) {
          // Ignore lookup errors
        }
        for (const sid of targetSockets) {
          io.to(sid).emit('call_incoming', {
            from: userId,
            offer: data.offer,
            callType: data.callType,
            chatId,
            callerInfo,
          });
        }
      } else {
        // Target is offline
        socket.emit('call_unavailable', { targetUserId: data.targetUserId });
      }
    });

    // Relay answer back to caller
    socket.on('call_answer', (data: { targetUserId: string; answer: unknown }) => {
      const targetSockets = onlineUsers.get(data.targetUserId);
      if (targetSockets) {
        for (const sid of targetSockets) {
          io.to(sid).emit('call_answered', {
            from: userId,
            answer: data.answer,
          });
        }
      }
    });

    // ICE candidate exchange
    socket.on('ice_candidate', (data: { targetUserId: string; candidate: unknown }) => {
      const targetSockets = onlineUsers.get(data.targetUserId);
      if (targetSockets) {
        for (const sid of targetSockets) {
          io.to(sid).emit('ice_candidate', {
            from: userId,
            candidate: data.candidate,
          });
        }
      }
    });

    // End call
    socket.on('call_end', (data: { targetUserId: string }) => {
      const targetSockets = onlineUsers.get(data.targetUserId);
      if (targetSockets) {
        for (const sid of targetSockets) {
          io.to(sid).emit('call_ended', { from: userId });
        }
      }
    });

    // Decline call
    socket.on('call_decline', (data: { targetUserId: string }) => {
      const targetSockets = onlineUsers.get(data.targetUserId);
      if (targetSockets) {
        for (const sid of targetSockets) {
          io.to(sid).emit('call_declined', { from: userId });
        }
      }
    });

    // Renegotiate (when adding video/screen share to an existing call)
    socket.on('renegotiate', (data: { targetUserId: string; offer: unknown }) => {
      const targetSockets = onlineUsers.get(data.targetUserId);
      if (targetSockets) {
        for (const sid of targetSockets) {
          io.to(sid).emit('renegotiate', { from: userId, offer: data.offer });
        }
      }
    });

    socket.on('renegotiate_answer', (data: { targetUserId: string; answer: unknown }) => {
      const targetSockets = onlineUsers.get(data.targetUserId);
      if (targetSockets) {
        for (const sid of targetSockets) {
          io.to(sid).emit('renegotiate_answer', { from: userId, answer: data.answer });
        }
      }
    });

    // ======= Group Conference Calls =======

    // Query active group call status for a chat
    socket.on('group_call_status', async (data: { chatId: string }) => {
      if (!data.chatId || typeof data.chatId !== 'string') return;
      if (!(await isChatMember(data.chatId, userId))) return;
      const participants = activeGroupCalls.get(data.chatId);
      socket.emit('group_call_active', {
        chatId: data.chatId,
        participants: participants ? Array.from(participants) : [],
        callType: 'voice',
      });
    });

    // Start or join a group call
    socket.on('group_call_join', async (data: { chatId: string; callType: 'voice' | 'video' }) => {
      if (!data.chatId || typeof data.chatId !== 'string') return;
      if (!(await isChatMember(data.chatId, userId))) {
        socket.emit('error', { message: 'Нет доступа к этому чату' });
        return;
      }
      // Verify it's a group chat
      const chat = await prisma.chat.findUnique({ where: { id: data.chatId }, select: { type: true } });
      if (!chat || chat.type !== 'group') return;

      if (!activeGroupCalls.has(data.chatId)) {
        activeGroupCalls.set(data.chatId, new Set());
      }
      const participants = activeGroupCalls.get(data.chatId)!;
      const existingParticipants = Array.from(participants);
      participants.add(userId);

      // Look up joiner info
      const joinerInfo = await prisma.user.findUnique({
        where: { id: userId },
        select: { id: true, username: true, displayName: true, avatar: true },
      });

      // Notify existing participants that someone joined
      for (const pid of existingParticipants) {
        const pSockets = onlineUsers.get(pid);
        if (pSockets) {
          for (const sid of pSockets) {
            io.to(sid).emit('group_call_user_joined', {
              chatId: data.chatId,
              userId,
              userInfo: joinerInfo,
            });
          }
        }
      }

      // Send current participant list to the joiner
      const participantInfos = await prisma.user.findMany({
        where: { id: { in: existingParticipants } },
        select: { id: true, username: true, displayName: true, avatar: true },
      });

      socket.emit('group_call_participants', {
        chatId: data.chatId,
        participants: participantInfos,
      });

      // Notify all group members about the active call (for "join" button)
      io.to(`chat:${data.chatId}`).emit('group_call_active', {
        chatId: data.chatId,
        participants: Array.from(participants),
        callType: data.callType,
      });
    });

    // Leave a group call
    socket.on('group_call_leave', async (data: { chatId: string }) => {
      if (!data.chatId) return;
      const participants = activeGroupCalls.get(data.chatId);
      if (!participants) return;
      participants.delete(userId);

      // Notify remaining participants
      for (const pid of participants) {
        const pSockets = onlineUsers.get(pid);
        if (pSockets) {
          for (const sid of pSockets) {
            io.to(sid).emit('group_call_user_left', { chatId: data.chatId, userId });
          }
        }
      }

      if (participants.size === 0) {
        activeGroupCalls.delete(data.chatId);
      }

      // Update active call status
      io.to(`chat:${data.chatId}`).emit('group_call_active', {
        chatId: data.chatId,
        participants: participants.size > 0 ? Array.from(participants) : [],
        callType: 'voice',
      });
    });

    // Relay group call signaling between specific participants
    socket.on('group_call_offer', (data: { chatId: string; targetUserId: string; offer: unknown }) => {
      const targetSockets = onlineUsers.get(data.targetUserId);
      if (targetSockets) {
        for (const sid of targetSockets) {
          io.to(sid).emit('group_call_offer', { chatId: data.chatId, from: userId, offer: data.offer });
        }
      }
    });

    socket.on('group_call_answer', (data: { chatId: string; targetUserId: string; answer: unknown }) => {
      const targetSockets = onlineUsers.get(data.targetUserId);
      if (targetSockets) {
        for (const sid of targetSockets) {
          io.to(sid).emit('group_call_answer', { chatId: data.chatId, from: userId, answer: data.answer });
        }
      }
    });

    socket.on('group_ice_candidate', (data: { chatId: string; targetUserId: string; candidate: unknown }) => {
      const targetSockets = onlineUsers.get(data.targetUserId);
      if (targetSockets) {
        for (const sid of targetSockets) {
          io.to(sid).emit('group_ice_candidate', { chatId: data.chatId, from: userId, candidate: data.candidate });
        }
      }
    });

    socket.on('group_call_renegotiate', (data: { chatId: string; targetUserId: string; offer: unknown }) => {
      const targetSockets = onlineUsers.get(data.targetUserId);
      if (targetSockets) {
        for (const sid of targetSockets) {
          io.to(sid).emit('group_call_renegotiate', { chatId: data.chatId, from: userId, offer: data.offer });
        }
      }
    });

    socket.on('group_call_renegotiate_answer', (data: { chatId: string; targetUserId: string; answer: unknown }) => {
      const targetSockets = onlineUsers.get(data.targetUserId);
      if (targetSockets) {
        for (const sid of targetSockets) {
          io.to(sid).emit('group_call_renegotiate_answer', { chatId: data.chatId, from: userId, answer: data.answer });
        }
      }
    });

    // ======= Friend System Events =======

    socket.on('friend_request', async (data: { friendId: string }) => {
      if (!data.friendId || typeof data.friendId !== 'string') return;
      // Verify a pending friendship actually exists
      const friendship = await prisma.friendship.findFirst({
        where: { userId, friendId: data.friendId, status: 'pending' },
      });
      if (!friendship) return;

      const targetSockets = onlineUsers.get(data.friendId);
      if (targetSockets) {
        const user = await prisma.user.findUnique({
          where: { id: userId },
          select: { id: true, username: true, displayName: true, avatar: true },
        });
        for (const sid of targetSockets) {
          io.to(sid).emit('friend_request_received', { from: user });
        }
      }
    });

    socket.on('friend_accepted', async (data: { friendId: string }) => {
      if (!data.friendId || typeof data.friendId !== 'string') return;
      // Verify an accepted friendship actually exists
      const friendship = await prisma.friendship.findFirst({
        where: {
          status: 'accepted',
          OR: [
            { userId, friendId: data.friendId },
            { userId: data.friendId, friendId: userId },
          ],
        },
      });
      if (!friendship) return;

      const targetSockets = onlineUsers.get(data.friendId);
      if (targetSockets) {
        const user = await prisma.user.findUnique({
          where: { id: userId },
          select: { id: true, username: true, displayName: true, avatar: true },
        });
        for (const sid of targetSockets) {
          io.to(sid).emit('friend_request_accepted', { from: user });
        }
      }
    });

    socket.on('friend_removed', async (data: { friendId: string }) => {
      if (!data.friendId || typeof data.friendId !== 'string') return;
      // Verify friendship was actually deleted (no record exists)
      const friendship = await prisma.friendship.findFirst({
        where: {
          OR: [
            { userId, friendId: data.friendId },
            { userId: data.friendId, friendId: userId },
          ],
        },
      });
      // If friendship still exists, don't emit removal
      if (friendship) return;

      const targetSockets = onlineUsers.get(data.friendId);
      if (targetSockets) {
        for (const sid of targetSockets) {
          io.to(sid).emit('friend_removed', { userId });
        }
      }
    });

    // Отключение
    socket.on('disconnect', async () => {
      console.log(`Пользователь отключился: ${userId}`);

      // Remove from active group calls
      for (const [chatId, participants] of activeGroupCalls) {
        if (participants.has(userId)) {
          participants.delete(userId);
          for (const pid of participants) {
            const pSockets = onlineUsers.get(pid);
            if (pSockets) {
              for (const sid of pSockets) {
                io.to(sid).emit('group_call_user_left', { chatId, userId });
              }
            }
          }
          if (participants.size === 0) {
            activeGroupCalls.delete(chatId);
          }
          io.to(`chat:${chatId}`).emit('group_call_active', {
            chatId,
            participants: participants.size > 0 ? Array.from(participants) : [],
            callType: 'voice',
          });
        }
      }

      const userSockets = onlineUsers.get(userId);
      if (userSockets) {
        userSockets.delete(socket.id);
        if (userSockets.size === 0) {
          onlineUsers.delete(userId);

          await prisma.user.update({
            where: { id: userId },
            data: { isOnline: false, lastSeen: new Date() },
          });

          socket.broadcast.emit('user_offline', {
            userId,
            lastSeen: new Date().toISOString(),
          });
        }
      }
    });
  });
}

async function rescheduleMessages(io: Server) {
  try {
    const scheduled = await prisma.message.findMany({
      where: {
        scheduledAt: { not: null },
      },
      include: {
        sender: { select: SENDER_SELECT },
        forwardedFrom: { select: SENDER_SELECT },
        replyTo: {
          include: { sender: { select: { id: true, username: true, displayName: true } } },
        },
        media: true,
        reactions: true,
        readBy: true,
      },
    });

    for (let i = 0; i < scheduled.length; i++) {
      const msg = scheduled[i];
      // Stagger overdue messages by 100ms each to avoid simultaneous DB spike
      const rawDelay = new Date(msg.scheduledAt!).getTime() - Date.now();
      const delay = Math.min(Math.max(i * 100, rawDelay), MAX_TIMEOUT);
      setTimeout(async () => {
        try {
          // Check if message was deleted while waiting
          const current = await prisma.message.findUnique({ where: { id: msg.id } });
          if (!current || current.isDeleted) return;

          await prisma.message.update({
            where: { id: msg.id },
            data: { scheduledAt: null },
          });

          // Create sender read receipt
          await prisma.readReceipt.upsert({
            where: { messageId_userId: { messageId: msg.id, userId: msg.senderId } },
            create: { messageId: msg.id, userId: msg.senderId },
            update: {},
          });

          const updated = await prisma.message.findUnique({
            where: { id: msg.id },
            include: {
              sender: { select: SENDER_SELECT },
              forwardedFrom: { select: SENDER_SELECT },
              replyTo: {
                include: { sender: { select: { id: true, username: true, displayName: true } } },
              },
              media: true,
              reactions: true,
              readBy: true,
            },
          });

          if (updated) {
            io.to(`chat:${msg.chatId}`).emit('scheduled_delivered', {
              ...updated,
              readBy: updated.readBy.map(r => ({ userId: r.userId })),
            });
          }
        } catch (err) {
          console.error('Scheduled delivery error:', err);
        }
      }, delay);
    }

    if (scheduled.length > 0) {
      console.log(`  ✔ ${scheduled.length} scheduled message(s) re-armed`);
    }
  } catch (err) {
    console.error('Error rescheduling messages:', err);
  }
}
