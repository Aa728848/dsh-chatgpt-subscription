/**
 * Workspace-safe file transfer for MiniMax Matrix image and audio tools.
 * @module dsh-chatgpt-subscription/minimax-code/media-files
 */

import fs from 'node:fs/promises'
import path from 'node:path'
import { HarnessError } from '@deepseek-ai/dsh-llm'
import { assertPublicFetchTarget, lookupHostAddresses } from '../../infra/network/fetch-address-policy.ts'
import { MATRIX_TOOL_GET_UPLOAD_URL, callMatrixTool, matrixPayloadField } from './matrix-client.ts'
import { resolveSessionRoot, type MediaStoreExec } from './media-store.ts'

export const MAX_IMAGE_FILE_BYTES = 25 * 1024 * 1024
export const MAX_AUDIO_FILE_BYTES = 100 * 1024 * 1024
export const MAX_REPORT_BYTES = 2 * 1024 * 1024

const IMAGE_TYPES: Readonly<Record<string, string>> = {
  '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.png': 'image/png', '.webp': 'image/webp',
  '.gif': 'image/gif', '.bmp': 'image/bmp', '.heic': 'image/heic', '.heif': 'image/heif',
}
const AUDIO_TYPES: Readonly<Record<string, string>> = {
  '.mp3': 'audio/mpeg', '.wav': 'audio/wav', '.pcm': 'audio/pcm', '.m4a': 'audio/mp4',
  '.aac': 'audio/aac', '.ogg': 'audio/ogg', '.oga': 'audio/ogg', '.flac': 'audio/flac', '.opus': 'audio/opus',
}

export interface LocalMediaFile {
  readonly absolutePath: string
  readonly name: string
  readonly mediaType: string
  readonly data: Uint8Array
}

export interface StoredMediaFile {
  readonly absolutePath: string
  readonly relativePath: string
  readonly bytes: number
}

export interface MatrixCredential {
  readonly accessToken: string
  readonly region: 'cn' | 'global'
}

function inside(root: string, candidate: string): boolean {
  const relative = path.relative(root, candidate)
  return relative === '' || (relative !== '..' && !relative.startsWith('..' + path.sep) && !path.isAbsolute(relative))
}

function inputPath(value: string): string {
  const trimmed = value.trim()
  if (trimmed.toLowerCase().startsWith('file://')) {
    try { return new URL(trimmed).pathname.replace(/^\/([A-Za-z]:)/, '$1') } catch { return trimmed }
  }
  return trimmed
}

export async function workspaceRootOf(
  ctx: Parameters<typeof resolveSessionRoot>[0],
  exec: MediaStoreExec,
): Promise<string> {
  const resolved = await resolveSessionRoot(ctx, exec)
  if (resolved !== undefined) return resolved.root
  throw new HarnessError(
    'MiniMax media tools need a session workspace. Open a project directory and retry.',
    'MINIMAX_MEDIA_NO_WORKSPACE',
  )
}

async function assertPublicUrl(value: string, what: string): Promise<URL> {
  const url = new URL(value)
  if (url.protocol !== 'https:' && url.protocol !== 'http:') {
    throw new HarnessError(what + ' must use http(s)', 'MINIMAX_MEDIA_URL_REJECTED')
  }
  const addresses = await lookupHostAddresses(url.hostname)
  assertPublicFetchTarget(url.hostname, addresses)
  return url
}

export async function readWorkspaceMedia(
  root: string,
  requestedPath: string,
  kind: 'image' | 'audio',
  maxBytes: number = kind === 'image' ? MAX_IMAGE_FILE_BYTES : MAX_AUDIO_FILE_BYTES,
): Promise<LocalMediaFile> {
  const raw = inputPath(requestedPath)
  if (raw === '') throw new HarnessError(kind + ' path cannot be empty', 'MINIMAX_MEDIA_PATH_EMPTY')
  const candidate = path.resolve(root, raw)
  if (!inside(root, candidate)) {
    throw new HarnessError(kind + ' input must stay inside the session workspace: ' + requestedPath, 'MINIMAX_MEDIA_PATH_ESCAPE')
  }
  const realRoot = await fs.realpath(root)
  const absolutePath = await fs.realpath(candidate).catch(() => undefined)
  if (absolutePath === undefined || !inside(realRoot, absolutePath)) {
    throw new HarnessError(kind + ' file was not found inside the session workspace: ' + requestedPath, 'MINIMAX_MEDIA_NOT_FOUND')
  }
  const stats = await fs.stat(absolutePath)
  if (!stats.isFile()) throw new HarnessError(kind + ' path is not a regular file: ' + requestedPath, 'MINIMAX_MEDIA_NOT_A_FILE')
  if (stats.size <= 0) throw new HarnessError(kind + ' file is empty: ' + requestedPath, 'MINIMAX_MEDIA_EMPTY_INPUT')
  if (stats.size > maxBytes) {
    throw new HarnessError(
      kind + ' file exceeds the ' + Math.floor(maxBytes / (1024 * 1024)) + ' MB local transfer limit: ' + requestedPath,
      'MINIMAX_MEDIA_INPUT_TOO_LARGE',
    )
  }
  const extension = path.extname(absolutePath).toLowerCase()
  const mediaType = (kind === 'image' ? IMAGE_TYPES : AUDIO_TYPES)[extension]
  if (mediaType === undefined) {
    const allowed = Object.keys(kind === 'image' ? IMAGE_TYPES : AUDIO_TYPES).join(' ')
    throw new HarnessError('unsupported ' + kind + ' extension ' + extension + '; supported: ' + allowed, 'MINIMAX_MEDIA_TYPE_UNSUPPORTED')
  }
  return { absolutePath, name: path.basename(absolutePath), mediaType, data: await fs.readFile(absolutePath) }
}

async function outputPathOf(root: string, requestedPath: string): Promise<{ absolutePath: string; relativePath: string }> {
  const raw = inputPath(requestedPath)
  if (raw === '') throw new HarnessError('output path cannot be empty', 'MINIMAX_MEDIA_PATH_EMPTY')
  const absolutePath = path.resolve(root, raw)
  if (!inside(root, absolutePath) || absolutePath === root) {
    throw new HarnessError('output must be a file inside the session workspace: ' + requestedPath, 'MINIMAX_MEDIA_PATH_ESCAPE')
  }
  const realRoot = await fs.realpath(root)
  await fs.mkdir(path.dirname(absolutePath), { recursive: true })
  const realParent = await fs.realpath(path.dirname(absolutePath))
  if (!inside(realRoot, realParent)) {
    throw new HarnessError('output directory resolves outside the session workspace', 'MINIMAX_MEDIA_PATH_ESCAPE')
  }
  const existing = await fs.lstat(absolutePath).catch(() => undefined)
  if (existing?.isSymbolicLink()) {
    throw new HarnessError('refusing to overwrite a symbolic link: ' + requestedPath, 'MINIMAX_MEDIA_OUTPUT_SYMLINK')
  }
  return { absolutePath, relativePath: path.relative(root, absolutePath).split(path.sep).join('/') }
}

export async function writeWorkspaceText(root: string, requestedPath: string, text: string): Promise<StoredMediaFile> {
  const data = Buffer.from(text, 'utf8')
  if (data.byteLength > MAX_REPORT_BYTES) throw new HarnessError('report exceeds the 2 MB output limit', 'MINIMAX_MEDIA_OUTPUT_TOO_LARGE')
  const output = await outputPathOf(root, requestedPath)
  await fs.writeFile(output.absolutePath, data)
  return { ...output, bytes: data.byteLength }
}

export async function downloadWorkspaceMedia(
  root: string,
  requestedPath: string,
  sourceUrl: string,
  fetchFn: typeof fetch,
  signal: AbortSignal | undefined,
  maxBytes: number,
): Promise<StoredMediaFile> {
  const output = await outputPathOf(root, requestedPath)
  const url = await assertPublicUrl(sourceUrl, 'media download URL')
  const response = await fetchFn(url, { redirect: 'error', ...(signal === undefined ? {} : { signal }) })
  if (!response.ok) {
    await response.body?.cancel().catch(() => undefined)
    throw new HarnessError('media download failed with HTTP ' + response.status, 'MINIMAX_MEDIA_DOWNLOAD_FAILED')
  }
  const declared = Number(response.headers.get('content-length') ?? 0)
  if (declared > maxBytes) {
    await response.body?.cancel().catch(() => undefined)
    throw new HarnessError('downloaded media exceeds the local output limit', 'MINIMAX_MEDIA_OUTPUT_TOO_LARGE')
  }
  const chunks: Uint8Array[] = []
  let total = 0
  if (response.body !== null) {
    const reader = response.body.getReader()
    while (true) {
      const next = await reader.read()
      if (next.done) break
      total += next.value.byteLength
      if (total > maxBytes) {
        await reader.cancel().catch(() => undefined)
        throw new HarnessError('downloaded media exceeds the local output limit', 'MINIMAX_MEDIA_OUTPUT_TOO_LARGE')
      }
      chunks.push(next.value)
    }
  }
  const data = new Uint8Array(total)
  let offset = 0
  for (const chunk of chunks) { data.set(chunk, offset); offset += chunk.byteLength }
  if (data.byteLength === 0) throw new HarnessError('downloaded media is empty', 'MINIMAX_MEDIA_EMPTY_OUTPUT')
  await fs.writeFile(output.absolutePath, data)
  return { ...output, bytes: data.byteLength }
}

export async function uploadWorkspaceMedia(
  credential: MatrixCredential,
  file: LocalMediaFile,
  fetchFn: typeof fetch,
  signal?: AbortSignal,
): Promise<string> {
  const granted = await callMatrixTool({
    region: credential.region,
    accessToken: credential.accessToken,
    tool: MATRIX_TOOL_GET_UPLOAD_URL,
    body: {
      filename: file.name,
      mime_type: file.mediaType,
      size_bytes: file.data.byteLength,
      category: 'user_file_upload_tmp',
    },
    fetchFn,
    ...(signal === undefined ? {} : { signal }),
  })
  const putTarget = matrixPayloadField(granted.body, 'put_url')
  const cdnUrl = matrixPayloadField(granted.body, 'cdn_url')
  if (typeof putTarget !== 'string' || typeof cdnUrl !== 'string' || putTarget === '' || cdnUrl === '') {
    throw new HarnessError('media upload broker returned no put_url/cdn_url pair', 'MINIMAX_MEDIA_UPLOAD_FAILED')
  }
  const putUrl = await assertPublicUrl(putTarget, 'media upload URL')
  const declaredType = matrixPayloadField(granted.body, 'content_type')
  const put = await fetchFn(putUrl, {
    method: 'PUT',
    headers: { 'content-type': typeof declaredType === 'string' && declaredType !== '' ? declaredType : file.mediaType },
    body: file.data,
    redirect: 'error',
    ...(signal === undefined ? {} : { signal }),
  })
  if (!put.ok) {
    await put.body?.cancel().catch(() => undefined)
    throw new HarnessError('media upload failed with HTTP ' + put.status, 'MINIMAX_MEDIA_UPLOAD_FAILED')
  }
  await put.body?.cancel().catch(() => undefined)
  return cdnUrl
}