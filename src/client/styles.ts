/**
 * 审批卡样式注入。
 *
 * 按 dsh ClientModuleSystem 的 claimStyles 契约（modules/src/client/system.ts:42-52）：
 * materialize 时扫描 `style[data-plugin=<模块 id>]` 标签认领为模块自有样式，
 * 随模块记录一并清理。因此在模块顶层副作用创建标签（apply 之前即存在），
 * 而非在 React 组件里。样式使用宿主设计令牌（--dsw-* / --dsh-*），
 * 与内置 PlanReviewPanel（ui-user-questions/PlanReviewPanel.module.css）同源。
 * @module dsh-plan-and-execute/client/styles
 */

/** 审批卡样式（scoped 前缀 .pae-，避免与宿主类名冲突）。 */
const CSS = `
.pae-frame {
  display: flex;
  justify-content: center;
  padding: 6px calc(var(--dsh-composer-side-clearance, 0px) + 16px) 10px;
}
.pae-card {
  display: flex;
  overflow: hidden;
  flex-direction: column;
  width: 100%;
  max-width: var(--dsh-chat-content-width, 720px);
  max-height: min(60vh, 520px);
  border: 1px solid var(--dsw-alias-state-warn-secondary, #d99a26);
  border-radius: 20px;
  background: var(--dsw-specific-input-major, #2a2a2e);
  box-shadow: var(--dsw-shadow-lv2, none);
  color: var(--dsw-alias-label-primary, inherit);
}
.pae-card, .pae-card * { box-sizing: border-box; }
.pae-strip {
  display: flex;
  align-items: center;
  flex-shrink: 0;
  gap: 8px;
  padding: 10px 16px;
  background: var(--dsw-alias-state-warn-tertiary, #3a3120);
  color: var(--dsw-alias-state-warn-primary, #ffd166);
  font-size: 13px;
  line-height: 18px;
}
.pae-dot {
  width: 8px;
  height: 8px;
  border-radius: 50%;
  background: var(--dsw-alias-state-warn-primary, #ffd166);
}
.pae-header-actions { margin-left: auto; display: flex; gap: 8px; }
.pae-schedule {
  position: relative;
  display: inline-flex;
  align-items: center;
  gap: 4px;
}
/* 排期 chip 加宽 + 不换行：让「计划于 YYYY-MM-DD HH:mm 执行」完整显示（验收反馈：控件太窄） */
.pae-schedule-toggle {
  min-width: 150px;
  white-space: nowrap;
}
.pae-schedule-clear {
  padding: 0 6px;
  border: none;
  background: none;
  color: var(--dsw-alias-label-secondary, inherit);
  font-size: 14px;
  line-height: 20px;
  cursor: pointer;
}
.pae-schedule-clear:hover { color: var(--dsw-alias-state-error-primary, #e5484d); }
.pae-schedule-picker {
  position: absolute;
  top: calc(100% + 4px);
  right: 0;
  z-index: 20;
  display: flex;
  flex-direction: column;
  gap: 8px;
  min-width: 300px; /* 容纳日期/时间输入 + 状态行 + 操作行（验收反馈：浮层太窄） */
  padding: 10px 12px;
  background: var(--dsw-specific-input-major, #2a2a2e);
  border: 1px solid var(--dsw-alias-border-l1, currentColor);
  border-radius: 10px;
  box-shadow: var(--dsw-shadow-lv2, none);
}
.pae-schedule-picker label {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 8px;
  font-size: 12px;
  line-height: 18px;
  color: var(--dsw-alias-label-secondary, inherit);
}
.pae-schedule-picker input {
  width: 168px; /* 与加宽后的浮层匹配，原生控件自带图标不留空隙 */
  background: var(--dsw-alias-bg-base, transparent);
  color: var(--dsw-alias-label-primary, inherit);
  border: 1px solid var(--dsw-alias-border-l1, currentColor);
  border-radius: 6px;
  padding: 2px 6px;
  font-size: 13px;
  line-height: 18px;
}
/* 浮层状态行：默认弱化提示；合法=成功绿、非法=错误红 */
.pae-schedule-status {
  font-size: 12px;
  line-height: 16px;
  color: var(--dsw-alias-label-secondary, inherit);
}
.pae-schedule-status--ok {
  color: var(--dsw-alias-state-success-primary, #46a758);
}
.pae-schedule-status--err {
  color: var(--dsw-alias-state-error-primary, #e5484d);
}
.pae-schedule-picker-actions {
  display: flex;
  justify-content: flex-end;
  gap: 8px;
}
.pae-body {
  flex: 1 1 auto;
  min-height: 0;
  overflow-y: auto;
  overscroll-behavior: contain;
  padding: 12px 16px 4px;
  font-size: 14px;
  line-height: 22px;
}
.pae-summary { margin: 0 0 8px; color: var(--dsw-alias-label-secondary, inherit); }
.pae-steps {
  margin: 0;
  padding: 0;
  list-style: none;
  display: flex;
  flex-direction: column;
  gap: 8px;
}
.pae-step {
  display: flex;
  align-items: center;
  gap: 8px;
  min-width: 0;
}
.pae-step-title { flex: none; }
.pae-step-title-btn {
  flex: none;
  padding: 0;
  border: none;
  background: none;
  color: inherit;
  font: inherit;
  text-align: left;
  cursor: pointer;
  text-decoration: underline;
  text-decoration-color: color-mix(in srgb, currentColor 40%, transparent);
  text-underline-offset: 3px;
}
.pae-step-title-btn:hover { color: var(--dsw-alias-label-primary, inherit); }
.pae-step-select {
  flex: 1 1 auto;
  min-width: 0;
  max-width: 260px;
  margin-left: auto;
  background: var(--dsw-alias-bg-base, transparent);
  color: var(--dsw-alias-label-primary, inherit);
  border: 1px solid var(--dsw-alias-border-l1, currentColor);
  border-radius: 8px;
  padding: 2px 6px;
  font-size: 13px;
  line-height: 20px;
}
.pae-feedback { display: flex; flex-direction: column; gap: 4px; padding: 4px 16px; font-size: 12px; line-height: 16px; color: var(--dsw-alias-label-secondary, inherit); }
.pae-feedback-textarea {
  width: 100%;
  background: var(--dsw-alias-markdown-code-block, transparent);
  color: var(--dsw-alias-label-primary, inherit);
  border: 1px solid var(--dsw-alias-border-l1, currentColor);
  border-radius: 8px;
  padding: 6px 8px;
  font-size: 13px;
  line-height: 18px;
  resize: vertical;
}
.pae-error {
  min-height: 16px;
  padding: 0 16px;
  color: var(--dsw-alias-state-error-primary, #e5484d);
  font-size: 11px;
  line-height: 16px;
}
.pae-footer {
  display: flex;
  align-items: center;
  justify-content: space-between;
  flex-shrink: 0;
  gap: 12px;
  padding: 8px 16px 12px;
}
.pae-actions { display: flex; align-items: center; gap: 8px; }
@media (max-width: 720px) {
  .pae-card { border-radius: 16px; }
  .pae-body { padding: 10px 12px 4px; }
  .pae-footer { align-items: flex-end; padding: 8px 12px 10px; }
}
`

if (
  typeof document !== 'undefined' &&
  document.querySelector('style[data-plugin="dsh-plan-and-execute"]') === null
) {
  const tag = document.createElement('style')
  tag.dataset.plugin = 'dsh-plan-and-execute'
  tag.dataset.pluginCss = 'dsh-plan-and-execute/PaeReviewCard'
  tag.textContent = CSS
  document.head.appendChild(tag)
}

export {}
