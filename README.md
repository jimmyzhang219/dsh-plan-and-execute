<div align="center">
Plan-and-Execute orchestration plugin for DeepSeek Harness (dsh).

![dsh plugin](https://img.shields.io/badge/dsh-plugin-8B5CF6.svg)
![TypeScript](https://img.shields.io/badge/TypeScript-3178C6.svg?logo=typescript&logoColor=white)
![Node](https://img.shields.io/badge/node-%3E%3D22.19-339933.svg?logo=nodedotjs&logoColor=white)
![License: MIT](https://img.shields.io/badge/license-MIT-blue.svg)

<p align="center"><em>by Jimmy Zhang</em></p>

</div>

dsh 的 Plan-and-Execute 编排插件：`/plan-and-execute <任务>` 启动"规划 → 审批 → 逐步执行"。
全部 LLM 交互委托给宿主 ReactLoopAgent；控制流持久化在 `pae/*` 会话事件，步骤内容在
`.pae/<session>/<runToken>/step-NN-*.md`；进度经 `todo/write` 渲染到会话 TodoPanel。

## 开发

> 本插件基于 dsh **0.1.2-alpha.1**（本地 checkout `~/git/deepseek-harness`）开发调试。
> 注意：npm 上的宿主发布版（0.1.1-rc.2）缺少 `canOpenWorkspacePath` 等 client API，
> 审批卡"打开目录"按钮在该宿主下不可用——请使用本地 checkout 或等待新版宿主发布。

```sh
pnpm install && pnpm link:host   # link:host 软链宿主包（DSH_ROOT 默认 ~/git/deepseek-harness，需先在 dsh 仓库 pnpm install && pnpm run build）
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

**方式一：npm 包直接安装（无需构建）**

```sh
npx @deepseek-ai/dsh plugin --profile web add dsh-plan-and-execute
```

**方式二：从源码构建安装**

```sh
git clone https://github.com/jimmyzhang219/dsh-plan-and-execute.git
cd dsh-plan-and-execute
pnpm install && pnpm build
dsh plugin --profile <name> add .
```

> 宿主版本匹配：npm 上 `@deepseek-ai/dsh` 当前为 0.1.1-rc.2，缺少 `canOpenWorkspacePath`
> 等 client API，审批卡"打开目录"按钮不可用；用本地 checkout（0.1.2-alpha.1）启动
> （`cd ~/git/deepseek-harness && pnpm dsh web`）可立即获得完整功能。

## 手工验收清单（`pnpm dev` + Web UI）

1. `/plan-and-execute 给本仓库写一个加法函数并配测试` → 模型调研、写步骤文件、调 `submit_plan` → 审批弹窗
2. 审批选"继续修改"并输入反馈 → 模型收到反馈重新提交 → 再审批
3. 选"批准" → TodoPanel 出现步骤清单；无确认点的计划连续执行到完成；完成弹窗含各步 summary
4. 在计划里让模型给某步标 `requiresConfirmation: true` → 该步执行前弹确认点（继续/跳过/回计划/终止）
5. 执行中按取消（或让某步失败）→ 暂停五选项（重试/跳过/继续下一步/回计划/终止）
6. 执行中直接发消息 → 消息进入当前步（原生 steer 语义），编排不受影响
7. 执行中途重启 `pnpm dev` 并重开会话 → 恢复确认弹出，"从断点继续"后从当前步重注入
8. 验收全程结束后：`git -C ~/git/deepseek-harness status --porcelain` 输出为空（宿主仓库零改动）
