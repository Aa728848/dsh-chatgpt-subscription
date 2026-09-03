export const MERMAID_STYLE_ID = 'dsh-mermaid-renderer-style'

export function installMermaidStyles(): void {
  if (typeof document === 'undefined' || document.getElementById(MERMAID_STYLE_ID)) return
  const style = document.createElement('style')
  style.id = MERMAID_STYLE_ID
  style.textContent = `
.dsh-mermaid-wrapper{margin:12px 0;border:1px solid var(--dsw-alias-border-l2,rgba(255,255,255,0.12));border-radius:8px;overflow:hidden;background:var(--dsw-alias-bg-layer-2,#1a1a1a);box-shadow:0 2px 8px rgba(0,0,0,0.15)}
.dsh-mermaid-header{display:flex;align-items:center;justify-content:space-between;padding:6px 12px;background:var(--dsw-alias-bg-layer-1,rgba(0,0,0,0.25));border-bottom:1px solid var(--dsw-alias-border-l2,rgba(255,255,255,0.08));font-size:12px;color:var(--dsw-alias-label-secondary,#888)}
.dsh-mermaid-title{font-family:ui-monospace,SFMono-Regular,Consolas,monospace;font-size:11px;text-transform:uppercase;letter-spacing:0.5px;color:var(--dsw-alias-label-tertiary,#aaa);font-weight:600}
.dsh-mermaid-controls{display:flex;gap:8px;align-items:center}
.dsh-mermaid-btn{background:transparent;border:1px solid var(--dsw-alias-border-l2,rgba(255,255,255,0.15));border-radius:4px;color:var(--dsw-alias-label-secondary,#ccc);padding:2px 8px;font-size:11px;cursor:pointer;line-height:18px;transition:all .15s}
.dsh-mermaid-btn:hover{background:var(--dsw-alias-interactive-bg-hover,rgba(255,255,255,0.08));color:var(--dsw-alias-label-primary,#fff);border-color:var(--dsw-alias-border-l1,rgba(255,255,255,0.3))}
.dsh-mermaid-chart{padding:18px;overflow-x:auto;display:flex;justify-content:center;align-items:center;min-height:100px;background:var(--dsw-alias-bg-layer-2,#181818);cursor:zoom-in}
.dsh-mermaid-chart svg{max-width:100%;height:auto;display:block;margin:0 auto}
.dsh-mermaid-source{display:none;margin:0;padding:12px;background:var(--dsw-alias-bg-layer-1,#121212);border-top:1px solid var(--dsw-alias-border-l2,rgba(255,255,255,0.08));font-family:ui-monospace,SFMono-Regular,Consolas,monospace;font-size:12px;line-height:1.5;overflow-x:auto;white-space:pre-wrap;word-break:break-all}
.dsh-mermaid-source.is-visible{display:block}

/* 全屏缩放预览模态框 */
.dsh-mermaid-modal-overlay{position:fixed;inset:0;background:rgba(0,0,0,0.8);backdrop-filter:blur(4px);z-index:99999;display:flex;flex-direction:column;justify-content:center;align-items:center}
.dsh-mermaid-modal-toolbar{position:absolute;top:20px;right:24px;display:flex;gap:8px;background:rgba(20,20,20,0.85);border:1px solid rgba(255,255,255,0.15);border-radius:6px;padding:4px;box-shadow:0 8px 24px rgba(0,0,0,0.5)}
.dsh-mermaid-modal-btn{background:transparent;border:0;color:#fff;font-size:14px;padding:6px 12px;cursor:pointer;border-radius:4px}
.dsh-mermaid-modal-btn:hover{background:rgba(255,255,255,0.15)}
.dsh-mermaid-modal-stage{flex:1;width:100%;height:100%;overflow:auto;display:flex;justify-content:center;align-items:center;padding:40px}
.dsh-mermaid-modal-stage svg{max-width:90vw;max-height:85vh;height:auto}
`
  document.head.append(style)
}