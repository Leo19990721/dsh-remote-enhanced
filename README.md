# Remote Enhanced

在 DSH 原生工作区列表中并列显示本机和已授权远端电脑的文件夹。打开会话后，请求始终交给会话所属的 Host（运行该会话的电脑），保留各自的草稿和运行状态。切换会话沿用原生界面，不切换 Remote 全局目标、不整页刷新。

当前版本为 **0.1.7**，包名为 `@local/dsh-remote-enhanced`，`private: true`。增强包不声明 `engines.dsh`，对 `ds-harness-remote` 的 peer 要求为 `*`。自检只报告 DSH 和 Remote 的版本号，不按版本拦截；实际仍需启用原版 Remote，并具备所用功能要求的原生连接接口。原版 Remote 自身的兼容声明不变。升级 DSH 或 Remote 后，请先在自己的设备组合上验证。开发和测试使用 **Node.js 24 及以上、pnpm 11.28.5**。

## 安装

从 [Releases](https://github.com/Leo19990721/dsh-remote-enhanced/releases) 下载对应版本的 `dsh-remote-enhanced-*.tgz` 和 `SHA256SUMS.txt`，核对 SHA-256 后，在 DSH 插件管理器填写安装包的绝对路径并启用。保留当前版本和上一版本的安装包，方便修复或回退。

| 电脑 | 需要安装和配置的内容 |
| --- | --- |
| 本机：实际打开 DSH 界面的电脑 | 先安装并启用 `ds-harness-remote`，再安装并启用本增强包。 |
| 远端：保存工作区和运行会话的电脑 | 启用 `ds-harness-remote`，按 Remote 原版流程登录、授权并保持 Host 在线。若要从界面停止远端子 agent，还需在该 Host 安装并启用同版本增强包。基础远端会话访问可仅在本机安装增强包。 |
| 双向使用 | 如果也要从远端电脑的界面查看其他 Host，在那台电脑上同样安装本增强包。每台电脑分别保存自己的配置。 |

连接继续使用 DSH 官方账号登录、Remote 设备授权、加密传输和原生 owner 权限检查。首次连接在原版 Remote 中完成。增强包不包含账号、密钥、登录缓存、设备登记、会话或作者电脑路径，不修改 DSH 和 Remote 安装文件，也不代替官方认证。

安装包只携带运行时代码、默认配置、说明、许可、语言资源和图标；安装器会安装 `semver` 和 `ws`。准备离线安装时，需要另外准备包管理器依赖缓存。

## 使用

1. 在原版 Remote 中确认目标 Host 已授权且在线。
2. 在原生工作区列表中打开带电脑名的文件夹，再打开其 Harness 会话。同名路径按 Host 分开识别。
3. 右侧栏的文件、图片、终端和 `localhost` 网页跟随会话所属的电脑，无需另选设备。远端终端和网页沿用目标电脑的 Remote 授权。在远端会话的网页地址栏输入 `localhost:端口`，就能访问该电脑上已授权的 HTTP 服务，无需另开预览开关。
4. 在远端文件右键菜单或文档预览的「文件操作」里选择「下载」。桌面版保存到当前电脑的默认下载位置；可用「另存为」选择位置，保存完成后点 DSH 提示里的「在文件夹显示」。浏览器版交给浏览器下载。

在本机应用里使用远端文件前，请先下载原件。Office 文件预览需要本机已有的 DSH Office 转换服务；服务不可用时仍可下载原件。

平时直接打开会话，无需手动自检。连不上时，按提示打开原版 Remote 的远程工作台：如果列表没有更新，点“刷新”；如果目标电脑在线，点它所在的一行重新尝试。增强包不修改原版 Remote 的工作台界面。已提交的消息和命令不会自动重发。

排查时可以请助手运行 `remote_workspaces` 的只读自检：`selfCheck` 不带 `hostId` 时只读安装和设备目录；带 `hostId` 时仅检查该授权电脑；可选的已有 `sessionId` 只用于读取该会话可用的命令目录。`diagnostics` 提供连接状态及固定分类的处理建议。`resourceCheck` 只返回资源类型、大小、授权、状态和传输完成信息，不返回文件正文、网页正文或响应头。

## 配置

[默认配置](./cordis.patch.yml) 的 `filePreviewTargets` 为 `[]`，不预设 Host、端口或本机路径。profile 目录由当前 DSH 的 `profileContext` 提供，不需要设置 `DSH_PROFILE_DIR`，也不要复制其他电脑的 profile 路径。

如果整理地图网页支持 `/open` 文件动作，可在 DSH 插件设置中为单个 Host、端口和网页路径开启文件预览入口。先把下面的 Host ID 占位符换成自己已授权设备的真实 ID，再填入实际网页端口和路径。DSH 插件配置覆盖会替换该条目的完整 `config`，编辑时保留自己的其他设置。

```yaml
filePreviewTargets:
  - hostId: '<authorized-host-id>'
    port: 3000 # 示例端口，请改成实际服务端口。
    path: '/'
```

配置完成后，在对应网页标签手动开启“本机预览”。点击网页文件后，还需要在 DSH 确认预览、查看目录或下载。只对匹配的整理地图生效；普通网页仍保留原应用行为。

## 已知边界

- 当前适配原生 Harness 工作区和会话。Codex、Cursor、ACP 等其他后端不在此候选版支持范围内。
- 增强界面只在打开该电脑的本机 DSH 地址时启用，包括桌面应用和本机 loopback Web。通过公网地址直接打开的 Web 不启用多 Host 聚合。
- 远端终端沿用 Remote 的终端开关和设备所有权规则，只能操作该设备创建并拥有的终端。终端列表约每 1.5 秒更新一次。
- 停止远端子 agent 会向其所属 root 提交正式命令，并由 DSH 再次检查当前父子关系；root 会留下命令日志。返回成功表示已提交中断请求，实际运行状态随后更新。
- **计划任务（schedule）不跨 Host。** 在哪台电脑创建和管理，就由哪台电脑的 DSH 调度；需要远端执行时，在目标 Host 上单独设置。
- 单次完整远端文件读取上限为 **100 MiB**，图片预览上限为 **32 MiB**。超过限制时会提示错误，不返回截断文件。
- 远端网页目前支持 `http://localhost`、`http://127.0.0.1` 和 `http://[::1]`，端口范围为 1024–65535，且必须通过 Remote 端口授权。Host 在线但服务未启动时，需要在那台电脑启动服务后重试。
- 远端断线影响该 Host 的操作。重连后按原生恢复流程刷新；终端输入、提交请求和网页 WebSocket 消息不自动重放，避免重复执行。
- 关闭网页标签、会话视图或停用增强会释放本增强持有的连接。安装候选包后仍需在自己的设备、网络和真实业务工作区验证再正式使用。

## 升级

结束正在执行的重要任务，保留旧 `.tgz` 和自己的插件配置，再通过 DSH 插件管理器安装同名新版本。管理器提示“需要重启”时，重启 DSH 后重新打开界面。每台需要增强界面的电脑分别升级；远端 Host 仍须满足原版 Remote 的版本要求并提供相应的原生连接接口。

从 0.1.3 或更早版本升级时，DSH 会把 `@local/dsh-remote-enhanced` 识别为新插件。保留旧安装包和配置，先停用旧增强包 `@local/dsh-unified-sessions`，再安装并启用新包。确认原有插件配置和远端会话入口正常后，再卸载旧包。两份增强包不能同时启用，原版 `ds-harness-remote` 保持启用。

升级增强包不迁移或分发工作区、会话、账号和 Host 配置。升级后检查自己的插件配置；新增目标需自行配置。

## 回退

先停用增强包，再重新连接界面，恢复原版 Remote 使用方式。需要退回旧增强版本时，通过插件管理器重新安装并启用保留的旧 `.tgz`，按提示重启 DSH。原版 Remote 可以继续保留。回退前检查旧版本的配置格式，恢复升级前保存的插件配置。

## 开发

在独立源码目录中安装依赖，禁止执行安装脚本，也不要把真实 Remote profile 用作单元测试 fixture：

```powershell
pnpm install --ignore-scripts --ignore-pnpmfile --ignore-workspace --config.auto-install-peers=false --config.strict-peer-dependencies=false
node --test tests/*.test.js
```

Remote 是运行时前置 peer，开发安装命令关闭自动安装 peer。普通 Node 单测使用合成 Remote manifest，不加载真实 Remote，不依赖 `DSH_PROFILE_DIR`。`semver` 和 `ws` 是本包直接声明的运行时依赖。首次生成锁文件后，后续安装加 `--frozen-lockfile`。

修改 Client 源码时，由该文件的负责人执行 `pnpm build` 生成浏览器入口。打包脚本不会运行构建或覆盖生成文件；打包前须完成对应版本的 Client 构建。安装版集成测试需单独指定目标 DSH 安装目录（`DSH_INSTALL_DIR`）；终端适配集成测试通过 `DSH_REMOTE_FIXTURE_DIR` 指向单独准备的 Remote 安装 fixture。普通单元测试不访问已安装 profile。

Windows 使用 [打包脚本](./scripts/pack.ps1)：

```powershell
pwsh -NoProfile -File scripts/pack.ps1 -NodePath <已有Node可执行文件> -PnpmPath <已有pnpm的bin/pnpm.mjs>
```

也可省略参数，使用当前终端已有的 `node` 和 `pnpm`。脚本在清空 `DSH_PROFILE_DIR` 的子进程中运行单测，再检查语法、打包清单和所有运行时相对导入，生成 `.local-install` 下的版本包及 `.sha256`。它不安装依赖、不执行 install/prepack/prepare 等生命周期脚本、不修改 profile、不上传产物。

仓库保留开发源码和历史测试；运行时包排除测试、测试 fixture、旧原型模块、Client 模板和构建工具。分发前还需由版本负责人完成真实界面及远端验收。

## 许可

本项目采用 [MIT License](./LICENSE)。预览传输及响应头过滤改编自 `ds-harness-remote 0.6.5`，保留原版权声明及 [REMOTE-LICENSE.txt](./REMOTE-LICENSE.txt)。本项目独立维护。
