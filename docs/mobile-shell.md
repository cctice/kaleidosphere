# 移动端壳（第一步：iOS 快捷指令壳）

> 维护心跳包·九轮：`ks route` 的单短命令形态早已为快捷键/移动端壳复用同一入口留了锚，
> 但壳本体零进展。本页落纸第一步——不写原生 App，用 iOS 快捷指令（Shortcuts）+
> 「Run script over SSH」直接复用 route 入口，移动端"下一块玻璃转哪儿"一条指令可达。

## 前置

- iPhone 安装 Shortcuts（系统自带）。
- Mac 与手机同一 Tailscale 网络（本仓生态既有信任模型：oneoffice 网关同样跑在 Tailscale 上）。
- Mac 开启远程登录（系统设置 → 通用 → 共享 → 远程登录）。
- `ks` 可执行：`node /path/to/kaleidosphere/cli/ks.js`（可先 `npm link` 或做个别名脚本）。

## 壳配方（跟着做，5 步）

1. 新建快捷指令，添加动作 **Run Script Over SSH**。
2. 填主机（Mac 的 Tailscale 主机名或 IP）、用户、认证方式（密码或密钥）。
3. 脚本一行：

   ```sh
   node /path/to/kaleidosphere/cli/ks.js route --shell
   ```

4. 添加动作 **Show Result**（或 **Quick Look**）：上一步输出即 `项目名<TAB>项目路径` 单行，
   副作用与桌面端 `ks route` 完全同源——转动记录照常落 `state/rotation.json`，
   桌面端的 ks status 停转提醒看得见移动端转过的那一轮。
5. 建议再加一个快捷指令（灵感捕获反向通道）：

   ```sh
   node /path/to/kaleidosphere/cli/ks.js spark capture --source im --title "$(Ask for Input)" --text "$(Ask for Input)" --json
   ```

   手机上想到的事一条指令进 spark 库，回桌面 `ks spark list` 可见（source: im 回溯）。

## 为什么这是"同一入口"而不是平行系统

- `--shell` 只是输出形态（单行 `name<TAB>path`，机器可读），选择算法、rotation 状态、
  withStateLock 并发保护全部与桌面 route 共用——移动端转一轮，桌面端状态同步前进。
- 快捷指令可绑到锁屏/操作按钮（Action Button）：长按即得"下一块玻璃"。

## 边界（如实）

- 本页是壳的第一步（快捷指令形态），不是原生 App：离线、通知、widget 是后续题。
- SSH 出网依赖 Tailscale 在场；Tailscale 不在则快捷指令如实失败（不假绿）。
