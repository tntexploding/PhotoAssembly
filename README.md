# 光绘 PhotoAssembly

一个可直接运行的照片风格化工作台。默认使用本地演示引擎，配置 OpenAI API Key 后可调用图像编辑 API。

## 启动

```bash
cp .env.example .env
npm start
```

打开 <http://localhost:3000>。Node.js 20+ 即可，无第三方运行时依赖。

## OpenAI 模式

在 shell 中设置 `OPENAI_API_KEY` 后启动。密钥只存在于服务端，浏览器不会接触密钥。可通过
`OPENAI_IMAGE_MODEL` 覆盖模型（默认 `gpt-image-1.5`）。没有密钥时，API 自动使用确定性的本地 SVG
滤镜演示模式，便于零成本体验和测试。

## 从网络导入风格

展开界面中的“从网络导入 Skill / 提示词”，填写公开 HTTPS 地址即可导入 JSON、Markdown 或纯文本风格。
JSON 格式可使用 `{ "name": "风格名", "prompt": "处理指令" }`；Markdown 的一级标题会成为风格名，其余正文成为提示词。
GitHub 仓库首页地址会先尝试根目录的 `SKILL.md`；若根目录没有该文件，会读取默认分支并自动发现仓库内最多 20 个
`SKILL.md`，一次加入本地库。也可以直接粘贴 GitHub `tree` 文件夹、`blob` 文件或 Raw 地址，无需手工改写 URL。
服务端限制文件为 64KB、阻止私有网络地址、限制重定向，并可用 `STYLE_IMPORT_HOSTS` 设置域名允许列表。请仅导入可信来源。
若启用了域名允许列表，GitHub 仓库自动发现需要同时允许 `raw.githubusercontent.com` 与 `api.github.com`。

### 本地 Skill 库

页面中的“Skill 网址保存栏”会在导入后显示 Skill 名称、简介与来源，并允许直接选择、设置最多 40 个字符的本地别名或移除。
别名仅用于本机识别，列表会优先显示别名并保留原始 Skill 名称；留空保存即可清除别名。导入内容默认持久化到
`.photoassembly/saved-skills.json`，因此服务重启后仍会自动恢复；该目录已被 Git 忽略。可通过 `SKILL_LIBRARY_FILE`
指定其他存储文件。本地库最多保存 100 条记录；相同规范化网址会更新同一条记录，不会重复新增。

仓库包含针对 `cinema-dna-21x9x3`、`reality-restaged` 和 `surreal-pop-collage` 的格式契约测试夹具，以及显式启用的
GitHub 实时导入测试。常规 `npm test` 不依赖网络；`npm run test:external` 会从三个原始仓库下载 `SKILL.md`，为每个风格生成
Codex 任务，并验证 `input.png`、`job.json` 和 `CODEX_TASK.md`。

## 人工 Codex 图片处理闭环

1. 上传照片、选择内置或网络风格，并点击“生成 Codex 处理方案”。
2. 系统在 `.photoassembly/jobs/<任务编号>/` 保存原图、结构化 `job.json` 和可复制的 `CODEX_TASK.md`，不调用 OpenAI API。
3. 将页面生成的提示粘贴到本仓库的 Codex 会话。项目 Skill `$photoassembly-process-job` 会读取方案、调用 Codex 图像能力、检查结果并运行完成脚本。
4. 回到页面点击“检查处理结果”，即可载入、对比和下载完成的图片。

任务方案包含风格来源、主提示词、用户补充方向、主体/构图不变量和质量检查清单。任务文件默认写入被 Git 忽略的
`.photoassembly/jobs`；可用 `CODEX_JOBS_DIR` 修改。Codex 的图像能力取决于所使用的 Codex 环境和账户能力，网站本身不会自动启动 Codex。

## 测试

```bash
npm test
npm run check
npm run test:external # 显式联网验证示例 GitHub Skills
```

## 隐私与限制

- 上传支持 PNG、JPEG 和 WebP，默认最大 10 MiB。
- 图片仅在当前请求内存中处理，本应用不持久化原图。
- 生产部署应在反向代理层补充鉴权、速率限制与 HTTPS。
