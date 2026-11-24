import fs from 'node:fs/promises'
import path from 'node:path'
import os from 'node:os'
import type { AwsQuickAgentDto } from '../../../shared/aws-quick-contracts.ts'

async function usable(file: string): Promise<boolean> {
  try { return (await fs.stat(file)).isFile() } catch { return false }
}
export async function resolveQuickAgent(customPath?: string | null): Promise<AwsQuickAgentDto> {
  const candidates = [
    customPath?.trim() || undefined,
    process.env.AWS_QUICK_AGENT_PATH?.trim() || undefined,
    ...(process.platform === 'win32' ? [
      path.join(process.env.LOCALAPPDATA ?? path.join(os.homedir(), 'AppData', 'Local'), 'quickwork', 'agent', 'quickwork-agent.exe'),
      path.join(process.env.LOCALAPPDATA ?? path.join(os.homedir(), 'AppData', 'Local'), 'Programs', 'quickwork', 'resources', 'agent', 'quickwork-agent.exe'),
    ] : []),
    ...(process.platform === 'darwin' ? [
      path.join(os.homedir(), 'Applications', 'Amazon Quick.app', 'Contents', 'Resources', 'agent', 'quickwork-agent'),
      '/Applications/Amazon Quick.app/Contents/Resources/agent/quickwork-agent',
    ] : []),
  ].filter((x): x is string => !!x)
  for (const candidate of candidates) {
    if (!await usable(candidate)) continue
    let version: string | undefined
    try { version = (await fs.readFile(path.join(path.dirname(candidate), '.agent-version'), 'utf8')).trim() || undefined } catch {}
    return { kind: customPath ? 'custom' : 'installed', path: candidate, ...(version ? { version } : {}) }
  }
  return { kind: 'missing', error: process.platform === 'win32' || process.platform === 'darwin'
    ? 'AWS Quick Desktop is not installed. Install it, or set the quickwork-agent executable path in this card.'
    : 'AWS Quick Desktop currently supports Windows and macOS; no local agent is available on this platform.' }
}
