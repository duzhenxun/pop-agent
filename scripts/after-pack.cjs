// 打包后的兜底签名（electron-builder 的 afterPack 钩子）。
//
// 背景（2026-11-24 实测）：找不到任何签名身份时，electron-builder **只警告、不签名**，
// 照样把 dmg 产出来：
//
//   skipped macOS application code signing   reason: no valid identity found
//
// 这样的 .app 拿到别的 Mac 上双击会报「**已损坏**，无法打开。你应该将它移到废纸篓」，
// 而「已损坏」用「右键 → 打开」是绕不过去的（那句只对「无法验证开发者」有效）。
// 实测那时 App 的状态是：Identifier=Electron、Info.plist 未绑定签名、
//
//   codesign --verify: code has no resources but signature indicates they must be present
//
// 这里补一个 ad-hoc 签名（`codesign --sign -`），把产物从「签名无效」变成
// 「签名有效、只是没有开发者身份」：清掉隔离标记就能开，双击的提示也从判死
// 变成「无法验证开发者」（这种系统设置里能「仍要打开」）。
//
// 为什么是 afterPack 而不是 afterSign：electron-builder 在**没发生签名**时会直接跳过
// afterSign（日志 `skipping "afterSign" hook as no signing occurred`），拿它兜底永远不会执行。
//
// 为什么不在配置里写 `forceCodeSigning: true`：它会在「找不到证书」时让整条打包链失败，
// 没有证书的机器连一个 ad-hoc 包都出不来。要那种「不给证书就不许发布」的门禁，用下面的
// POP_AGENT_REQUIRE_DEV_ID=1，效果一样但不误伤本地打包。

const { execFileSync } = require("node:child_process");
const path = require("node:path");

/**
 * electron-builder 等一下会不会自己签？
 *
 * 直接问 electron-builder 自己（调用它的 findIdentity），而不是自己猜 —— 这里有两次踩过的坑：
 *
 *   1. 「钥匙串里有证书」不等于会签。
 *   2. 「不认 Apple Development 证书」也是错的：`_findIdentity` 在找不到
 *      `Developer ID Application:` 之后会走一条「找非 Apple 官方证书」的兜底
 *      （app-builder-lib issue #458），`Apple Development: …` 正好会被它选上。
 *      实测这台机器上 findIdentity("Developer ID Application") 就返回了 Apple Development。
 *
 * 所以直接用同一个函数问；答不上来（拿不到内部模块）就当「不会签」，
 * 多签一次 ad-hoc 不会错 —— electron-builder 随后会用真身份覆盖它。
 */
async function willBeSignedByBuilder(context) {
  const options = context.packager.platformSpecificBuildOptions || {};
  // `identity: null` 是配置里明确要求「不要签」
  if (options.identity === null) return false;
  const qualifier = options.identity || process.env.CSC_NAME;
  if (!qualifier && process.env.CSC_IDENTITY_AUTO_DISCOVERY === "false") return false;

  try {
    const { findIdentity } = require("app-builder-lib/out/codeSign/macCodeSign.js");
    // 默认 target 的 type 是 distribution，electron-builder 找的就是这一种
    return (await findIdentity("Developer ID Application", qualifier, undefined)) != null;
  } catch {
    // 内部模块路径变了之类：宁可多签一次
    return false;
  }
}

exports.default = async function afterPack(context) {
  if (context.electronPlatformName !== "darwin") return;

  const appPath = path.join(
    context.appOutDir,
    `${context.packager.appInfo.productFilename}.app`,
  );
  const requireDevId = process.env.POP_AGENT_REQUIRE_DEV_ID === "1";

  if (await willBeSignedByBuilder(context)) {
    console.log("afterPack: electron-builder 稍后会自己签（找到可用身份），跳过 ad-hoc");
    return;
  }

  if (requireDevId) {
    throw new Error(
      "POP_AGENT_REQUIRE_DEV_ID=1，但钥匙串里没有可用的 Developer ID 签名身份。\n" +
        "  发版前先装证书（或用 CSC_LINK 提供 .p12），否则出来的是未公证包，别人装了会报「已损坏」。",
    );
  }

  console.log("afterPack: 没有可用签名身份 → 补一个 ad-hoc 签名（产物仅供本机/内测）");
  // 刻意不带 `--options runtime`：ad-hoc 签名下的 hardened runtime 会把 TCC 的麦克风授权
  // 变成静默拒绝（entitlements 里那条 audio-input 也要配合真实证书才有意义）。
  // 本机自用不需要它；真配了 Developer ID 时 electron-builder 会在这一步之后重签。
  execFileSync("/usr/bin/codesign", ["--force", "--deep", "--sign", "-", appPath], {
    stdio: "inherit",
  });

  // 签完立刻验一次：签失败但构建“成功”正是当初发出坏包的路径
  execFileSync("/usr/bin/codesign", ["--verify", "--deep", "--strict", appPath], {
    stdio: "inherit",
  });

  console.warn(
    [
      "",
      "注意：这个包是 ad-hoc 签名（没有 Apple 开发者身份），不能直接分发：",
      "  · 别人下载后双击可能提示「已损坏」→ 需要跑一次：",
      `      codesign --force --deep --sign - "${appPath.replace(context.appOutDir, "<安装位置>")}"`,
      `      xattr -dr com.apple.quarantine "<安装位置>/PopAgent.app"`,
      "  · 要免这一步，必须有 Developer ID Application 证书 + 公证（notarytool）。",
      "",
    ].join("\n"),
  );
};
