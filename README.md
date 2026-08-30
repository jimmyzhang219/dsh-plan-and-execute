# dsh-plan-and-execute（dsh 插件）

dsh 的 Plan-and-Execute 编排插件：`/plan-and-execute <任务>` 启动"规划 → 审批 → 逐步执行"。
全部 LLM 交互委托给宿主 ReactLoopAgent；控制流持久化在 `pae/*` 会话事件，步骤内容在
`.pae/<session>/<runToken>/step-NN-*.md`；进度经 `todo/write` 渲染到会话 TodoPanel。

## 开发

```sh
pnpm install          # postinstall 软链宿主包（DSH_ROOT 默认 ~/git/deepseek-harness，需先在 dsh 仓库 pnpm install && pnpm run build）
pnpm test             # vitest 单测
pnpm typecheck && pnpm lint && pnpm format:check
pnpm dev              # 在 dsh checkout 启动 Web UI 并加载本插件（绝对路径 overlay）
```

## 配置（cordis.yml `config`）

| 键                  | 默认      | 说明                            |
| ------------------- | --------- | ------------------------------- |
| `onStepFailure`     | `'pause'` | 步骤失败：暂停问人 / 自愈重试   |
| `maxAutoRecoveries` | `2`       | 自愈次数上限（仅 auto-recover） |
| `planDir`           | `'.pae'`  | 计划根目录（相对会话 cwd）      |

## 正式安装

```sh
pnpm build
dsh plugin --profile <name> add /Users/jimmy/VSCodeProjects/dsh-plugin/dsh-plan-and-execute
```

## 手工验收清单（`pnpm dev` + Web UI）

1. `/plan-and-execute 给本仓库写一个加法函数并配测试` → 模型调研、写步骤文件、调 `submit_plan` → 审批弹窗
2. 审批选"继续修改"并输入反馈 → 模型收到反馈重新提交 → 再审批
3. 选"批准" → TodoPanel 出现步骤清单；无确认点的计划连续执行到完成；完成弹窗含各步 summary
4. 在计划里让模型给某步标 `requiresConfirmation: true` → 该步执行前弹确认点（继续/跳过/回计划/终止）
5. 执行中按取消（或让某步失败）→ 暂停五选项（重试/跳过/继续下一步/回计划/终止）
6. 执行中直接发消息 → 消息进入当前步（原生 steer 语义），编排不受影响
7. 执行中途重启 `pnpm dev` 并重开会话 → 恢复确认弹出，"从断点继续"后从当前步重注入
8. 验收全程结束后：`git -C ~/git/deepseek-harness status --porcelain` 输出为空（宿主仓库零改动）
