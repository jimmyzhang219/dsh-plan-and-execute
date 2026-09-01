<div align="center">
Plan-and-Execute orchestration plugin for DeepSeek Harness (dsh).

![dsh plugin](https://img.shields.io/badge/dsh-plugin-8B5CF6.svg)
![TypeScript](https://img.shields.io/badge/TypeScript-3178C6.svg?logo=typescript&logoColor=white)
![Node](https://img.shields.io/badge/node-%3E%3D22.19-339933.svg?logo=nodedotjs&logoColor=white)
![License: MIT](https://img.shields.io/badge/license-MIT-blue.svg)

<p align="center"><em>by Jimmy Zhang</em></p>

</div>

DeepSeek Harness (dsh) 的 Plan-and-Execute 编排插件

## 安装

**npm 包直接安装（无需构建，安装后重启dsh服务）**

```sh
npx @deepseek-ai/dsh plugin --profile web add dsh-plan-and-execute
```

## 使用方式

在 Web UI 对话框里输入 `/plan-and-execute 提示词...`  

## 使用示例一

```sh
/plan-and-execute 
根据以下要求帮我生成 **2026年国庆假期（10月1日–10月7日）** 北京一地 **7天6晚** 的详细出游计划。

## 基础参数
- **出行人数**：一家三口（含儿童，年龄 8 岁）
- **出行方式**：自驾（京牌私家车）
- **住宿标准**：经济型/舒适型宾馆（每晚预算 400–600 元）
- **总经费**：15,000 元人民币（含交通、住宿、门票、餐饮、停车及其他杂费）
- **出发地**：北京市内（无需长途驾驶）

## 输出要求（逐日清单）
- **每日行程**：上午 / 下午 / 晚上 分时段活动，标注景点名称及建议游玩时长
- **门票前置**：标明需提前购票的景区（并备注官方渠道及抢票时间）
- **停车方案**：每个景点附近推荐停车场（含大致停车费/小时）
- **住宿安排**：每晚游玩结束后，推荐附近 2–3 家宾馆（含参考价格及是否可免费停车）
- **餐饮建议**：每日推荐 1–2 家地道餐厅（人均 50–80 元）
- **费用概览**：每日分项预估费用（门票 + 停车 + 住宿 + 餐饮），并滚动累计，确保总支出 ≤ 15,000 元

## 附加约束
- 避开热门景点人流高峰时段（建议早 8:00 前或下午 15:00 后入园）
- 每天车程累计不超过 1.5 小时（市区内）
- 安排 1 天机动日（用以应对天气或体力调整）
- 最后一天（10月7日）需预留返程休整时间

## 输出格式
- 按日期分节（Day 1 – Day 7）
- 每节包含：行程表、停车点、住宿推荐、餐饮提示、当日费用小计
- 文末附 **总预算核对表**（分类汇总）

请直接生成完整计划，无需额外解释。
```

## 使用示例二

```sh
/plan-and-execute 
- 按以下规格实现一个B/S文档阅读工具。

### 需求
- **架构**：前后端分离，HTTP/RESTful API。
- **前端**：Vue 3 单页应用，左侧目录树（可展开/折叠），右侧展示文档内容。使用 Claude Code 生成代码。
- **后端**：Node.js（Hono），启动时加载指定根目录下的所有 `.txt` / `.md` 文件，构建目录树，提供文件树结构和文件内容读取接口。使用 Claude Code 生成代码。
- **交互**：点击树节点，请求后端获取文件内容并渲染（MD 需转为 HTML）。
- **测试**：开发完成后，使用 Codex 生成并执行单元/集成测试。

### 接口
- `GET /api/tree` → 返回目录树 JSON（含路径、类型、名称）
- `GET /api/content?path=xxx` → 返回文件内容（纯文本或 HTML）

### 约束
- 代码精简，注释适度，支持中文文件名和路径。
- 后端仅读取指定根目录（环境变量 `DOC_ROOT`），禁止越权。
- 前端打包输出静态文件，可独立部署。

### 输出
- 工程保存到 `~/git/{project}` 目录，目录下分成前/后端两个工程。
- 完整项目结构、关键代码片段、启动说明。直接交付可运行原型。
```

## 开发

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

## 手工验收清单（`pnpm dev` + Web UI）

1. `/plan-and-execute 给本仓库写一个加法函数并配测试` → 模型调研、写步骤文件、调 `submit_plan` → 审批弹窗
2. 审批选"继续修改"并输入反馈 → 模型收到反馈重新提交 → 再审批
3. 选"批准" → TodoPanel 出现步骤清单；无确认点的计划连续执行到完成；完成弹窗含各步 summary
4. 在计划里让模型给某步标 `requiresConfirmation: true` → 该步执行前弹确认点（继续/跳过/回计划/终止）
5. 执行中按取消（或让某步失败）→ 暂停五选项（重试/跳过/继续下一步/回计划/终止）
6. 执行中直接发消息 → 消息进入当前步（原生 steer 语义），编排不受影响
7. 执行中途重启 `pnpm dev` 并重开会话 → 恢复确认弹出，"从断点继续"后从当前步重注入
8. 验收全程结束后：`git -C ~/git/deepseek-harness status --porcelain` 输出为空（宿主仓库零改动）
