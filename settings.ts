import { Router } from 'express';
import { prisma } from '../db';
import { AuthRequest } from '../middleware/auth';

const router = Router();

// ─── Whitelist of updatable fields with validators ────────────────────
const STR_ENUMS: Record<string, readonly string[]> = {
  theme: ['light', 'dark', 'system'],
  fontSize: ['small', 'medium', 'large'],
  language: ['ru', 'en'],
  whoCanMessageMe: ['everyone', 'friends', 'nobody'],
  whoCanCallMe: ['everyone', 'friends', 'nobody'],
  videoQuality: ['sd', 'hd', 'fhd'],
  autoDownloadMedia: ['always', 'wifi', 'never'],
  deviceType: ['auto', 'phone', 'tablet', 'laptop', 'desktop'],
  audioOutput: ['auto', 'earpiece', 'speaker', 'wired', 'bluetooth', 'system'],
  audioInput:  ['auto', 'builtin', 'wired', 'bluetooth'],
};

const BOOL_FIELDS = new Set([
  'notifyEnabled', 'notifySound', 'notifyPreview', 'notifyReactions', 'notifyMentions',
  'showOnline', 'showLastSeen', 'showReadReceipts', 'showTyping',
  'echoCancellation', 'noiseSuppression', 'autoGainControl', 'mirrorSelfView',
  'enterToSend', 'e2eeByDefault', 'autoSwitchAudioOutput',
]);

const STR_FIELDS = new Set([
  'accentColor',
  'defaultMicId', 'defaultMicLabel',
  'defaultCameraId', 'defaultCameraLabel',
  'defaultSpeakerId', 'defaultSpeakerLabel',
  'chatWallpaper',
]);

// GET /api/settings — returns user's settings (creating defaults if missing)
router.get('/', async (req: AuthRequest, res) => {
  try {
    const settings = await prisma.userSettings.upsert({
      where: { userId: req.userId! },
      create: { userId: req.userId! },
      update: {},
    });
    res.json(settings);
  } catch (e) {
    console.error('Settings GET error:', e);
    res.status(500).json({ error: 'Ошибка получения настроек' });
  }
});

// PUT /api/settings — partial update (any subset of whitelisted fields)
router.put('/', async (req: AuthRequest, res) => {
  try {
    const body = req.body as Record<string, unknown>;
    const data: Record<string, unknown> = {};

    for (const [key, value] of Object.entries(body)) {
      // Enum strings
      if (key in STR_ENUMS) {
        if (typeof value !== 'string' || !STR_ENUMS[key].includes(value)) {
          res.status(400).json({ error: `Некорректное значение для ${key}` });
          return;
        }
        data[key] = value;
        continue;
      }
      // Booleans
      if (BOOL_FIELDS.has(key)) {
        if (typeof value !== 'boolean') {
          res.status(400).json({ error: `${key} должен быть boolean` });
          return;
        }
        data[key] = value;
        continue;
      }
      // Free-form strings (max 500 chars, or null to clear)
      if (STR_FIELDS.has(key)) {
        if (value === null) {
          data[key] = null;
          continue;
        }
        if (typeof value !== 'string' || value.length > 500) {
          res.status(400).json({ error: `${key}: строка до 500 символов` });
          return;
        }
        data[key] = value;
        continue;
      }
      // Silently ignore unknown fields
    }

    if (Object.keys(data).length === 0) {
      res.status(400).json({ error: 'Нет допустимых полей для обновления' });
      return;
    }

    const settings = await prisma.userSettings.upsert({
      where: { userId: req.userId! },
      create: { userId: req.userId!, ...data },
      update: data,
    });
    res.json(settings);
  } catch (e) {
    console.error('Settings PUT error:', e);
    res.status(500).json({ error: 'Ошибка сохранения настроек' });
  }
});

// POST /api/settings/reset — reset all settings to defaults
router.post('/reset', async (req: AuthRequest, res) => {
  try {
    await prisma.userSettings.deleteMany({ where: { userId: req.userId! } });
    const settings = await prisma.userSettings.create({ data: { userId: req.userId! } });
    res.json(settings);
  } catch (e) {
    console.error('Settings reset error:', e);
    res.status(500).json({ error: 'Ошибка сброса настроек' });
  }
});

export default router;
