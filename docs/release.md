# 发版（Trusted Publishing / OIDC）

推一个 `v*` 标签，GitHub Actions 就编译 + 发布，**不需要任何 token，也不需要输 OTP**。

```
改代码 → npm version patch|minor|major → git push --follow-tags → CI 发布
```

## 一、先确认三件事

| 事 | 现状 | 说明 |
|---|---|---|
| 包已存在于 npm | ✅ `pop-agent@1.1.2`（当前版本，见 `package.json`） | Trusted Publishing **不能用于包名从未发布过**的情况：那种必须先手动发一个版本，再回来配 |
| 工作流文件 | ✅ `.github/workflows/release.yml` | 配白名单时填的文件名就是 `release.yml` |
| 仓库 | ✅ `duzhenxun/pop-agent` | 配白名单时填 `duzhenxun/pop-agent` |

## 二、npm 网页端配一次（只有你能做）

打开 <https://www.npmjs.com/package/pop-agent> → **Settings** → **Trusted publishing** → **Add publisher**：

| 字段 | 填什么 |
|---|---|
| Publisher | GitHub Actions |
| Organization or user | `duzhenxun` |
| Repository | `pop-agent` |
| Workflow filename | `release.yml`（**只写文件名**，不要 `.github/workflows/` 前缀） |
| Environment name | 留空（本仓库没在 job 里写 `environment:`；写了就必须和这里一致） |
| Allowed actions | `npm publish`（默认就有；要发 beta 再加 `npm stage publish`） |

> 这一步必须**本人登录网页交互完成**：npm 明确禁止用绕过 2FA 的 token 去建这条信任关系，否则等于没有 2FA。

配好之后，这个仓库的 `release.yml` 就能用 OIDC 令牌换发布凭证；**其他仓库 / 其他工作流文件一律发不出去**。

## 三、以后怎么发版

**合并/推送到 `main` 不发版。** 发版只有两步，都在本地：

```bash
npm version patch          # 或 1.0.8 / minor / major —— 改 package.json + lock，提交，打附注标签
git push --follow-tags     # 把 main 和标签一起推上去 → release.yml 自动跑
```

推上去之后 CI 依次做：校验「标签版本 == package.json 版本」→ `npm ci` → typecheck → lint → build
→ 确认产物进包 → `npm publish`（OIDC，无需 OTP）→ 建 GitHub Release（说明取自标签附注，
并标为 Latest；已存在则跳过，所以重跑不会因为这个变红）。

> **Release 说明 = 标签的附注内容**（不是自动生成的 commit 列表）。所以发版时先把说明写成中英双语，
> 再用 `git tag -a v1.1.0 -F notes.md` 打标签（或 `npm version minor -m "…"`）—— `/releases`
> 页面直接就是双语的。不给附注时会回退成自动生成的 commit 列表。
> 不要用 `gh release create --notes-from-tag`：实测在 Actions 里会静默回退到 commit 说明
> （v1.1.0 第一次就这么发成了 `chore(release): 1.1.0`），工作流里改成显式读标签内容。

> **tag ≠ Release**：`git tag` 只是仓库里的一个 ref，`/releases` 页面列的是 Release 对象，
> 「Latest」也只认 Release。所以只有 tag、没 Release 的版本不会出现在 `/releases` 上
> （历史上 v1.0.6 ~ v1.0.9 是后来补建的）。这只影响页面展示，不影响 npm。
> 因为这一出要写仓库，工作流的 `contents` 权限是 `write`（npm 发布本身只需要 OIDC）。

关于版本号参数：

| 命令 | 结果 |
|---|---|
| `npm version patch` | `1.0.7` → `1.0.8` |
| `npm version minor` | `1.0.7` → `1.1.0` |
| `npm version major` | `1.0.7` → `2.0.0` |
| `npm version 1.2.3` | 直接指定 |

`npm version` 打的是**附注标签**。`--follow-tags` 只推附注标签 —— 手敲 `git tag v1.2.3` 是轻量标签，
推不上去（`git push --follow-tags` 会静默跳过），得显式 `git push origin v1.2.3`。

### 重试 / 补发

GitHub → Actions → `release` → **Run workflow**：发布默认分支 `package.json` 里的那个版本，
不做标签校验、也不会 +1。发布挂了就用这个补，别重复 `npm version`（那会白跳一个号）。

### 为什么不让 main 自动 +1

试过：每次推送都 `patch` +1，包括只改文档的提交；版本号涨得飞快，还会出现「合并了但发布失败」
留下一个空号。标签驱动下版本号由你决定、失败可以原地重试，历史也干净。
## 四、踩坑对照表

| 现象 | 原因 |
|---|---|
| `EOTP` / `This operation requires a one-time password` | 还在走 token 发布。检查两处：`permissions: id-token: write` 在不在；工作流里有没有 `NODE_AUTH_TOKEN` / `NPM_TOKEN`（**空值也算**） |
| `404 Not Found - PUT` + `ENEEDAUTH` | npm 上那条信任关系没配，或仓库 / 文件名 / 环境名对不上 |
| `npm warn Unknown ...` 之后静默用 token | 给 `actions/setup-node` 传了 `registry-url`：它会写 `_authToken=${NODE_AUTH_TOKEN}`，npm 会优先用它 |
| `This command requires a newer version of npm` | npm < 11.5.1。工作流里有 `npm install -g npm@latest`，本地跑发版则先 `npm i -g npm@latest` |
| `tag v1.2.3 与 package.json 的 1.2.2 对不上` | 工作流主动拦的：先 `npm version` 再打标签，别手工错位 |
| 发布出来的包是空壳 | 忘了 `npm run build`：`dist/`、`web/dist/` 都在 `files` 里但都不入库，必须现构建 |
| `npm ci` 报 `EUSAGE ... package.json and package-lock.json are in sync` | 锁文件过期（本地 `node_modules` 是新的所以看不出来）。本地跑 `npm install --package-lock-only`，提交 `package-lock.json` 后再触发 |
| 合并到 main 但没发版 | 本来就不会发：发版认的是 **`v*` 标签**，不是分支推送 |
| 标签推上去了但没触发 | 标签是**轻量**的（`git tag v1.2.3`）。用 `npm version` 生成附注标签，或 `git push origin v1.2.3` 显式推 |

## 五、已知的 CI 边界

- **单测没进流水线**：`tests/unit` 现在**全部用例都过**（`node --import tsx --test tests/unit/*.test.ts`，约 10 秒；用例数在涨，这里不写死数字），
  随时可以加进 `release.yml` 当门禁；目前只是还没接上。
- **`format:check` 也没门禁**：仓库里有 8 个文件没过 Prettier，`npm run lint`（oxlint）是干净的，先只卡它。
- 工作流里不跑 `prettier`，也不自动改文件 —— 发布流程只读。

## 六、GitHub Packages 镜像（可选，与 npm 发布线互不影响）

把**已经发到 npm** 的版本，原样再发一份到 GitHub Packages，于是
<https://github.com/duzhenxun/pop-agent/packages> 上会有东西（不配也完全不影响发版）。

**为什么必须另起一份而不是改 `package.json`**：GitHub Packages 要求包名是 `@OWNER/name`
（这里是 `@duzhenxun/pop-agent`），而 npm 上叫 `pop-agent`。直接在仓库里改名，等于把 npm
那条线一起改成破坏性改名。所以走的是：下载 npm 上的 tarball → 临时目录里改名字 → 发 →
临时目录删掉，**仓库里的 `package.json` 一个字不动**。

| 我做了什么 | 文件 |
|---|---|
| 本地/CI 通用的镜像脚本（支持 `--dry-run`） | `scripts/publish-gh-packages.sh` |
| 标签触发的独立流水线 | `.github/workflows/packages-mirror.yml` |

### 三种跑法

```bash
scripts/publish-gh-packages.sh --dry-run     # 只准备，打印将要发什么（不需要凭证）
scripts/publish-gh-packages.sh               # 真发 package.json 里的版本
scripts/publish-gh-packages.sh 0.1.4         # 真发指定版本
```

CI 那边**不用做任何事**：推 `v*` 标签后 `packages-mirror` 自己会跑。它先轮询 npm 等版本出现
（最多 15 分钟），再镜像过去 —— 因为 `release.yml` 要跑完 typecheck / lint / build 才 publish，
两个 job 是并行的。也可以 Actions → `packages-mirror` → Run workflow 手动补发。

本地真发需要凭证（`gh auth login` 的默认 scope **不含** packages，必须 refresh 一次）：

```bash
export GITHUB_PACKAGES_TOKEN=<classic PAT，勾 write:packages>
# 或者：gh auth refresh -h github.com -s write:packages
```

### 为什么不影响现有的 npm 发布

1. **不动 `package.json`**：npm 那边仍然发 `pop-agent`，`files` / `bin` / `prepack` 全都没变。
2. **不碰 OIDC 那条线**：Trusted Publisher 白名单绑的是 `release.yml` **这个文件名**，新增
   `packages-mirror.yml` 不改变那条信任关系；镜像 job 里也**没有** `NODE_AUTH_TOKEN` /
   `NPM_TOKEN`（变量名是 `GITHUB_PACKAGES_TOKEN`，避开 npm 的隐式读取），token 只写进临时
   目录的 `.npmrc` 里，用完即删。
3. **不重新构建**：直接发 npm 上那份 tarball，内容逐字节一致（实测两边都是 381 个文件）。
   所以必须带 `--ignore-scripts` —— tarball 里的 `prepack` 是 `npm run build`，临时目录里
   没有源码和 `node_modules`，不忽略脚本就一定失败。

### 发完要手动做两件事

1. **首次发出来的包默认是 private**，去改成 public：
   <https://github.com/users/duzhenxun/packages/npm/pop-agent/settings>
2. 装的时候必须带 scope 并指 registry（GitHub 的文档明确写了：**连公开包也要 token**）：

   ```bash
   npm install -g @duzhenxun/pop-agent --registry=https://npm.pkg.github.com
   ```

> 所以它适合当「有个页面 / 留个存档」，**不适合当面向普通用户的安装渠道** —— 那还是 npm。

### 坑

| 现象 | 原因 |
|---|---|
| `403 Forbidden` / `ENEEDAUTH` | token 没有 `write:packages`；或用了 `gh auth login` 的默认 token（不含 packages），要 `gh auth refresh -s write:packages`。CI 里则是 job 上缺 `permissions: packages: write` |
| `npm pack` 报 404 | 版本还没发到 npm。等 `release` 工作流跑完再发（脚本里已经先查了一遍是否已存在） |
| 发布时报 `prepack` 相关错误 / 想跑 tsc | 少了 `--ignore-scripts`：tarball 里带 `prepack: npm run build` |
| 包发出去了但页面还是空的 | 看的是仓库的 `/packages` 顶层页，包挂在 `github.com/users/duzhenxun/packages` 下；首次还要手动改 public |
| 用户装了之后 `pop-agent` 命令没变 | 正常：`bin` 名字没改。但**不要和 npm 那份同时全局装**，两个包的 `pop` / `pop-agent` 同名会互相覆盖 |

---

## 七、macOS 安装包怎么发（`release.yml` 不管这一段）

npm 那条线是自动的；**`.dmg` 是本地构建 + 手动上传**，`release.yml` 只负责 npm 与 Release 对象本身。
顺序：先把 npm 那版发完（Release 对象已存在），再传包：

```bash
npm run app:dist        # 产物在 release/：PopAgent-<version>-arm64.dmg + latest-mac.yml
gh release upload v0.1.8 release/PopAgent-0.1.8-arm64.dmg release/latest-mac.yml --clobber
```

### 每次都必须多传一份「稳定文件名」的副本

官网首屏的下载按钮指向的是 **固定名字**：

```
https://github.com/duzhenxun/pop-agent/releases/latest/download/PopAgent-macOS-arm64.dmg
```

`latest/download/<文件名>` 要求文件名跨版本不变，而 electron-builder 产出的名字里带版本号。
所以每次补一份副本，否则官网那个按钮 404：

```bash
cp release/PopAgent-0.1.8-arm64.dmg /tmp/PopAgent-macOS-arm64.dmg
gh release upload v0.1.8 /tmp/PopAgent-macOS-arm64.dmg --clobber
curl -s -o /dev/null -w "%{http_code} %{redirect_url}\n" \
  https://github.com/duzhenxun/pop-agent/releases/latest/download/PopAgent-macOS-arm64.dmg
# 期望 302 → .../releases/download/v0.1.8/PopAgent-macOS-arm64.dmg
```

> 只传版本名那份的后果：落地页点「下载」进 404。本文件 §四 的自查清单里已经加了这一条。

### 为什么不让 CI 把 dmg 也出了

dmg 要 macOS 签名与公证（`electron-builder.yml` 里的 entitlements + 打包时的证书），
在 GitHub 的 ubuntu runner 上出不来；macOS runner 又要付费分钟数，且签名证书得进 secrets。
现阶段一个人发版，本地 `app:dist` 更省事。
