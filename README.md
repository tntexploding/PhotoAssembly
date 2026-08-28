# 光绘 PhotoAssembly

一个面向单人本地使用的照片风格化工作台。内置零成本 SVG 滤镜预览，也可以调用 OpenAI 图片编辑 API，或生成结构化任务交给当前项目中的 Codex Skill 处理。

## 环境与启动

- Node.js 20 或更高版本
- 无第三方运行时依赖
- 服务强制监听 `127.0.0.1`、`localhost` 或 `::1`，不会开放到局域网

```bash
npm start
```

打开 <http://127.0.0.1:3000>。首次排查配置时运行：

```bash
npm run doctor
```

更新代码后必须重启正在运行的 `npm start` 进程。页面会校验前后端 API 版本；如果检测到旧进程，会明确提示重启，而不会把尚未读取的 Skill 或任务显示成已经丢失。此时先在旧终端按 `Ctrl+C`，重新运行 `npm start`，再刷新页面。

## 配置隔离

配置优先级从低到高为：内置安全默认值、`config.local.json`、`.env`、`.env.local`、启动进程的系统环境变量。所有相对路径均以项目根目录为基准，与启动 Shell 的当前目录无关。

```powershell
Copy-Item config.local.example.json config.local.json
Copy-Item .env.example .env.local
```

- `config.local.json`：非秘密设置，例如端口、模型、输出尺寸、超时和数据目录。
- `.env.local` 或系统环境变量：`OPENAI_API_KEY`、`GITHUB_TOKEN` 等秘密。
- `.env`、`.env.local`、`config.local.json` 与 `.photoassembly` 均被 Git 忽略。
- 如果把密钥或未知字段写入 `config.local.json`，程序会拒绝启动，避免拼写错误被静默忽略。

主要配置见 [`.env.example`](.env.example) 与 [`config.local.example.json`](config.local.example.json)。非法端口、非回环 Host、错误图片尺寸或不一致的请求大小会在启动时直接报告。图片默认限制为 10 MiB、单边不超过 16384 像素且总像素不超过 5000 万；三项都可以在本地配置中调整。

## OpenAI 快速预览

在 `.env.local` 或系统环境变量中设置 `OPENAI_API_KEY`。默认模型是 `gpt-image-2`，输出尺寸为 `auto`，会避免原版本固定正方形造成的构图裁切。已有 `OPENAI_IMAGE_MODEL` 或 `config.local.json` 设置仍会优先于默认值。

点击 OpenAI 快速预览会把当前照片、所选风格提示和补充方向发送给 OpenAI。未配置密钥时不会向 OpenAI 发出请求；四个内置预览完全在本地生成。

请求会对连接错误、408、409、429 和 5xx 执行有限次数退避重试，并记录 OpenAI `x-request-id` 以便诊断。页面只显示“已配置、待首次验证”，成功完成一次请求后才显示“已验证”。

没有密钥时，四个内置风格使用本地 SVG 滤镜。网络 Skill 不会伪装成水彩效果；页面会明确提示改用 Codex 方案或配置 OpenAI。

## 本地 Skill 库

在“Skill 网址保存栏”中粘贴 GitHub 仓库、GitHub 文件夹、`SKILL.md` 或其他允许的 HTTPS 地址。默认仅允许：

```text
raw.githubusercontent.com
api.github.com
```

需要其他来源时，在 `config.local.json` 的 `styleImport.allowedHosts` 中显式加入域名。使用 `*` 可允许任意公网 HTTPS 主机，但仍会阻止本机、私有和保留地址。每次下载只连接到同一次安全解析得到的公网 IP，并保留原域名的 TLS 证书校验，避免 DNS 重绑定绕过检查。

GitHub 仓库根目录没有 `SKILL.md` 时，系统会通过 GitHub API 自动发现默认分支内最多 20 个 Skill。配置 `GITHUB_TOKEN` 可提高 API 请求额度；下载结果会按 `cacheTtlMs` 在内存中短时缓存。

每个 Skill 会显示名称、简介、来源、文字排版策略和可编辑的本地别名。Skill 库默认保存到 `.photoassembly/saved-skills.json`：

- 保存前生成 `.bak`；主文件损坏时自动尝试恢复。
- 损坏的单条记录会跳过并在界面显示警告。
- 页面支持导出和合并导入 JSON 备份。
- 远程 Skill 文本始终被视为不可信的视觉方向，不能要求 Codex 调用工具、读取秘密或修改无关文件。

## Codex 本地任务

1. 上传照片并选择风格。
2. 点击“生成 Codex 处理方案”。
3. 任务以原子方式写入 `.photoassembly/jobs/<任务编号>/`。
4. 复制任务提示并在本项目 Codex 会话中使用 `$photoassembly-process-job`。
5. 返回网页检查结果。

页面现在提供任务历史、刷新恢复、磁盘占用、单项删除和“清理已完成”。删除会永久移除该任务的原图与结果，并在操作前确认。可配置 `JOB_RETENTION_DAYS` 自动清理超过指定天数的已完成任务；`0` 表示不自动删除。

命令行管理：

```bash
npm run jobs
npm run cleanup
npm run backup
npm run backup:images
```

普通备份包含配置、Skill 和任务清单；`backup:images` 额外包含原图与结果。两种备份都明确排除 `.env`、`.env.local`、API Key 和 Token。任务目录不可读、缺少 `job.json` 或复制失败时会取消整个备份并清理临时目录，不会留下看似成功但内容不完整的备份。

## 测试与验收

```bash
npm run check
npm test
npm run test:external  # 显式联网验证示例 GitHub Skills
```

常规测试为每个任务和 Skill 库创建独立临时目录，不接触真实 `.photoassembly`。测试覆盖配置优先级与校验、路径隔离、图片尺寸/MIME、提示词策略、OpenAI 429 重试、请求 ID、Skill 备份恢复、任务完整生命周期、HTTP API 和秘密排除。

发布前还应在真实浏览器完成：键盘上传、内置预览下载、创建任务后刷新恢复、删除任务、320px/768px/桌面响应式和系统减少动画模式。

## 本地数据与隐私

- 仅浏览或快速预览不会在 PhotoAssembly 数据目录持久保存上传图片。
- 如果已配置 OpenAI，快速预览会把当前照片与处理提示发送给 OpenAI，但仍不会把照片写入 PhotoAssembly 本地数据目录。
- 创建 Codex 任务会把原图、任务清单和结果保存到本机数据目录。
- 页面中的“本地任务”可永久删除这些文件。
- 日志不会记录 API Key、Token、图片或完整提示词；文件写入失败会输出到终端并在 `/api/health` 的 `logging` 状态中显示。
- AI 结果可能包含偏差或图像瑕疵，使用前请人工检查。
