import { Router } from 'express';
import { prisma } from '../db';
import { AuthRequest } from '../middleware/auth';

const router = Router();

// ─── Validation helpers ──────────────────────────────────────────────
const B64_RE = /^[A-Za-z0-9+/=_-]+$/;
function isBase64(s: unknown, maxLen = 1024): s is string {
  return typeof s === 'string' && s.length > 0 && s.length <= maxLen && B64_RE.test(s);
}

// ─── Publish identity key + signed prekey + batch of one-time prekeys ───
// Called once on first login (client generates all keys locally).
// POST /api/keys/bundle
router.post('/bundle', async (req: AuthRequest, res) => {
  try {
    const {
      identityKey,
      signedPreKey,   // { keyId: number, publicKey: base64, signature: base64 }
      oneTimePreKeys, // [{ keyId: number, publicKey: base64 }, ...]
    } = req.body as {
      identityKey?: string;
      signedPreKey?: { keyId?: number; publicKey?: string; signature?: string };
      oneTimePreKeys?: Array<{ keyId?: number; publicKey?: string }>;
    };

    if (!isBase64(identityKey)) {
      res.status(400).json({ error: 'Некорректный identityKey' });
      return;
    }
    if (!signedPreKey || typeof signedPreKey.keyId !== 'number' ||
        !isBase64(signedPreKey.publicKey) || !isBase64(signedPreKey.signature)) {
      res.status(400).json({ error: 'Некорректный signedPreKey' });
      return;
    }
    if (!Array.isArray(oneTimePreKeys) || oneTimePreKeys.length === 0 || oneTimePreKeys.length > 100) {
      res.status(400).json({ error: 'oneTimePreKeys: от 1 до 100 элементов' });
      return;
    }

    for (const pk of oneTimePreKeys) {
      if (typeof pk.keyId !== 'number' || !isBase64(pk.publicKey)) {
        res.status(400).json({ error: 'Некорректный one-time prekey' });
        return;
      }
    }

    // Upsert identity key (one per user)
    await prisma.identityKey.upsert({
      where: { userId: req.userId! },
      create: { userId: req.userId!, publicKey: identityKey as string },
      update: { publicKey: identityKey as string },
    });

    // Upsert signed prekey by (userId, keyId)
    await prisma.signedPreKey.upsert({
      where: { userId_keyId: { userId: req.userId!, keyId: signedPreKey.keyId! } },
      create: {
        userId: req.userId!,
        keyId: signedPreKey.keyId!,
        publicKey: signedPreKey.publicKey as string,
        signature: signedPreKey.signature as string,
      },
      update: {
        publicKey: signedPreKey.publicKey as string,
        signature: signedPreKey.signature as string,
      },
    });

    // Insert one-time prekeys, skipping duplicates by (userId, keyId)
    for (const pk of oneTimePreKeys) {
      await prisma.oneTimePreKey.upsert({
        where: { userId_keyId: { userId: req.userId!, keyId: pk.keyId! } },
        create: {
          userId: req.userId!,
          keyId: pk.keyId!,
          publicKey: pk.publicKey as string,
        },
        update: {},
      });
    }

    const remaining = await prisma.oneTimePreKey.count({
      where: { userId: req.userId!, consumed: false },
    });

    res.json({ success: true, oneTimePreKeysRemaining: remaining });
  } catch (e) {
    console.error('Key bundle publish error:', e);
    res.status(500).json({ error: 'Ошибка публикации ключей' });
  }
});

// ─── Fetch a pre-key bundle for another user (consumes one-time prekey) ───
// GET /api/keys/bundle/:userId
router.get('/bundle/:userId', async (req: AuthRequest, res) => {
  try {
    const targetId = String(req.params.userId);

    const [identity, signed] = await Promise.all([
      prisma.identityKey.findUnique({ where: { userId: targetId } }),
      prisma.signedPreKey.findFirst({
        where: { userId: targetId },
        orderBy: { createdAt: 'desc' },
      }),
    ]);

    if (!identity || !signed) {
      res.status(404).json({ error: 'У пользователя нет опубликованных ключей' });
      return;
    }

    // ─── Atomic OTK consumption via a single SQL statement with RETURNING.
    // SQLite 3.35+ serialises writers, so exactly one concurrent caller
    // receives each row. The outer `consumed = 0` guard protects against
    // the rare case where the subselect picked a row that another writer
    // claimed between the SELECT and the UPDATE.
    const claimed = await prisma.$queryRaw<Array<{ id: string; keyId: number; publicKey: string }>>`
      UPDATE OneTimePreKey
         SET consumed = 1
       WHERE id = (
             SELECT id FROM OneTimePreKey
              WHERE userId = ${targetId} AND consumed = 0
              ORDER BY createdAt ASC
              LIMIT 1
           )
         AND consumed = 0
      RETURNING id, keyId, publicKey
    `;
    const oneTime = claimed.length === 1 ? claimed[0] : null;

    res.json({
      userId: targetId,
      identityKey: identity.publicKey,
      signedPreKey: {
        keyId: signed.keyId,
        publicKey: signed.publicKey,
        signature: signed.signature,
      },
      oneTimePreKey: oneTime
        ? { keyId: oneTime.keyId, publicKey: oneTime.publicKey }
        : null,
    });
  } catch (e) {
    console.error('Fetch bundle error:', e);
    res.status(500).json({ error: 'Ошибка получения ключей' });
  }
});

// ─── Replenish one-time prekeys (client monitors count) ───
// POST /api/keys/prekeys
router.post('/prekeys', async (req: AuthRequest, res) => {
  try {
    const { oneTimePreKeys } = req.body as {
      oneTimePreKeys?: Array<{ keyId?: number; publicKey?: string }>;
    };
    if (!Array.isArray(oneTimePreKeys) || oneTimePreKeys.length === 0 || oneTimePreKeys.length > 100) {
      res.status(400).json({ error: 'oneTimePreKeys: от 1 до 100' });
      return;
    }
    for (const pk of oneTimePreKeys) {
      if (typeof pk.keyId !== 'number' || !isBase64(pk.publicKey)) {
        res.status(400).json({ error: 'Некорректный prekey' });
        return;
      }
    }
    for (const pk of oneTimePreKeys) {
      await prisma.oneTimePreKey.upsert({
        where: { userId_keyId: { userId: req.userId!, keyId: pk.keyId! } },
        create: { userId: req.userId!, keyId: pk.keyId!, publicKey: pk.publicKey as string },
        update: {},
      });
    }
    const remaining = await prisma.oneTimePreKey.count({
      where: { userId: req.userId!, consumed: false },
    });
    res.json({ success: true, oneTimePreKeysRemaining: remaining });
  } catch (e) {
    console.error('Prekey replenish error:', e);
    res.status(500).json({ error: 'Ошибка' });
  }
});

// ─── Rotate signed prekey ───
// POST /api/keys/signed-prekey
router.post('/signed-prekey', async (req: AuthRequest, res) => {
  try {
    const { keyId, publicKey, signature } = req.body as {
      keyId?: number; publicKey?: string; signature?: string;
    };
    if (typeof keyId !== 'number' || !isBase64(publicKey) || !isBase64(signature)) {
      res.status(400).json({ error: 'Некорректные поля' });
      return;
    }
    await prisma.signedPreKey.upsert({
      where: { userId_keyId: { userId: req.userId!, keyId } },
      create: { userId: req.userId!, keyId, publicKey: publicKey as string, signature: signature as string },
      update: { publicKey: publicKey as string, signature: signature as string },
    });
    res.json({ success: true });
  } catch (e) {
    console.error('Signed prekey rotate error:', e);
    res.status(500).json({ error: 'Ошибка' });
  }
});

// ─── Status / counts ───
// GET /api/keys/status
router.get('/status', async (req: AuthRequest, res) => {
  const [identity, signed, oneTimeCount] = await Promise.all([
    prisma.identityKey.findUnique({ where: { userId: req.userId! } }),
    prisma.signedPreKey.findFirst({ where: { userId: req.userId! }, orderBy: { createdAt: 'desc' } }),
    prisma.oneTimePreKey.count({ where: { userId: req.userId!, consumed: false } }),
  ]);
  res.json({
    hasIdentityKey: !!identity,
    hasSignedPreKey: !!signed,
    signedPreKeyId: signed?.keyId ?? null,
    oneTimePreKeysRemaining: oneTimeCount,
  });
});

export default router;
