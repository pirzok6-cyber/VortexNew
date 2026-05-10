import { PrismaClient } from '@prisma/client';
import { encryptText, decryptText, isEncryptionEnabled } from './encrypt';

const basePrisma = new PrismaClient();

// ─── Prisma extension: transparent message encryption ───────────────
// Encrypts `content` and `quote` before writing to DB,
// decrypts them after reading. This way the DB never stores plaintext.

export const prisma = basePrisma.$extends({
  query: {
    message: {
      async create({ args, query }) {
        if (args.data.content && typeof args.data.content === 'string') {
          args.data.content = encryptText(args.data.content);
        }
        if (args.data.quote && typeof args.data.quote === 'string') {
          args.data.quote = encryptText(args.data.quote);
        }
        const result = await query(args);
        decryptMessageFields(result as Record<string, unknown>);
        return result;
      },
      async update({ args, query }) {
        if (args.data.content && typeof args.data.content === 'string') {
          args.data.content = encryptText(args.data.content);
        }
        if (args.data.quote && typeof args.data.quote === 'string') {
          args.data.quote = encryptText(args.data.quote);
        }
        const result = await query(args);
        decryptMessageFields(result as Record<string, unknown>);
        return result;
      },
      async upsert({ args, query }) {
        if (args.create.content && typeof args.create.content === 'string') {
          args.create.content = encryptText(args.create.content);
        }
        if (args.create.quote && typeof args.create.quote === 'string') {
          args.create.quote = encryptText(args.create.quote);
        }
        if (args.update.content && typeof args.update.content === 'string') {
          (args.update as Record<string, unknown>).content = encryptText(args.update.content as string);
        }
        if (args.update.quote && typeof args.update.quote === 'string') {
          (args.update as Record<string, unknown>).quote = encryptText(args.update.quote as string);
        }
        const result = await query(args);
        decryptMessageFields(result as Record<string, unknown>);
        return result;
      },
      async findUnique({ args, query }) {
        const result = await query(args);
        if (result) decryptMessageFields(result as Record<string, unknown>);
        return result;
      },
      async findFirst({ args, query }) {
        const result = await query(args);
        if (result) decryptMessageFields(result as Record<string, unknown>);
        return result;
      },
      async findMany({ args, query }) {
        const results = await query(args);
        for (const item of results) {
          decryptMessageFields(item as Record<string, unknown>);
        }
        return results;
      },
    },
    // Also decrypt messages nested inside Chat queries
    chat: {
      async findMany({ args, query }) {
        const results = await query(args);
        for (const chat of results) {
          decryptChatMessages(chat as Record<string, unknown>);
        }
        return results;
      },
      async findFirst({ args, query }) {
        const result = await query(args);
        if (result) decryptChatMessages(result as Record<string, unknown>);
        return result;
      },
      async findUnique({ args, query }) {
        const result = await query(args);
        if (result) decryptChatMessages(result as Record<string, unknown>);
        return result;
      },
      async create({ args, query }) {
        const result = await query(args);
        decryptChatMessages(result as Record<string, unknown>);
        return result;
      },
    },
    // Decrypt message inside PinnedMessage queries
    pinnedMessage: {
      async findFirst({ args, query }) {
        const result = await query(args);
        if (result) decryptNested(result as Record<string, unknown>);
        return result;
      },
      async findMany({ args, query }) {
        const results = await query(args);
        for (const item of results) decryptNested(item as Record<string, unknown>);
        return results;
      },
    },
  },
});

/** Decrypt content/quote on a message-shaped object. */
function decryptMessageFields(obj: Record<string, unknown> | null): void {
  if (!obj || typeof obj !== 'object' || !isEncryptionEnabled()) return;

  if (typeof obj.content === 'string') {
    obj.content = decryptText(obj.content);
  }
  if (typeof obj.quote === 'string') {
    obj.quote = decryptText(obj.quote);
  }
  // Nested replyTo
  if (obj.replyTo && typeof obj.replyTo === 'object') {
    decryptMessageFields(obj.replyTo as Record<string, unknown>);
  }
}

/** Decrypt messages nested inside a chat object. */
function decryptChatMessages(chat: Record<string, unknown>): void {
  if (!chat || !isEncryptionEnabled()) return;
  if (Array.isArray(chat.messages)) {
    for (const msg of chat.messages) {
      decryptMessageFields(msg as Record<string, unknown>);
    }
  }
  // pinnedMessages[].message
  if (Array.isArray(chat.pinnedMessages)) {
    for (const pm of chat.pinnedMessages) {
      const pmo = pm as Record<string, unknown>;
      if (pmo.message && typeof pmo.message === 'object') {
        decryptMessageFields(pmo.message as Record<string, unknown>);
      }
    }
  }
}

/** Decrypt nested message field on any object (e.g. PinnedMessage.message). */
function decryptNested(obj: Record<string, unknown>): void {
  if (!obj || !isEncryptionEnabled()) return;
  if (obj.message && typeof obj.message === 'object') {
    decryptMessageFields(obj.message as Record<string, unknown>);
  }
}

