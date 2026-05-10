import multer from 'multer';
import path from 'path';
import { v4 as uuidv4 } from 'uuid';
import { Request, Response, NextFunction } from 'express';
import { encryptBuffer, isEncryptionEnabled } from './encrypt';
import { storageUpload, storageDelete } from './storage';

// ─── Prisma select objects ────────────────────────────────────────────

export const USER_SELECT = {
  id: true,
  username: true,
  displayName: true,
  avatar: true,
  bio: true,
  birthday: true,
  isOnline: true,
  lastSeen: true,
  createdAt: true,
  hideStoryViews: true,
} as const;

export const SENDER_SELECT = {
  id: true,
  username: true,
  displayName: true,
  avatar: true,
} as const;

export const MESSAGE_INCLUDE = {
  sender: { select: SENDER_SELECT },
  forwardedFrom: { select: SENDER_SELECT },
  replyTo: {
    include: { sender: { select: { id: true, username: true, displayName: true } } },
  },
  media: true,
  reactions: {
    include: { user: { select: { id: true, username: true, displayName: true } } },
  },
  readBy: { select: { userId: true } },
} as const;

// ─── Удаление файлов (через storage.ts) ──────────────────────────────

/** Удалить файл из хранилища по URL из БД. */
export function deleteUploadedFile(urlPath: string): void {
  if (!urlPath) return;
  // Fire-and-forget — ошибки логируем, но не бросаем
  storageDelete(urlPath).catch(e => console.error('deleteUploadedFile error:', urlPath, e));
}

// ─── Multer: memory storage (работает везде — локально и в облаке) ───

const ALLOWED_IMAGE_EXT = new Set(['.jpg', '.jpeg', '.png', '.gif', '.webp', '.avif']);
const ALLOWED_VOICE_MIME = new Set([
  'audio/webm', 'audio/ogg', 'audio/mpeg', 'audio/mp4',
  'audio/wav', 'audio/x-wav', 'audio/aac', 'audio/x-m4a',
]);
const ALLOWED_VOICE_EXT = new Set(['.webm', '.ogg', '.opus', '.mp3', '.m4a', '.wav', '.aac']);
const BLOCKED_EXTENSIONS = new Set([
  '.html', '.htm', '.svg', '.xml', '.xhtml',
  '.php', '.jsp', '.asp', '.aspx', '.cgi',
  '.exe', '.bat', '.cmd', '.com', '.msi', '.scr', '.pif',
  '.sh', '.bash', '.ps1', '.psm1', '.vbs', '.vbe', '.js', '.jse', '.wsf', '.wsh',
  '.dll', '.sys', '.drv',
  '.hta', '.cpl', '.inf', '.reg',
]);

const memoryStorage = multer.memoryStorage();

export const uploadUserAvatar = multer({
  storage: memoryStorage,
  limits: { fileSize: 5 * 1024 * 1024 },
  fileFilter: (_req, file, cb) => {
    const ext = path.extname(file.originalname).toLowerCase();
    if (file.mimetype.startsWith('image/') && ALLOWED_IMAGE_EXT.has(ext)) cb(null, true);
    else cb(new Error('Только изображения (jpg, png, gif, webp, avif)'));
  },
});

export const uploadGroupAvatar = multer({
  storage: memoryStorage,
  limits: { fileSize: 5 * 1024 * 1024 },
  fileFilter: (_req, file, cb) => {
    const ext = path.extname(file.originalname).toLowerCase();
    if (file.mimetype.startsWith('image/') && ALLOWED_IMAGE_EXT.has(ext)) cb(null, true);
    else cb(new Error('Только изображения (jpg, png, gif, webp, avif)'));
  },
});

export const uploadVoice = multer({
  storage: memoryStorage,
  limits: { fileSize: 25 * 1024 * 1024 },
  fileFilter: (_req, file, cb) => {
    const ext = path.extname(file.originalname).toLowerCase();
    if (ALLOWED_VOICE_MIME.has(file.mimetype) || ALLOWED_VOICE_EXT.has(ext)) cb(null, true);
    else cb(new Error('Только аудио: webm, ogg, mp3, m4a, wav, aac'));
  },
});

export const uploadFile = multer({
  storage: memoryStorage,
  limits: { fileSize: 50 * 1024 * 1024 },
  fileFilter: (_req, file, cb) => {
    const ext = path.extname(file.originalname).toLowerCase();
    if (BLOCKED_EXTENSIONS.has(ext)) cb(new Error('Этот тип файла не разрешён'));
    else cb(null, true);
  },
});

// ─── Post-upload middleware: шифрование + сохранение в хранилище ─────

/**
 * Express middleware — после multer (memoryStorage) шифрует буфер (если включено)
 * и загружает файл в хранилище (R2 или локальный диск).
 *
 * Заменяет req.file.path / req.file.filename / req.file.buffer на:
 *   req.file.storageUrl  — URL для сохранения в БД
 *   req.file.storageKey  — ключ в хранилище
 *
 * @param folder  Папка внутри хранилища, например "avatars" или "voice"
 * @param prefix  Необязательный префикс имени файла, например "group-"
 */
export function saveUploadedFile(folder: string, prefix = '') {
  return async (req: Request, _res: Response, next: NextFunction): Promise<void> => {
    try {
      if (!req.file?.buffer) return next();

      const ext = path.extname(req.file.originalname).toLowerCase() || '';
      const filename = `${prefix}${uuidv4()}${ext}`;
      const key = folder ? `${folder}/${filename}` : filename;

      let buffer = req.file.buffer;

      // Шифруем буфер, если включено
      if (isEncryptionEnabled()) {
        buffer = encryptBuffer(buffer);
      }

      const result = await storageUpload(key, buffer, req.file.mimetype);

      // Пишем результат обратно в req.file, чтобы роут мог прочитать URL
      (req.file as any).storageUrl = result.url;
      (req.file as any).storageKey = result.key;

      next();
    } catch (e) {
      console.error('saveUploadedFile error:', e);
      next(e);
    }
  };
}

/**
 * Обратная совместимость: старые роуты используют encryptUploadedFile как middleware.
 * Теперь это no-op — шифрование и загрузка выполняются в saveUploadedFile.
 * @deprecated Используй saveUploadedFile вместо этого.
 */
export function encryptUploadedFile(_req: Request, _res: Response, next: NextFunction): void {
  next();
}

// ─── Вспомогательные функции ─────────────────────────────────────────

/** @deprecated Используй storageDelete из storage.ts */
export function ensureDir(): void {
  // no-op в облачном режиме; оставлено для обратной совместимости
}
