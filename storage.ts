/**
 * storage.ts — абстракция над хранилищем файлов.
 *
 * Если заданы R2_ACCOUNT_ID, R2_ACCESS_KEY_ID, R2_SECRET_ACCESS_KEY, R2_BUCKET_NAME —
 * файлы хранятся в Cloudflare R2 (S3-совместимый).
 * Иначе — на локальном диске (для локальной разработки).
 *
 * Публичные URL:
 *   R2 с кастомным доменом: R2_PUBLIC_URL/ключ
 *   R2 без домена:          через /uploads/... прокси на сервере (не рекомендуется для prod)
 *   Локально:               /uploads/ключ
 */

import fs from 'fs';
import path from 'path';
import { Readable } from 'stream';

// ─── Типы ────────────────────────────────────────────────────────────

export interface UploadResult {
  /** Публичный URL для сохранения в БД, например /uploads/avatars/abc.jpg или https://cdn.example.com/avatars/abc.jpg */
  url: string;
  /** Ключ в хранилище (относительный путь), например avatars/abc.jpg */
  key: string;
}

// ─── Определяем режим ────────────────────────────────────────────────

function isR2Configured(): boolean {
  return !!(
    process.env.R2_ACCOUNT_ID &&
    process.env.R2_ACCESS_KEY_ID &&
    process.env.R2_SECRET_ACCESS_KEY &&
    process.env.R2_BUCKET_NAME
  );
}

// ─── R2 через AWS SDK v3 (S3-совместимый) ───────────────────────────

let s3Client: import('@aws-sdk/client-s3').S3Client | null = null;

async function getS3Client() {
  if (s3Client) return s3Client;
  const { S3Client } = await import('@aws-sdk/client-s3');
  s3Client = new S3Client({
    region: 'auto',
    endpoint: `https://${process.env.R2_ACCOUNT_ID}.r2.cloudflarestorage.com`,
    credentials: {
      accessKeyId: process.env.R2_ACCESS_KEY_ID!,
      secretAccessKey: process.env.R2_SECRET_ACCESS_KEY!,
    },
  });
  return s3Client;
}

async function uploadToR2(key: string, buffer: Buffer, contentType: string): Promise<UploadResult> {
  const { PutObjectCommand } = await import('@aws-sdk/client-s3');
  const client = await getS3Client();

  await client.send(new PutObjectCommand({
    Bucket: process.env.R2_BUCKET_NAME!,
    Key: key,
    Body: buffer,
    ContentType: contentType,
  }));

  // Если задан публичный домен (R2 custom domain или R2.dev публичный bucket)
  const publicBase = process.env.R2_PUBLIC_URL?.replace(/\/$/, '');
  const url = publicBase
    ? `${publicBase}/${key}`
    : `/uploads/${key}`; // fallback — отдаём через наш прокси

  return { url, key };
}

async function deleteFromR2(key: string): Promise<void> {
  const { DeleteObjectCommand } = await import('@aws-sdk/client-s3');
  const client = await getS3Client();
  await client.send(new DeleteObjectCommand({
    Bucket: process.env.R2_BUCKET_NAME!,
    Key: key,
  }));
}

async function getFromR2(key: string): Promise<Buffer | null> {
  const { GetObjectCommand } = await import('@aws-sdk/client-s3');
  const client = await getS3Client();
  try {
    const response = await client.send(new GetObjectCommand({
      Bucket: process.env.R2_BUCKET_NAME!,
      Key: key,
    }));
    if (!response.Body) return null;
    const chunks: Buffer[] = [];
    for await (const chunk of response.Body as AsyncIterable<Uint8Array>) {
      chunks.push(Buffer.from(chunk));
    }
    return Buffer.concat(chunks);
  } catch {
    return null;
  }
}

// ─── Локальный диск ──────────────────────────────────────────────────

const UPLOADS_ROOT_LOCAL = path.join(__dirname, '../uploads');

function ensureDir(dirPath: string): void {
  if (!fs.existsSync(dirPath)) fs.mkdirSync(dirPath, { recursive: true });
}

function uploadToLocal(key: string, buffer: Buffer): UploadResult {
  const filePath = path.join(UPLOADS_ROOT_LOCAL, key);
  ensureDir(path.dirname(filePath));
  fs.writeFileSync(filePath, buffer);
  return { url: `/uploads/${key}`, key };
}

function deleteFromLocal(key: string): void {
  const filePath = path.join(UPLOADS_ROOT_LOCAL, key);
  if (fs.existsSync(filePath)) fs.unlinkSync(filePath);
}

function getFromLocal(key: string): Buffer | null {
  const filePath = path.join(UPLOADS_ROOT_LOCAL, key);
  if (!fs.existsSync(filePath)) return null;
  return fs.readFileSync(filePath);
}

// ─── Публичное API ───────────────────────────────────────────────────

/**
 * Загрузить файл в хранилище.
 * @param key  Относительный путь, например "avatars/abc.jpg" или "voice/abc.webm"
 * @param buffer  Содержимое файла
 * @param contentType  MIME-тип
 */
export async function storageUpload(key: string, buffer: Buffer, contentType: string): Promise<UploadResult> {
  if (isR2Configured()) {
    return uploadToR2(key, buffer, contentType);
  }
  return uploadToLocal(key, buffer);
}

/**
 * Удалить файл из хранилища по его URL из БД.
 * Принимает как /uploads/avatars/abc.jpg, так и https://cdn.example.com/avatars/abc.jpg
 */
export async function storageDelete(urlOrKey: string): Promise<void> {
  if (!urlOrKey) return;
  const key = urlToKey(urlOrKey);
  if (!key) return;

  try {
    if (isR2Configured()) {
      await deleteFromR2(key);
    } else {
      deleteFromLocal(key);
    }
  } catch (e) {
    console.error('storageDelete error:', urlOrKey, e);
  }
}

/**
 * Получить файл из хранилища как Buffer.
 * Используется для прокси-раздачи R2-файлов через /uploads/... если нет публичного домена.
 */
export async function storageGet(key: string): Promise<Buffer | null> {
  if (isR2Configured()) {
    return getFromR2(key);
  }
  return getFromLocal(key);
}

/** Вернуть true если используется R2 */
export function isR2(): boolean {
  return isR2Configured();
}

/** Абсолютный путь к папке uploads (только для локального режима) */
export const UPLOADS_ROOT = UPLOADS_ROOT_LOCAL;

// ─── Вспомогательные функции ─────────────────────────────────────────

/**
 * Преобразует URL из БД в ключ хранилища.
 * /uploads/avatars/abc.jpg       → avatars/abc.jpg
 * https://cdn.example.com/a.jpg  → a.jpg (убираем только домен)
 */
export function urlToKey(url: string): string | null {
  if (!url) return null;

  // Локальный URL
  if (url.startsWith('/uploads/')) {
    return url.slice('/uploads/'.length);
  }

  // R2 публичный URL
  const publicBase = process.env.R2_PUBLIC_URL?.replace(/\/$/, '');
  if (publicBase && url.startsWith(publicBase + '/')) {
    return url.slice(publicBase.length + 1);
  }

  // Уже ключ (без слеша в начале)
  if (!url.startsWith('/') && !url.startsWith('http')) {
    return url;
  }

  return null;
}
